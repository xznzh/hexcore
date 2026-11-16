/**
 * 用量 / 调度 / 单点只读域的迁移接线测试。
 *
 * 直接 import 真实 route 模块，只 mock I/O 边界。这一批的特点是
 * **绝大多数是只读接口，但几乎每个都带「谁能看谁的数据」的分支**：
 * usage 的管理员全量 vs 成员自身、schedules 的归属校验、shares 的 owner 校验。
 * 这些分支在迁移中最容易被改写成「有 session 就放行」——状态码不变、数据范围变大，
 * typecheck 与截图都看不出来。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let dbRows: any[] = [];
function makeDb() {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    groupBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    insert: () => chain,
    values: () => chain,
    update: () => chain,
    set: () => chain,
    delete: () => chain,
    returning: () => Promise.resolve(dbRows),
    leftJoin: () => chain,
    innerJoin: () => chain,
    execute: () => Promise.resolve(dbRows),
    $count: () => Promise.resolve(dbRows.length),
    catch: (fn: any) => Promise.resolve(dbRows).catch(fn),
    finally: (fn: any) => Promise.resolve(dbRows).finally(fn),
    then: (resolve: any, reject: any) => Promise.resolve(dbRows).then(resolve, reject),
  };
  return chain;
}
const dbMock = makeDb();

vi.mock('@/lib/db', () => ({
  ensureInit: vi.fn(async () => undefined),
  isVectorSupported: () => false,
  get db() {
    return dbMock;
  },
}));
vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(async () => true),
  hashPassword: vi.fn(async () => 'hashed'),
  signToken: vi.fn(() => 'token'),
  setAuthCookie: vi.fn(async () => undefined),
  invalidateUserState: vi.fn(),
}));
vi.mock('@/lib/util', () => ({
  newId: (p: string) => `${p}_test`,
  logAction: vi.fn(async () => undefined),
  periodNow: () => '2026-11',
}));
vi.mock('@/lib/projects', () => ({
  accessibleProjectIds: vi.fn(async () => new Set<string>()),
  canAccessProject: vi.fn(async () => true),
}));
vi.mock('@/lib/scheduler', () => ({
  startScheduler: vi.fn(),
  runSchedule: vi.fn(async () => 'done'),
}));
vi.mock('@/lib/cache', () => ({ cacheStats: vi.fn(async () => ({ hits: 0, misses: 0 })) }));
vi.mock('@/lib/settings', () => ({ isBriefEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/llm', () => ({ resolveModelWithFallback: vi.fn(async () => null) }));
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: '[]' })) }));
vi.mock('@/lib/mcp/client', () => ({ McpClient: class {} }));
vi.mock('@/lib/tools/mcp-tools', () => ({
  inspectMcp: vi.fn(async () => ({ tools: [], serverInfo: null, protocolVersion: '1' })),
  clearMcpCache: vi.fn(),
  mcpToolKey: (a: string, b: string) => `${a}__${b}`,
}));
vi.mock('@/lib/crypto', () => ({
  decryptJson: (v: any) => {
    try {
      return JSON.parse(String(v).replace(/^enc:/, ''));
    } catch {
      return {};
    }
  },
}));

import { getSession, verifyPassword } from '@/lib/auth';
import { logAction } from '@/lib/util';
import * as usageRoute from '@/app/api/usage/route';
import * as usageOverview from '@/app/api/usage/overview/route';
import * as usageTrend from '@/app/api/usage/trend/route';
import * as schedules from '@/app/api/schedules/route';
import * as scheduleRun from '@/app/api/schedules/run/route';
import * as scheduleRuns from '@/app/api/schedules/runs/route';
import * as usersRoute from '@/app/api/users/route';
import * as settingsRoute from '@/app/api/settings/route';
import * as searchRoute from '@/app/api/search/route';
import * as modelsRoute from '@/app/api/models/route';
import * as logsRoute from '@/app/api/logs/route';
import * as feedbackRoute from '@/app/api/feedback/route';
import * as sharesRoute from '@/app/api/shares/route';
import * as briefRoute from '@/app/api/brief/route';
import * as workbenchRoute from '@/app/api/workbench/route';
import * as mcpRoute from '@/app/api/mcp/route';

const BASE = 'http://localhost:3111';
const req = (path: string, method = 'GET', body?: unknown) =>
  new NextRequest(new URL(BASE + path), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const member = { userId: 'u1', email: 'm@x.com', role: 'member', name: 'm' } as any;
const admin = { userId: 'u2', email: 'a@x.com', role: 'admin', name: 'a' } as any;
const guest = { userId: 'u3', email: 'g@x.com', role: 'guest', name: 'g' } as any;

type Entry = { name: string; call: () => Promise<Response>; guestBlocked?: boolean; adminOnly?: boolean };

const ENTRIES: Entry[] = [
  { name: 'usage GET', call: () => usageRoute.GET(req('/api/usage')) },
  { name: 'usage/overview GET', call: () => usageOverview.GET(req('/api/usage/overview')) },
  { name: 'usage/trend GET', call: () => usageTrend.GET(req('/api/usage/trend')) },
  { name: 'schedules GET', call: () => schedules.GET(req('/api/schedules')) },
  { name: 'schedules POST', guestBlocked: true, call: () => schedules.POST(req('/api/schedules', 'POST', {})) },
  { name: 'schedules PATCH', guestBlocked: true, call: () => schedules.PATCH(req('/api/schedules', 'PATCH', {})) },
  { name: 'schedules DELETE', guestBlocked: true, call: () => schedules.DELETE(req('/api/schedules?id=x1', 'DELETE')) },
  { name: 'schedules/run POST', guestBlocked: true, call: () => scheduleRun.POST(req('/api/schedules/run', 'POST', {})) },
  { name: 'schedules/runs GET', call: () => scheduleRuns.GET(req('/api/schedules/runs?id=x1')) },
  { name: 'users GET', call: () => usersRoute.GET(req('/api/users')) },
  { name: 'settings GET', call: () => settingsRoute.GET(req('/api/settings')) },
  { name: 'settings PATCH', call: () => settingsRoute.PATCH(req('/api/settings', 'PATCH', {})) },
  { name: 'search GET', call: () => searchRoute.GET(req('/api/search?q=x')) },
  { name: 'models GET', call: () => modelsRoute.GET(req('/api/models')) },
  { name: 'logs GET', adminOnly: true, call: () => logsRoute.GET(req('/api/logs')) },
  { name: 'feedback POST', call: () => feedbackRoute.POST(req('/api/feedback', 'POST', {})) },
  { name: 'shares GET', call: () => sharesRoute.GET(req('/api/shares')) },
  { name: 'shares DELETE', call: () => sharesRoute.DELETE(req('/api/shares?id=x1', 'DELETE')) },
  { name: 'brief GET', call: () => briefRoute.GET(req('/api/brief')) },
  { name: 'brief POST', call: () => briefRoute.POST(req('/api/brief', 'POST')) },
  { name: 'workbench GET', call: () => workbenchRoute.GET(req('/api/workbench')) },
  { name: 'mcp POST', guestBlocked: true, call: () => mcpRoute.POST(req('/api/mcp', 'POST', {})) },
];

describe(`用量/调度/单点域路由接线（${ENTRIES.length} 个入口）`, () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(verifyPassword).mockResolvedValue(true);
    dbRows = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  for (const e of ENTRIES) {
    it(`${e.name}：未登录 401`, async () => {
      vi.mocked(getSession).mockResolvedValue(null);
      const r = await e.call();
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.traceId).toBeTruthy();
    });
  }

  for (const e of ENTRIES.filter((x) => x.guestBlocked)) {
    it(`${e.name}：访客 403（只读）`, async () => {
      vi.mocked(getSession).mockResolvedValue(guest);
      const r = await e.call();
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe('FORBIDDEN');
    });
  }

  for (const e of ENTRIES.filter((x) => x.adminOnly)) {
    it(`${e.name}：普通成员 403（需管理员）`, async () => {
      vi.mocked(getSession).mockResolvedValue(member);
      const r = await e.call();
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe('FORBIDDEN');
    });
  }

  // —— 归属与数据范围：状态码不变但「能看到谁的数据」变了，最需要盯 ——

  it('usage GET 成员只返回自己一行（不是全团队）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ tokensUsed: 5, email: 'm@x.com', name: 'm', monthlyLimit: 100 }];
    const r = await usageRoute.GET(req('/api/usage'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].userId).toBe('u1');
  });

  it('schedules POST 非法 cron → 400 INVALID_CRON（不是放行后静默失效）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await schedules.POST(req('/api/schedules', 'POST', { name: 't', cron: 'not-a-cron' }));
    const body = await r.json();
    expect(r.status).toBe(400);
    expect(body.code).toBe('INVALID_CRON');
  });

  it('schedules PATCH 改他人任务 → 403', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'other', cron: '0 9 * * *' }];
    const r = await schedules.PATCH(req('/api/schedules', 'PATCH', { id: 'x1', enabled: false }));
    expect(r.status).toBe(403);
  });

  it('schedules PATCH 管理员改他人任务 → 200', async () => {
    vi.mocked(getSession).mockResolvedValue(admin);
    dbRows = [{ id: 'x1', ownerId: 'other', cron: '0 9 * * *' }];
    const r = await schedules.PATCH(req('/api/schedules', 'PATCH', { id: 'x1', enabled: false }));
    expect(r.status).toBe(200);
  });

  it('schedules/run 触发他人任务 → 403（防越权盗刷额度）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'other', name: 'n' }];
    const r = await scheduleRun.POST(req('/api/schedules/run', 'POST', { id: 'x1' }));
    expect(r.status).toBe(403);
  });

  it('schedules/runs 读他人私有任务历史 → 403', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'other', scope: 'personal', projectId: null }];
    const r = await scheduleRuns.GET(req('/api/schedules/runs?id=x1'));
    expect(r.status).toBe(403);
  });

  it('schedules/runs 读团队任务历史 → 200（团队可见）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'other', scope: 'team', projectId: null }];
    const r = await scheduleRuns.GET(req('/api/schedules/runs?id=x1'));
    expect(r.status).toBe(200);
  });

  it('settings PATCH 当前密码错 → 403 且 code 为 WRONG_PASSWORD（区别于「无权」）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'u1', email: 'm@x.com', name: 'm', role: 'member', passwordHash: 'h' }];
    vi.mocked(verifyPassword).mockResolvedValue(false);
    const r = await settingsRoute.PATCH(
      req('/api/settings', 'PATCH', { currentPassword: 'bad', newPassword: '123456' }),
    );
    const body = await r.json();
    expect(r.status).toBe(403);
    expect(body.code).toBe('WRONG_PASSWORD');
  });

  it('settings PATCH 没有任何可更新字段 → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'u1', passwordHash: 'h' }];
    const r = await settingsRoute.PATCH(req('/api/settings', 'PATCH', {}));
    expect(r.status).toBe(400);
  });

  it('settings GET 用户已不存在 → 404', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [];
    const r = await settingsRoute.GET(req('/api/settings'));
    expect(r.status).toBe(404);
  });

  it('feedback 空内容 → 400（不写空审计）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    vi.mocked(logAction).mockClear();
    const r = await feedbackRoute.POST(req('/api/feedback', 'POST', { text: '   ' }));
    expect(r.status).toBe(400);
    expect(vi.mocked(logAction)).not.toHaveBeenCalled();
  });

  it('shares DELETE 撤销他人分享 → 403', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'other' }];
    const r = await sharesRoute.DELETE(req('/api/shares?id=x1', 'DELETE'));
    expect(r.status).toBe(403);
  });

  it('search 空查询直接返回空结果，不打库', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await searchRoute.GET(req('/api/search?q='));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it('usage/trend days 超上限被夹到 90', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await usageTrend.GET(req('/api/usage/trend?days=9999'));
    expect((await r.json()).days).toBe(90);
  });

  it('brief POST 今日重生成超限 → 429', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'b1', items: '[]', modelUsed: 'ai#regen2' }];
    const r = await briefRoute.POST(req('/api/brief', 'POST'));
    const body = await r.json();
    expect(r.status).toBe(429);
    expect(body.code).toBe('REGEN_LIMIT');
  });

  it('workbench 保留 Server-Timing 响应头', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await workbenchRoute.GET(req('/api/workbench'));
    expect(r.status).toBe(200);
    expect(r.headers.get('Server-Timing')).toMatch(/db;dur=/);
  });

  it('mcp 缺 connectorId → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await mcpRoute.POST(req('/api/mcp', 'POST', {}));
    expect(r.status).toBe(400);
  });

  it('mcp 连接器不存在 → 404', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [];
    const r = await mcpRoute.POST(req('/api/mcp', 'POST', { connectorId: 'c1' }));
    expect(r.status).toBe(404);
  });

  it('mcp 非 MCP 类型连接器 → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'c1', name: 'n', type: 'http', config: '{}', visibleRoles: '[]' }];
    const r = await mcpRoute.POST(req('/api/mcp', 'POST', { connectorId: 'c1' }));
    expect((await r.json()).code).toBe('INVALID_ARGUMENT');
  });

  it('未知异常统一 500，且响应体不泄露内部原文', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const boom = vi.spyOn(dbMock, 'select').mockImplementationOnce(() => {
      throw new Error('relation "usage_secret" does not exist');
    });
    const r = await usersRoute.GET(req('/api/users'));
    const body = await r.json();
    expect(r.status).toBe(500);
    expect(body.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('usage_secret');
    boom.mockRestore();
  });
});
