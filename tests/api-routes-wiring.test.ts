/**
 * 治理域（admin/*）迁移接线测试。
 *
 * 为什么需要它：`pnpm typecheck` 只能证明「类型对」，证明不了「路由被正确包进 withApi
 * 且 handler 体仍然跑得通」。而这次迁移动的恰恰是每个路由的入口形状——
 * 把 `export async function GET(req) {...}` 换成 `export const GET = withApi(...)`，
 * 一旦包错（漏 auth、handler 收到错的 ctx、body 少字段），类型检查不一定报错。
 *
 * 这里直接 import **真实的 route 模块**，只 mock 掉会话与数据源，
 * 于是测的是「路由文件本身的接线」，而不是复制一份假实现。
 *
 * 文件后半段是内容域（conversations / memories / projects）的**入口保护**测试：
 * 只断言「未登录 401 + 带 code/traceId」，不做深层数据 mock——那些 handler 一个请求里
 * 要发 4~6 次不同查询，用共享替身去喂容易变成「测 mock 而不是测代码」，
 * 而鉴权一旦被误删是**静默的安全降级**，恰恰最该用 CI 守住。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/** 可链式调用、可 await 的极简 drizzle 替身；结果由 dbRows 决定，便于每个用例造数 */
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
    // 参数化路由与联表查询也要能走通，否则内容域模块 import 后调一次就炸
    leftJoin: () => chain,
    innerJoin: () => chain,
    // 原生 SQL 路由（如 admin/quality 的 GROUP BY 明细）走这里；rowsOf 直接吃数组
    execute: () => Promise.resolve(dbRows),
    // `db.$count(table)` 的替身（分页接口用它取总数）
    $count: () => Promise.resolve(dbRows.length),
    // drizzle 的查询构造器是 thenable，`await db.select().from()` 靠这个走通；
    // 必须读 dbRows 而不是闭包快照，否则用例中途改数不生效
    then: (resolve: any, reject: any) => Promise.resolve(dbRows).then(resolve, reject),
  };
  return chain;
}

const dbMock = makeDb();
vi.mock('@/lib/db', () => ({
  ensureInit: vi.fn(async () => undefined),
  get db() {
    return dbMock;
  },
}));
vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  hashPassword: vi.fn(async (p: string) => `hash:${p}`),
  invalidateUserState: vi.fn(),
}));
vi.mock('@/lib/util', () => ({
  newId: (p: string) => `${p}_test`,
  logAction: vi.fn(async () => undefined),
}));
vi.mock('@/lib/settings', () => ({
  getSetting: vi.fn(async () => 'invite'),
  setSetting: vi.fn(async () => undefined),
  getRegisterMode: vi.fn(async () => 'invite'),
}));
vi.mock('@/lib/observability', () => ({
  runRagEval: vi.fn(async () => ({ recallAtK: 1, cases: [] })),
  runJudge: vi.fn(async () => ({ score: 9, reason: 'ok' })),
}));
vi.mock('@/lib/projects', () => ({
  accessibleProjectIds: vi.fn(async () => new Set<string>()),
  canAccessProject: vi.fn(async () => true),
}));
vi.mock('@/lib/ai/embed', () => ({
  embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
  cosine: () => 0,
}));

import { getSession } from '@/lib/auth';
import * as cost from '@/app/api/admin/cost/route';
import * as evalRoute from '@/app/api/admin/eval/route';
import * as invites from '@/app/api/admin/invites/route';
import * as judge from '@/app/api/admin/judge/route';
import * as models from '@/app/api/admin/models/route';
import * as modelsTest from '@/app/api/admin/models/test/route';
import * as quality from '@/app/api/admin/quality/route';
import * as qualityCheck from '@/app/api/admin/quality/check/route';
import * as settings from '@/app/api/admin/settings/route';
import * as users from '@/app/api/admin/users/route';
import * as conversations from '@/app/api/conversations/route';
import * as logs from '@/app/api/logs/route';
import * as conversationById from '@/app/api/conversations/[id]/route';
import * as conversationShare from '@/app/api/conversations/[id]/share/route';
import * as memories from '@/app/api/memories/route';
import * as projects from '@/app/api/projects/route';
import * as projectById from '@/app/api/projects/[id]/route';
import * as projectMembers from '@/app/api/projects/[id]/members/route';

