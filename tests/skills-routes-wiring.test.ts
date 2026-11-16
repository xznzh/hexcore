/**
 * 技能域（skills/* 与 chat/feedback、chat/mentions）迁移接线测试。
 *
 * 与前两个接线测试分工相同：直接 import **真实的 route 模块**，只 mock I/O 边界，
 * 检验「有没有包进 withApi、鉴权级别对不对、guest 是否真的只读、错误契约是否统一」。
 *
 * 这一域的特殊之处：**同一个文件里多个方法鉴权级别不同**（skills/route.ts 的
 * GET 对所有登录用户开放，POST/PATCH/DELETE 要挡访客）。这种「一文件多级别」
 * 最容易在迁移时被抹平成一个 `withApi(handler)` 默认值——默认是 user，
 * 登录即通过，访客就悄悄获得了写权限。下面的 guest 矩阵专门盯这一点。
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
    // 真实 drizzle 查询是 thenable，并且带 .catch/.finally：
    // chat/feedback 里 `db.delete(...).where(...).catch(() => {})` 就是靠这个走通的。
    // 替身少了 .catch 会直接 TypeError → 500，看起来像鉴权挂了，其实是 mock 不全。
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
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/util', () => ({
  newId: (p: string) => `${p}_test`,
  logAction: vi.fn(async () => undefined),
  estimateTokens: (s: string) => Math.ceil(String(s || '').length / 4),
  addUsage: vi.fn(async () => undefined),
}));
vi.mock('@/lib/projects', () => ({
  accessibleProjectIds: vi.fn(async () => new Set<string>()),
  canAccessProject: vi.fn(async () => true),
}));
vi.mock('@/lib/redis', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/quota', () => ({ checkQuota: vi.fn(async () => ({ exceeded: false })) }));
vi.mock('@/lib/agent', () => ({
  runSkill: vi.fn(async () => ({ trajectory: [], result: 'ok' })),
}));
vi.mock('@/lib/capabilities', () => ({
  listCapabilitiesForUser: vi.fn(async () => []),
}));
vi.mock('@/lib/skills/hub', () => ({
  // 只做「能不能解析」的最小判定，真实解析规则不属于本测试的范围
  parseSkillRef: vi.fn((input: string) =>
    input && input.includes('/') ? { kind: 'github', owner: 'o', repo: 'r', slug: 's' } : null,
  ),
  fetchSkillMeta: vi.fn(async () => ({
    source: 'github',
    sourceLabel: 'GitHub',
    name: 'demo',
    description: 'd',
    version: '1.0.0',
    author: 'a',
    security: [],
    files: ['SKILL.md'],
    scriptFiles: [],
    bodyPreview: 'hello world body',
    body: 'hello world body',
  })),
}));

import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/util';
import { checkRateLimit } from '@/lib/redis';
import { checkQuota } from '@/lib/quota';
import { parseSkillRef } from '@/lib/skills/hub';
import * as skills from '@/app/api/skills/route';
import * as skillVersions from '@/app/api/skills/[id]/versions/route';
import * as skillRollback from '@/app/api/skills/[id]/rollback/route';
import * as skillRun from '@/app/api/skills/run/route';
import * as skillRuns from '@/app/api/skills/runs/route';
import * as skillImport from '@/app/api/skills/import/route';
import * as skillImportUrl from '@/app/api/skills/import-url/route';
import * as skillPropose from '@/app/api/skills/propose/route';
import * as skillProposals from '@/app/api/skills/proposals/route';
import * as skillProposalById from '@/app/api/skills/proposals/[id]/route';
import * as chatFeedback from '@/app/api/chat/feedback/route';
import * as chatMentions from '@/app/api/chat/mentions/route';

const BASE = 'http://localhost:3111';
const req = (path: string, method = 'GET', body?: unknown) =>
  new NextRequest(new URL(BASE + path), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const P = (id = 'x1') => ({ params: Promise.resolve({ id }) });

const member = { userId: 'u1', email: 'm@x.com', role: 'member', name: 'm' } as any;
const admin = { userId: 'u2', email: 'a@x.com', role: 'admin', name: 'a' } as any;
const guest = { userId: 'u3', email: 'g@x.com', role: 'guest', name: 'g' } as any;

type Entry = {
  name: string;
  call: () => Promise<Response>;
  /** 该入口对访客应返回 403 */
  guestBlocked?: boolean;
};

