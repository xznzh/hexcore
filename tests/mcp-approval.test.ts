/**
 * MCP 工具审批闸（V8.5）。
 *
 * 这里守的是三件事，任何一条失守都意味着「审批形同虚设」：
 *  1. 判定：写语义 / 认不出来的工具必须走审批，读语义才放行；
 *  2. 拦截：该审批的调用**不能真的连到远端**（返回审批提示 ≠ 执行）；
 *  3. 落地：待审批记录里必须带够「审批后能按原参数执行」的信息。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const inserted: any[] = [];
let rows: any[] = [];
const selectChain: any = {
  from: () => selectChain,
  where: () => selectChain,
  limit: () => Promise.resolve(rows),
  then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
  catch: (fn: any) => Promise.resolve(rows).catch(fn),
  finally: (fn: any) => Promise.resolve(rows).finally(fn),
};
const dbMock = {
  select: () => selectChain,
  insert: () => ({
    values: (v: any) => {
      inserted.push(v);
      return Promise.resolve(undefined);
    },
  }),
};

vi.mock('@/lib/db', () => ({
  ensureInit: vi.fn(async () => undefined),
  isVectorSupported: () => false,
  get db() {
    return dbMock;
  },
}));
vi.mock('@/lib/schema', async () => {
  // 表对象必须是真的 drizzle 表（eq(col, val) 需要列元数据）；这里用最小 stub 会炸，
  // 所以直接透传真实 schema——它只定义表结构，不建连接。
  return await vi.importActual<any>('@/lib/schema');
});
vi.mock('@/lib/crypto', () => ({
  decryptJson: (s: string) => JSON.parse(s || '{}'),
  encryptJson: (v: any) => JSON.stringify(v),
}));
vi.mock('@/lib/util', () => ({
  newId: (p: string) => `${p}_test${inserted.length + 1}`,
  logAction: vi.fn(async () => undefined),
  withTimeout: <T,>(p: Promise<T>, ms: number, label: string) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
      p.then((v) => {
        clearTimeout(t);
        resolve(v);
      }, (e) => {
        clearTimeout(t);
        reject(e);
      });
    }),
}));

/** 远端替身：记录真实发生的调用，用来断言「该审批的没连出去」 */
const calls: { tool: string; args: any }[] = [];
vi.mock('@/lib/mcp/client', () => ({
  McpClient: class {
    serverInfo = { name: 'demo', version: '1' };
    protocolVersion = '2024-11-05';
    constructor(public opts: any) {}
    async initialize() {}
    async listTools() {
      return rows[0]?.__tools || [];
    }
    async callTool(tool: string, args: any) {
      calls.push({ tool, args });
      return { text: `${tool} 的执行结果`, isError: false };
    }
  },
}));

import {
  mcpToolNeedsApproval,
  normalizeMcpApproval,
  requestMcpApproval,
} from '@/lib/mcp/approval';
import { clearMcpCache, mcpChatTools, mcpToolKey } from '@/lib/tools/mcp-tools';

function connectorRow(over: Record<string, any> = {}) {
  return {
    id: 'conn1',
    name: 'demo',
    type: 'mcp',
    config: JSON.stringify({ url: 'https://mcp.example.com/rpc' }),
    enabled: true,
    status: 'active',
    visibleRoles: '["admin","member"]',
    mcpApproval: 'auto',
    __tools: [
      { name: 'get_weather', description: '查天气', inputSchema: { type: 'object' } },
      { name: 'create_issue', description: '提 issue', inputSchema: { type: 'object' } },
    ],
    ...over,
  };
}

const ctx = (role = 'member') => ({ userId: 'u1', role, source: 'chat' as const });