const BASE = 'http://localhost:3111';
const req = (path: string, method = 'GET', body?: unknown) =>
  new NextRequest(new URL(BASE + path), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const member = { userId: 'u1', email: 'm@x.com', role: 'member', name: 'm' };
const admin = { userId: 'u2', email: 'a@x.com', role: 'admin', name: 'a' };

/** 9 个治理域入口，连同它们的调用方式 */
const ENTRIES: { name: string; call: (r: NextRequest) => Promise<Response>; path: string; method: string }[] = [
  { name: 'admin/cost', call: (r) => cost.GET(r), path: '/api/admin/cost', method: 'GET' },
  { name: 'admin/eval', call: (r) => evalRoute.GET(r), path: '/api/admin/eval', method: 'GET' },
  { name: 'admin/invites', call: (r) => invites.GET(r), path: '/api/admin/invites', method: 'GET' },
  { name: 'admin/models', call: (r) => models.GET(r), path: '/api/admin/models', method: 'GET' },
  { name: 'admin/quality', call: (r) => quality.GET(r), path: '/api/admin/quality', method: 'GET' },
  { name: 'admin/quality/check', call: (r) => qualityCheck.POST(r), path: '/api/admin/quality/check', method: 'POST' },
  { name: 'admin/settings', call: (r) => settings.GET(r), path: '/api/admin/settings', method: 'GET' },
  { name: 'admin/users', call: (r) => users.GET(r), path: '/api/admin/users', method: 'GET' },
  // V8.10：操作日志是管理员可见的全平台流水，此前不在矩阵里（鉴权被误删会静默泄露审计数据）
  { name: 'logs', call: (r) => logs.GET(r), path: '/api/logs', method: 'GET' },
  { name: 'admin/judge', call: (r) => judge.POST(r), path: '/api/admin/judge', method: 'POST' },
  { name: 'admin/models/test', call: (r) => modelsTest.POST(r), path: '/api/admin/models/test', method: 'POST' },
];

describe('治理域路由接线（11 个入口）', () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  for (const e of ENTRIES) {
    it(`${e.name}：未登录 401`, async () => {
      vi.mocked(getSession).mockResolvedValue(null);
      const r = await e.call(req(e.path, e.method, e.method === 'POST' ? {} : undefined));
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.traceId).toBeTruthy();
    });

    it(`${e.name}：普通成员 403`, async () => {
      vi.mocked(getSession).mockResolvedValue(member as any);
      const r = await e.call(req(e.path, e.method, e.method === 'POST' ? {} : undefined));
      expect(r.status).toBe(403);
    });
  }
});