const ENTRIES: Entry[] = [
  { name: 'skills GET', call: () => skills.GET(req('/api/skills')) },
  { name: 'skills POST', guestBlocked: true, call: () => skills.POST(req('/api/skills', 'POST', {})) },
  { name: 'skills PATCH', guestBlocked: true, call: () => skills.PATCH(req('/api/skills', 'PATCH', {})) },
  { name: 'skills DELETE', guestBlocked: true, call: () => skills.DELETE(req('/api/skills?id=x1', 'DELETE')) },
  { name: 'skills/[id]/versions GET', call: () => skillVersions.GET(req('/api/skills/x1/versions'), P()) },
  { name: 'skills/[id]/rollback POST', guestBlocked: true, call: () => skillRollback.POST(req('/api/skills/x1/rollback', 'POST', {}), P()) },
  { name: 'skills/run POST', guestBlocked: true, call: () => skillRun.POST(req('/api/skills/run', 'POST', {})) },
  { name: 'skills/runs GET', call: () => skillRuns.GET(req('/api/skills/runs?id=x1')) },
  { name: 'skills/import POST', guestBlocked: true, call: () => skillImport.POST(req('/api/skills/import', 'POST')) },
  { name: 'skills/import-url POST', guestBlocked: true, call: () => skillImportUrl.POST(req('/api/skills/import-url', 'POST', {})) },
  { name: 'skills/propose POST', guestBlocked: true, call: () => skillPropose.POST(req('/api/skills/propose', 'POST', {})) },
  { name: 'skills/proposals GET', guestBlocked: true, call: () => skillProposals.GET(req('/api/skills/proposals')) },
  { name: 'skills/proposals/[id] POST', guestBlocked: true, call: () => skillProposalById.POST(req('/api/skills/proposals/x1', 'POST', {}), P()) },
  { name: 'chat/feedback POST', call: () => chatFeedback.POST(req('/api/chat/feedback', 'POST', {})) },
  { name: 'chat/mentions GET', call: () => chatMentions.GET(req('/api/chat/mentions')) },
];