describe('MCP 审批策略判定', () => {
  it('auto：读语义放行', () => {
    for (const n of ['get_weather', 'list_files', 'search_docs', 'query_db', 'read_file']) {
      expect(mcpToolNeedsApproval('auto', n, 'member'), n).toBe(false);
    }
  });

  it('auto：写语义审批（含复合名——只做前缀判断会被 get_or_create 骗过）', () => {
    for (const n of ['create_issue', 'write_file', 'get_or_create_user', 'search_and_delete', 'deleteUser', 'run_sql']) {
      expect(mcpToolNeedsApproval('auto', n, 'member'), n).toBe(true);
    }
  });

  it('auto：认不出来的工具按 fail-closed 审批', () => {
    // 工具名是第三方起的，猜错一个词的代价是「多一次点击」，
    // 猜反的代价是「静默执行了一次写操作」——所以未知一律审批。
    for (const n of ['zigzag', 'analyze', 'do_it', '']) {
      expect(mcpToolNeedsApproval('auto', n, 'member'), n).toBe(true);
    }
  });

  it('auto：管理员豁免（与注册表 requiresApproval 语义一致）', () => {
    expect(mcpToolNeedsApproval('auto', 'create_issue', 'admin')).toBe(false);
  });

  it('always：连管理员也要审批（给高危连接器用）', () => {
    expect(mcpToolNeedsApproval('always', 'get_weather', 'member')).toBe(true);
    expect(mcpToolNeedsApproval('always', 'get_weather', 'admin')).toBe(true);
  });

  it('never：一律放行（管理员确认该服务无副作用时）', () => {
    expect(mcpToolNeedsApproval('never', 'drop_database', 'member')).toBe(false);
  });

  it('策略值非法 / 大小写混乱时回落到 auto，而不是回落到 never', () => {
    expect(normalizeMcpApproval('ALWAYS')).toBe('always');
    expect(normalizeMcpApproval('nonsense')).toBe('auto');
    expect(normalizeMcpApproval(undefined)).toBe('auto');
    expect(normalizeMcpApproval('never')).toBe('never');
  });
});

describe('MCP 工具装配后的审批拦截', () => {
  beforeEach(() => {
    inserted.length = 0;
    calls.length = 0;
    rows = [connectorRow()];
    clearMcpCache();
  });

  it('写语义工具：返回审批提示，且**不发起远端调用**', async () => {
    const tools = await mcpChatTools(ctx());
    const t = tools[mcpToolKey('demo', 'create_issue')];
    expect(t).toBeTruthy();

    const out = String(await t.execute({ title: '服务挂了' }));

    expect(out).toContain('需要管理员审批');
    expect(calls).toHaveLength(0); // 关键：提示语不等于执行
    expect(inserted).toHaveLength(1);
    const stored = JSON.parse(inserted[0].input);
    expect(inserted[0].status).toBe('pending_approval');
    expect(inserted[0].connectorId).toBe('conn1');
    expect(stored.mcp).toEqual({ connectorId: 'conn1', toolName: 'create_issue' });
    // 审批后要按原参数执行，参数必须原样保存
    expect(stored.args).toEqual({ title: '服务挂了' });
  });

  it('读语义工具：不落审批，直接执行并定界返回', async () => {
    const tools = await mcpChatTools(ctx());
    const out = String(await tools[mcpToolKey('demo', 'get_weather')].execute({ city: '北京' }));

    expect(calls).toEqual([{ tool: 'get_weather', args: { city: '北京' } }]);
    expect(inserted).toHaveLength(0);
    // 外部内容必须定界（防间接注入），与 V8.3 R3 的口径一致
    expect(out).toContain('untrusted_data');
    expect(out).toContain('get_weather 的执行结果');
  });

  it('连接器设 always 时，读语义工具也要审批', async () => {
    rows = [connectorRow({ mcpApproval: 'always' })];
    clearMcpCache();
    const tools = await mcpChatTools(ctx('admin'));
    await tools[mcpToolKey('demo', 'get_weather')].execute({ city: '北京' });
    expect(calls).toHaveLength(0);
    expect(inserted).toHaveLength(1);
  });

  it('连接器停用后即使审批通过也不执行（审批可能在几分钟后才到）', async () => {
    rows = [connectorRow({ enabled: false })];
    clearMcpCache();
    const tools = await mcpChatTools(ctx('admin'));
    const out = String(await tools[mcpToolKey('demo', 'get_weather')].execute({}));
    expect(out).toContain('已停用');
    expect(calls).toHaveLength(0);
  });
});

describe('requestMcpApproval 的入参上限', () => {
  beforeEach(() => {
    inserted.length = 0;
  });

  const base = {
    toolKey: 'mcp__demo__create_issue',
    toolName: 'create_issue',
    connectorId: 'conn1',
    connectorName: 'demo',
    userId: 'u1',
    role: 'member',
  };

  it('超长入参不落库，也不返回操作编号（避免审批后执行一份被截断的参数）', async () => {
    const r = await requestMcpApproval({ ...base, args: { body: 'x'.repeat(17000) } });
    expect(r.operationId).toBe('');
    expect(r.message).toContain('入参过大');
    expect(inserted).toHaveLength(0);
  });

  it('正常入参落库并给出操作编号', async () => {
    const r = await requestMcpApproval({ ...base, args: { title: 't' } });
    expect(r.operationId).toBeTruthy();
    expect(r.message).toContain(r.operationId);
    expect(inserted).toHaveLength(1);
  });
});