describe('治理域管理员鉴权通过后的成功响应', () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(admin as any);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('admin/settings 返回注册方式与简报开关', async () => {
    const r = await settings.GET(req('/api/admin/settings'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ registerMode: 'invite', briefEnabled: true });
  });

  it('admin/eval 返回评测结果并附带示例用例提示', async () => {
    const r = await evalRoute.GET(req('/api/admin/eval'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.recallAtK).toBe(1);
    expect(String(body.note)).toContain('示例用例');
  });

  it('admin/quality 返回聚合结果，并显式带上 unparsed / truncated', async () => {
    // V8.7：这两个字段是「统计可信度」的载体——没有它们，
    // 「解析全失败」和「真的没问题」在响应里长得一模一样。
    const now = Date.now();
    dbRows = [
      { action: 'eval_runtime', target: 'fail', status: 'error', detail: '[trace:t1] channel · skill/周报 · block:empty_answer(空)', created_at: now - 1000 },
      { action: 'eval_runtime', target: 'pass_with_warn', status: 'warn', detail: 'channel · schedule/日报 · warn:template_placeholder(x)', created_at: now - 2000 },
      { action: 'eval_runtime', target: 'fail', status: 'error', detail: '格式变了', created_at: now - 3000 },
    ];
    const r = await quality.GET(req('/api/admin/quality?days=7'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.days).toBe(7);
    expect(body.parsed).toBe(2);
    expect(body.unparsed).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.channels.map((c: any) => c.channel).sort()).toEqual(['schedule', 'skill']);
    dbRows = [];
  });

  it('admin/quality 带上告警状态：状态读不出来时显式标注，而不是假装「从未告警」', async () => {
    // V8.8：页面要能回答「配了告警为什么没收到」。三种可能（没到阈值 / 静默期 / 没跑过）
    // 在界面上长得一样，所以这些字段必须一起返回。
    dbRows = [];
    const r = await quality.GET(req('/api/admin/quality?days=1'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.alerts.policy.minCount).toBeGreaterThan(0);
    // 本用例里 getSetting 返回的是 'invite'（非 JSON），属于「读得出来但解析不了」
    expect(body.alerts.error).toBe('unreadable');
  });

  it('admin/quality/check 的 dryRun 只返回计划，不触发通知', async () => {
    const r = await qualityCheck.POST(req('/api/admin/quality/check', 'POST', { dryRun: true }));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.policy.windowMin).toBeGreaterThan(0);
    expect(Array.isArray(body.planned)).toBe(true);
  });

  it('admin/judge 缺少输入时 400，而不是把请求打到模型上', async () => {
    const r = await judge.POST(req('/api/admin/judge', 'POST', {}));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('请提供输入与回答');
  });

  it('admin/judge 正常入参返回评分', async () => {
    const r = await judge.POST(req('/api/admin/judge', 'POST', { input: '问', output: '答' }));
    expect(r.status).toBe(200);
    expect((await r.json()).score).toBe(9);
  });

  it('admin/users 只回传白名单字段，不泄露 passwordHash', async () => {
    dbRows = [
      {
        id: 'u9',
        email: 'x@y.com',
        name: 'X',
        role: 'member',
        status: 'active',
        monthlyLimit: 100,
        overQuotaAction: 'warn',
        alertThreshold: 80,
        passwordHash: 'SUPER_SECRET_HASH',
      },
    ];
    const r = await users.GET(req('/api/admin/users'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'u9', email: 'x@y.com', role: 'member' });
    // 关键：整份响应里不能出现密码哈希
    expect(JSON.stringify(body)).not.toContain('SUPER_SECRET_HASH');
    expect(body[0].passwordHash).toBeUndefined();
    dbRows = [];
  });

  it('admin/cost 返回聚合结构（含 total/byDay/byModel）', async () => {
    dbRows = [];
    const r = await cost.GET(req('/api/admin/cost?days=7'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.days).toBe(7);
    expect(body.total).toMatchObject({ tokens: 0, calls: 0, failRate: 0 });
    expect(Array.isArray(body.byDay)).toBe(true);
    expect(Array.isArray(body.byModel)).toBe(true);
  });

  it('admin/cost 真的做了聚合：同一模型两次调用合并、失败率按非 OK 计', async () => {
    // V8.10：SQL 现在返回结构化列（ok 是 boolean，模型名/用途来自真列），
    // 不再是 split_part 拼出来的 'OK'/'FAIL' 字符串。替身要跟着新契约走，
    // 否则测的是旧接口的形状——那种"绿"没有意义。
    dbRows = [
      { day: '2026-11-09', model: 'gpt-x', label: 'chat', ok: true, calls: 2, tokens: 100, promptTokens: 0, completionTokens: 0 },
      { day: '2026-11-09', model: 'gpt-x', label: 'chat', ok: false, calls: 1, tokens: 50, promptTokens: 0, completionTokens: 0 },
      { day: '2026-11-09', model: 'claude-y', label: 'tool', ok: true, calls: 1, tokens: 10, promptTokens: 0, completionTokens: 0 },
    ];
    const body = await (await cost.GET(req('/api/admin/cost?days=7'))).json();
    expect(body.total).toMatchObject({ tokens: 160, calls: 4, failRate: 25 });
    // 没配单价时必须自报「未计价」，而不是给出 ¥0.00 让人以为免费
    expect(body.total.fullyPriced).toBe(false);
    expect(body.total.unpriced.noPriceTokens).toBe(160);
    expect(body.currency).toEqual({ unit: 'cent', priceUnit: 'cent/1k tokens' });
    // 同一天必须并成一行，而不是三条
    expect(body.byDay).toHaveLength(1);
    expect(body.byDay[0]).toMatchObject({ key: '2026-11-09', tokens: 160, calls: 4 });
    expect(body.byModel).toHaveLength(2);
    dbRows = [];
  });

  it('admin/cost 非法 days 回落到 30', async () => {
    const r = await cost.GET(req('/api/admin/cost?days=999'));
    expect((await r.json()).days).toBe(30);
  });
});

describe('内容域入口保护（6 个入口，未登录一律 401）', () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const P = (id = 'x1') => ({ params: Promise.resolve({ id }) });
  const ENTRIES2: { name: string; call: () => Promise<Response> }[] = [
    { name: 'conversations GET', call: () => conversations.GET(req('/api/conversations')) },
    { name: 'conversations POST', call: () => conversations.POST(req('/api/conversations', 'POST', {})) },
    { name: 'conversations/[id] GET', call: () => conversationById.GET(req('/api/conversations/x1'), P()) },
    { name: 'conversations/[id] DELETE', call: () => conversationById.DELETE(req('/api/conversations/x1?from=m1'), P()) },
    { name: 'conversations/[id]/share POST', call: () => conversationShare.POST(req('/api/conversations/x1/share', 'POST', {}), P()) },
    { name: 'memories GET', call: () => memories.GET(req('/api/memories')) },
    { name: 'memories POST', call: () => memories.POST(req('/api/memories', 'POST', {})) },
    { name: 'projects GET', call: () => projects.GET(req('/api/projects')) },
    { name: 'projects/[id] GET', call: () => projectById.GET(req('/api/projects/x1'), P()) },
    { name: 'projects/[id]/members POST', call: () => projectMembers.POST(req('/api/projects/x1/members', 'POST', {}), P()) },
  ];

  for (const e of ENTRIES2) {
    it(`${e.name} → 401`, async () => {
      vi.mocked(getSession).mockResolvedValue(null);
      const r = await e.call();
      const body = await r.json();
      expect(r.status).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.traceId).toBeTruthy();
    });
  }
});