describe(`技能域路由接线（${ENTRIES.length} 个入口）`, () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(checkRateLimit).mockResolvedValue(true);
    vi.mocked(checkQuota).mockResolvedValue({ exceeded: false } as any);
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
      const body = await r.json();
      expect(r.status).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
    });
  }

  // —— 行为约束：这些是迁移时最容易「状态码对、语义错」的地方 ——

  it('skills PATCH 改他人技能 → 403（不是 404，也不是 500）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'someone_else', steps: '[]', version: 1 }];
    const r = await skills.PATCH(req('/api/skills', 'PATCH', { id: 'x1', name: 'n' }));
    const body = await r.json();
    expect(r.status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('skills PATCH 参数缺 id → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await skills.PATCH(req('/api/skills', 'PATCH', { name: 'n' }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ARGUMENT');
  });

  it('skills DELETE 缺 id → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await skills.DELETE(req('/api/skills', 'DELETE'));
    expect(r.status).toBe(400);
  });

  it('skills DELETE 删自己的技能 → 200 且写审计', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'u1' }];
    vi.mocked(logAction).mockClear();
    const r = await skills.DELETE(req('/api/skills?id=x1', 'DELETE'));
    expect(r.status).toBe(200);
    expect(vi.mocked(logAction)).toHaveBeenCalledWith('u1', 'skill_delete', 'x1');
  });

  it('skills/[id]/versions 看他人技能 → 403', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', ownerId: 'someone_else', version: 1 }];
    const r = await skillVersions.GET(req('/api/skills/x1/versions'), P());
    expect(r.status).toBe(403);
  });

  it('skills/[id]/versions 技能不存在 → 404', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [];
    const r = await skillVersions.GET(req('/api/skills/x1/versions'), P());
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('NOT_FOUND');
  });

  it('skills/[id]/rollback version 非正整数 → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await skillRollback.POST(req('/api/skills/x1/rollback', 'POST', { version: 0 }), P());
    expect(r.status).toBe(400);
  });

  it('skills/run 缺 id/input → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await skillRun.POST(req('/api/skills/run', 'POST', {}));
    expect(r.status).toBe(400);
  });

  it('skills/run 触发限流 → 429（不是 403/400）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    const r = await skillRun.POST(req('/api/skills/run', 'POST', { id: 'x1', input: 'hi' }));
    const body = await r.json();
    expect(r.status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('skills/run 额度用尽 → 403 + QUOTA_EXCEEDED', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    vi.mocked(checkQuota).mockResolvedValue({ exceeded: true } as any);
    const r = await skillRun.POST(req('/api/skills/run', 'POST', { id: 'x1', input: 'hi' }));
    const body = await r.json();
    expect(r.status).toBe(403);
    expect(body.code).toBe('QUOTA_EXCEEDED');
  });

  it('skills/runs 缺 id → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await skillRuns.GET(req('/api/skills/runs'));
    expect(r.status).toBe(400);
  });

  it('skills/import 无文件字段 → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const form = new FormData();
    const r = await skillImport.POST(
      new NextRequest(new URL(BASE + '/api/skills/import'), { method: 'POST', body: form }),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ARGUMENT');
  });

  it('skills/import-url 引用无法解析 → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    vi.mocked(parseSkillRef).mockReturnValueOnce(null as any);
    const r = await skillImportUrl.POST(req('/api/skills/import-url', 'POST', { url: 'nonsense' }));
    expect(r.status).toBe(400);
  });

  it('skills/import-url 上游超时 → 504（不是 500）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const hub = await import('@/lib/skills/hub');
    vi.mocked(hub.fetchSkillMeta).mockRejectedValueOnce(new Error('fetch timeout'));
    const r = await skillImportUrl.POST(req('/api/skills/import-url', 'POST', { url: 'o/r/s' }));
    const body = await r.json();
    expect(r.status).toBe(504);
    expect(body.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('skills/propose 上游失败 → 502（区别于本服务内部错误）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const hub = await import('@/lib/skills/hub');
    vi.mocked(hub.fetchSkillMeta).mockRejectedValueOnce(new Error('bad gateway'));
    const r = await skillPropose.POST(req('/api/skills/propose', 'POST', { ref: 'o/r/s' }));
    const body = await r.json();
    expect(r.status).toBe(502);
    expect(body.code).toBe('UPSTREAM_FAILED');
  });

  it('skills/proposals/[id] 普通成员确认安装 → 403（仅管理员）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', status: 'pending', requestedBy: 'u1', name: 'n', body: 'b', scriptFiles: '[]' }];
    const r = await skillProposalById.POST(
      req('/api/skills/proposals/x1', 'POST', { action: 'confirm' }),
      P(),
    );
    expect(r.status).toBe(403);
  });

  it('skills/proposals/[id] 非发起人忽略 → 403', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', status: 'pending', requestedBy: 'other', name: 'n', body: 'b', scriptFiles: '[]' }];
    const r = await skillProposalById.POST(
      req('/api/skills/proposals/x1', 'POST', { action: 'dismiss' }),
      P(),
    );
    expect(r.status).toBe(403);
  });

  it('skills/proposals/[id] 已处理过的提议再操作 → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(admin);
    dbRows = [{ id: 'x1', status: 'installed', requestedBy: 'u1', name: 'n', body: 'b', scriptFiles: '[]' }];
    const r = await skillProposalById.POST(
      req('/api/skills/proposals/x1', 'POST', { action: 'confirm' }),
      P(),
    );
    const body = await r.json();
    expect(r.status).toBe(400);
    expect(body.code).toBe('INVALID_STATE');
  });

  it('skills/proposals/[id] 发起人自己忽略 → 200', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'x1', status: 'pending', requestedBy: 'u1', name: 'n', body: 'b', scriptFiles: '[]' }];
    const r = await skillProposalById.POST(
      req('/api/skills/proposals/x1', 'POST', { action: 'dismiss' }),
      P(),
    );
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('dismissed');
  });

  it('chat/feedback 参数缺 rating → 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await chatFeedback.POST(req('/api/chat/feedback', 'POST', { messageId: 'm1' }));
    expect(r.status).toBe(400);
  });

  it('chat/feedback 正常点赞 → 200', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await chatFeedback.POST(req('/api/chat/feedback', 'POST', { messageId: 'm1', rating: 'up' }));
    expect(r.status).toBe(200);
  });

  it('未知异常统一 500，且响应体不泄露内部原文', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const boom = vi.spyOn(dbMock, 'select').mockImplementationOnce(() => {
      throw new Error('relation "skill_secret" does not exist');
    });
    const r = await skills.GET(req('/api/skills'));
    const body = await r.json();
    expect(r.status).toBe(500);
    expect(body.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('skill_secret');
    boom.mockRestore();
  });

  // —— V8.4：出口护栏必须带上通道上下文（否则会误伤「照知识库引用」）——

  const SKILL_ROW = { id: 'x1', ownerId: 'u1', scope: 'personal', steps: '[]', name: '周报技能' };
  /** V 层的审计只在「有问题」时才写，所以「没有 eval_runtime」本身就是一个断言 */
  const evalLogs = () => vi.mocked(logAction).mock.calls.filter((c) => c[1] === 'eval_runtime');

  it('skills/run：工具产出里有的报告名不算编造引用，产出不被截断', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [SKILL_ROW];
    const agent = await import('@/lib/agent');
    vi.mocked(agent.runSkill).mockResolvedValueOnce({
      trajectory: [
        { role: 'worker', type: 'tool', tool: 'search_knowledge', prompt: 'p', output: '[周报.docx] 《2025 年度运营报告》留存率 42%' },
      ],
      result: '按《2025 年度运营报告》，本周留存率 42%。',
    } as any);
    const r = await skillRun.POST(req('/api/skills/run', 'POST', { id: 'x1', input: '汇总周报' }));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.result).toContain('《2025 年度运营报告》');
    expect(body.guard).toBeUndefined();
  });

  it('skills/run：无出处的引用被截断，并显式告知调用方被拦过', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [SKILL_ROW];
    const agent = await import('@/lib/agent');
    vi.mocked(agent.runSkill).mockResolvedValueOnce({
      trajectory: [{ role: 'worker', type: 'llm', prompt: 'p', output: '写了点东西' }],
      result: '据《2025 年中国流浪动物白皮书》，全国有 4000 万只流浪动物。',
    } as any);
    const r = await skillRun.POST(req('/api/skills/run', 'POST', { id: 'x1', input: '写宣传文案' }));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.result).not.toContain('《2025 年中国流浪动物白皮书》');
    expect(body.guard).toEqual({ blocked: true, rule: 'unverified_citation' });
  });

  // —— V8.6：运行时 V 层同样要覆盖这条通道 ——

  it('skills/run：空产出记 eval_runtime / empty_answer', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [SKILL_ROW];
    vi.mocked(logAction).mockClear();
    const agent = await import('@/lib/agent');
    vi.mocked(agent.runSkill).mockResolvedValueOnce({ trajectory: [], result: '   ' } as any);

    await skillRun.POST(req('/api/skills/run', 'POST', { id: 'x1', input: '汇总周报' }));

    await vi.waitFor(() => expect(evalLogs().length).toBeGreaterThan(0));
    const [, , target, meta] = evalLogs()[0];
    expect(target).toBe('fail');
    expect(meta.detail).toContain('channel · skill/周报技能');
    expect(meta.detail).toContain('empty_answer');
  });

  it('skills/run：轨迹里有对应工具时不误报「已使用能力」', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [SKILL_ROW];
    vi.mocked(logAction).mockClear();
    const agent = await import('@/lib/agent');
    vi.mocked(agent.runSkill).mockResolvedValueOnce({
      trajectory: [{ role: 'worker', type: 'tool', tool: 'invoke_capability', prompt: 'p', output: '{"ok":1}' }],
      result: '已使用能力：天气查询\n今日晴，18℃。',
    } as any);

    await skillRun.POST(req('/api/skills/run', 'POST', { id: 'x1', input: '查天气' }));

    // 无问题即不写日志；若轨迹没被传进校验器，这里会冒出 ungrounded_capability
    await new Promise((r) => setTimeout(r, 20));
    expect(evalLogs()).toEqual([]);
  });
});
