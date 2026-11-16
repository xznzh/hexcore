/**
 * 审批通过之后的那一步（V8.5）。
 *
 * 这是最容易「看着对、实际没执行」的一段：审批页显示成功、操作记录变成 succeeded，
 * 但工具压根没被调用——因为分流条件写错会静默回落到注册表分支，返回「未注册的工具」。
 * 所以这里断言的不是状态码，而是**参数有没有原样到达执行器**。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const updates: any[] = [];
let selectQueue: any[][] = [];

const selectChain: any = {
  from: () => selectChain,
  where: () => selectChain,
  limit: () => Promise.resolve(selectQueue.shift() ?? []),
};
const dbMock = {
  select: () => selectChain,
  update: () => ({
    set: (v: any) => {
      updates.push(v);
      return { where: () => Promise.resolve(undefined) };
    },
  }),
  insert: () => ({ values: () => Promise.resolve(undefined) }),
};

vi.mock('@/lib/db', () => ({
  ensureInit: vi.fn(async () => undefined),
  isVectorSupported: () => false,
  get db() {
    return dbMock;
  },
}));
vi.mock('@/lib/util', () => ({
  newId: (p: string) => `${p}_test`,
  logAction: vi.fn(async () => undefined),
}));
vi.mock('@/lib/tools/mcp-tools', () => ({
  executeMcpTool: vi.fn(async () => ({ ok: true, text: '远端结果', durationMs: 7 })),
}));

import { decideApproval } from '@/lib/capabilities';
import { executeMcpTool } from '@/lib/tools/mcp-tools';

const admin = { userId: 'admin1', role: 'admin' };

function opRow(over: Record<string, any> = {}) {
  return {
    id: 'op_1',
    capabilityId: null,
    connectorId: 'conn1',
    userId: 'u1',
    status: 'pending_approval',
    input: JSON.stringify({
      tool: 'mcp__demo__create_issue',
      args: { title: '服务挂了', priority: 'P0' },
      mcp: { connectorId: 'conn1', toolName: 'create_issue' },
    }),
    source: 'chat',
    conversationId: 'conv1',
    ...over,
  };
}

describe('decideApproval：MCP 待审批操作的补执行', () => {
  beforeEach(() => {
    updates.length = 0;
    vi.mocked(executeMcpTool).mockClear();
    selectQueue = [[opRow()], [{ id: 'u1', role: 'member' }]];
  });

  it('按审批时保存的参数调用远端（连接器 id + 原始工具名，不是命名空间键）', async () => {
    const r = await decideApproval('op_1', admin, true);

    expect(vi.mocked(executeMcpTool)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeMcpTool).mock.calls[0]).toEqual([
      'conn1',
      'create_issue',
      { title: '服务挂了', priority: 'P0' },
      { userId: 'u1', source: 'chat' },
    ]);
    expect(r).toMatchObject({ status: 'succeeded', operationId: 'op_1', output: '远端结果' });
    // 先 approved，再 succeeded：中间态要落库，否则审批页会显示「待审批」到执行结束
    const statuses = updates.map((u) => u.status).filter(Boolean);
    expect(statuses).toEqual(['approved', 'succeeded']);
  });

  it('远端失败：错误原文要带回去，不能压成「执行失败」', async () => {
    vi.mocked(executeMcpTool).mockResolvedValueOnce({
      ok: false,
      text: 'MCP 工具调用失败：连接超时',
      durationMs: 3,
    });
    const r = await decideApproval('op_1', admin, true);
    expect(r).toMatchObject({ status: 'failed' });
    expect((r as any).error).toContain('连接超时');
    expect(updates.at(-1)?.error).toContain('连接超时');
  });

  it('非管理员调用 decideApproval 直接返回 null（审批权不靠界面藏按钮）', async () => {
    const r = await decideApproval('op_1', { userId: 'u1', role: 'member' }, true);
    expect(r).toBeNull();
    expect(vi.mocked(executeMcpTool)).not.toHaveBeenCalled();
  });

  it('已处理过的操作不再执行（重复点审批按钮不会跑两遍）', async () => {
    selectQueue = [[opRow({ status: 'succeeded' })], [{ id: 'u1', role: 'member' }]];
    const r = await decideApproval('op_1', admin, true);
    expect(r).toBeNull();
    expect(vi.mocked(executeMcpTool)).not.toHaveBeenCalled();
  });
});