/**
 * V8.10：操作日志的「按 traceId 还原链路」入口。
 *
 * 为什么单独测：trace_id 在 v8.2 就有了，但只作为 `[trace:xxx] ` 前缀塞在 detail 里，
 * 按链路查日志只能 `LIKE '%…%'` 全表扫。落成真列后，这个入口是**唯一**能把
 * "一次请求做了什么"读出来的地方——它坏了不会报警，只会让排障重新回到猜时间戳。
 */
describe('操作日志按 traceId 还原链路', () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(admin as any);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('给出 trace 时按时间正序返回该链路的全部行，并标记 order=asc', async () => {
    dbRows = [
      { id: 'l1', action: 'chat', target: 'm1', status: 'ok', detail: '[trace:tr1a2b] start', durationMs: 3, createdAt: 1000, email: 'a@x.com' },
      { id: 'l2', action: 'tool_loop_guard', target: 'read_file', status: null, detail: null, durationMs: null, createdAt: 2000, email: 'a@x.com' },
    ];
    const r = await logs.GET(req('/api/logs?trace=tr1a2b'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.trace).toBe('tr1a2b');
    expect(body.order).toBe('asc');
    expect(body.total).toBe(2);
    expect(body.rows.map((x: any) => x.id)).toEqual(['l1', 'l2']);
  });

  it('非法 trace 直接返回空并标记 invalid（不把用户输入当查询条件）', async () => {
    dbRows = [{ id: 'l1', action: 'chat', createdAt: 1000 }];
    const r = await logs.GET(req('/api/logs?trace=' + encodeURIComponent('a b c!/../')));
    const body = await r.json();
    expect(body.invalid).toBe(true);
    expect(body.rows).toEqual([]);
  });

  it('不带 trace 时走分页浏览（回到原行为）', async () => {
    dbRows = [{ id: 'l1', action: 'chat', target: 't', status: 'ok', durationMs: 1, traceId: null, createdAt: 1000, email: null }];
    const r = await logs.GET(req('/api/logs?page=1&pageSize=50'));
    const body = await r.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.total).toBe(1);
    expect(body.rows[0].email).toBeNull();
  });
});
