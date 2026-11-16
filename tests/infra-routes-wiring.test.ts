/**
 * 基建域（capabilities / connectors / knowledge）迁移接线测试。
 *
 * 与 `api-routes-wiring.test.ts` 分工相同：直接 import **真实的 route 模块**，
 * 只 mock 掉 I/O 边界（数据库、会话、下游连接器、队列），检验的是
 * 「路由有没有被正确包进 withApi、鉴权级别对不对、错误契约是否统一」。
 *
 * 为什么这一域更需要它：这里全是写操作与外部副作用（连接器凭据、能力审批、
 * 知识库文档增删）。鉴权级别写错（比如把 admin 写成 user）不会让 typecheck 报错，
 * 但会让普通成员能改连接器配置、能全局回填向量库。
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
}));
vi.mock('@/lib/redis', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/queue', () => ({ enqueueIndex: vi.fn(async () => undefined) }));
vi.mock('@/lib/projects', () => ({
  accessibleProjectIds: vi.fn(async () => new Set<string>()),
  canAccessProject: vi.fn(async () => true),
}));
vi.mock('@/lib/crypto', () => ({
  encryptJson: (v: any) => `enc:${JSON.stringify(v)}`,
  decryptJson: (v: any) => {
    try {
      return JSON.parse(String(v).replace(/^enc:/, ''));
    } catch {
      return {};
    }
  },
  safeDecrypt: (v: any) => String(v ?? ''),
}));
vi.mock('@/lib/tools', () => ({
  callConnector: vi.fn(async () => 'ok'),
  parseConnectorConfig: (v: any) => {
    try {
      return JSON.parse(String(v).replace(/^enc:/, ''));
    } catch {
      return {};
    }
  },
}));
vi.mock('@/lib/connectors/service', () => ({
  loadSpec: vi.fn(async () => ({
    parsed: { title: 't', version: '1', baseUrl: 'http://x', candidates: [], auth: [] },
    raw: {},
    specUrl: 'http://x/spec',
    baseUrl: 'http://x',
  })),
  checkConnectorHealth: vi.fn(async () => ({ status: 'ok', detail: 'ok', latencyMs: 1 })),
  previewRefresh: vi.fn(async () => ({ added: [], updated: [], removed: [], unchanged: 0 })),
  applyRefresh: vi.fn(async () => ({ inserted: 0, updated: 0, disabled: 0, diff: { added: [], updated: [], removed: [] } })),
  upsertCapabilities: vi.fn(async () => ({ inserted: 0, updated: 0 })),
}));
vi.mock('@/lib/ai/rag', () => ({
  retrieve: vi.fn(async () => []),
  clampTopK: (v: any) => (Number(v) > 0 ? Number(v) : 3),
  splitText: (t: string) => (t ? [t] : []),
  joinChunks: (a: string[]) => a.join(''),
}));
vi.mock('@/lib/ai/extract', () => ({
  extractTextFromBuffer: vi.fn(async () => ({ text: 'hi', engine: 'mock' })),
  UNSUPPORTED_HINT: '（不支持的文件类型）',
}));
vi.mock('@/lib/ai/embed', () => ({
  hasCapability: () => true,
  LOCAL_EMBEDDING: 'local:hash',
  AUTO_EMBEDDING: 'auto',
  normalizeEmbeddingRef: (v: any) => String(v ?? ''),
  validateEmbeddingRef: vi.fn(async () => ({ value: 'auto' })),
  embedText: vi.fn(async () => [0.1]),
  cosine: () => 0,
}));

import { getSession } from '@/lib/auth';
import * as capCatalog from '@/app/api/capabilities/route';
import * as capById from '@/app/api/capabilities/[id]/route';
import * as capApprovals from '@/app/api/capabilities/approvals/route';
import * as capGrants from '@/app/api/capabilities/grants/route';
import * as capInvoke from '@/app/api/capabilities/invoke/route';
import * as capMetrics from '@/app/api/capabilities/metrics/route';
import * as capOps from '@/app/api/capabilities/operations/route';
import * as capOpById from '@/app/api/capabilities/operations/[id]/route';
import * as conns from '@/app/api/connectors/route';
import * as connTest from '@/app/api/connectors/test/route';
import * as connHealth from '@/app/api/connectors/[id]/health/route';
import * as connMembers from '@/app/api/connectors/[id]/members/route';
import * as connRevoke from '@/app/api/connectors/[id]/revoke/route';
import * as connPreview from '@/app/api/connectors/[id]/refresh/preview/route';
import * as connApply from '@/app/api/connectors/[id]/refresh/apply/route';
import * as connConfirm from '@/app/api/connectors/confirm/route';
import * as connDiscover from '@/app/api/connectors/discover/route';
import * as kb from '@/app/api/knowledge/route';
import * as kbById from '@/app/api/knowledge/[id]/route';
import * as kbDoc from '@/app/api/knowledge/documents/[id]/route';
import * as kbRechunk from '@/app/api/knowledge/documents/[id]/rechunk/route';
import * as kbReextract from '@/app/api/knowledge/documents/[id]/reextract/route';
import * as kbDocReindex from '@/app/api/knowledge/documents/[id]/reindex/route';
import * as kbModels from '@/app/api/knowledge/embedding-models/route';
import * as kbQuery from '@/app/api/knowledge/query/route';
import * as kbReindex from '@/app/api/knowledge/reindex/route';

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

type Entry = { name: string; call: () => Promise<Response>; admin?: boolean };

const ENTRIES: Entry[] = [
  // —— capabilities ——
  { name: 'capabilities GET', call: () => capCatalog.GET(req('/api/capabilities')) },
  { name: 'capabilities/[id] PATCH', admin: true, call: () => capById.PATCH(req('/api/capabilities/x1', 'PATCH', {}), P()) },
  { name: 'capabilities/[id] DELETE', admin: true, call: () => capById.DELETE(req('/api/capabilities/x1', 'DELETE'), P()) },
  { name: 'capabilities/approvals POST', admin: true, call: () => capApprovals.POST(req('/api/capabilities/approvals', 'POST', {})) },
  { name: 'capabilities/grants GET', admin: true, call: () => capGrants.GET(req('/api/capabilities/grants?capabilityId=x1')) },
  { name: 'capabilities/grants POST', admin: true, call: () => capGrants.POST(req('/api/capabilities/grants', 'POST', {})) },
  { name: 'capabilities/grants DELETE', admin: true, call: () => capGrants.DELETE(req('/api/capabilities/grants?grantId=g1', 'DELETE')) },
  { name: 'capabilities/invoke POST', call: () => capInvoke.POST(req('/api/capabilities/invoke', 'POST', {})) },
  { name: 'capabilities/metrics GET', call: () => capMetrics.GET(req('/api/capabilities/metrics')) },
  { name: 'capabilities/operations GET', call: () => capOps.GET(req('/api/capabilities/operations')) },
  { name: 'capabilities/operations/[id] GET', call: () => capOpById.GET(req('/api/capabilities/operations/x1'), P()) },
  { name: 'capabilities/operations/[id] DELETE', call: () => capOpById.DELETE(req('/api/capabilities/operations/x1', 'DELETE'), P()) },

  // —— connectors ——
  { name: 'connectors GET', call: () => conns.GET(req('/api/connectors')) },
  { name: 'connectors POST', admin: true, call: () => conns.POST(req('/api/connectors', 'POST', {})) },
  { name: 'connectors PATCH', admin: true, call: () => conns.PATCH(req('/api/connectors', 'PATCH', {})) },
  { name: 'connectors DELETE', admin: true, call: () => conns.DELETE(req('/api/connectors?id=c1', 'DELETE')) },
  { name: 'connectors/test POST', call: () => connTest.POST(req('/api/connectors/test', 'POST', {})) },
  { name: 'connectors/[id]/health POST', admin: true, call: () => connHealth.POST(req('/api/connectors/x1/health', 'POST'), P()) },
  { name: 'connectors/[id]/members GET', admin: true, call: () => connMembers.GET(req('/api/connectors/x1/members'), P()) },
  { name: 'connectors/[id]/members POST', admin: true, call: () => connMembers.POST(req('/api/connectors/x1/members', 'POST', {}), P()) },
  { name: 'connectors/[id]/members DELETE', admin: true, call: () => connMembers.DELETE(req('/api/connectors/x1/members?grantId=g1', 'DELETE'), P()) },
  { name: 'connectors/[id]/revoke POST', admin: true, call: () => connRevoke.POST(req('/api/connectors/x1/revoke', 'POST'), P()) },
  { name: 'connectors/[id]/refresh/preview POST', admin: true, call: () => connPreview.POST(req('/api/connectors/x1/refresh/preview', 'POST', {}), P()) },
  { name: 'connectors/[id]/refresh/apply POST', admin: true, call: () => connApply.POST(req('/api/connectors/x1/refresh/apply', 'POST', {}), P()) },
  { name: 'connectors/confirm POST', admin: true, call: () => connConfirm.POST(req('/api/connectors/confirm', 'POST', {})) },
  { name: 'connectors/discover POST', admin: true, call: () => connDiscover.POST(req('/api/connectors/discover', 'POST', {})) },

  // —— knowledge ——
  { name: 'knowledge GET', call: () => kb.GET(req('/api/knowledge')) },
  { name: 'knowledge POST(json)', call: () => kb.POST(req('/api/knowledge', 'POST', {})) },
  { name: 'knowledge PATCH', call: () => kb.PATCH(req('/api/knowledge', 'PATCH', {})) },
  { name: 'knowledge DELETE', call: () => kb.DELETE(req('/api/knowledge?id=k1', 'DELETE')) },
  { name: 'knowledge/[id] GET', call: () => kbById.GET(req('/api/knowledge/x1'), P()) },
  { name: 'knowledge/documents/[id] DELETE', call: () => kbDoc.DELETE(req('/api/knowledge/documents/x1', 'DELETE'), P()) },
  { name: 'knowledge/documents/[id]/rechunk POST', call: () => kbRechunk.POST(req('/api/knowledge/documents/x1/rechunk', 'POST'), P()) },
  { name: 'knowledge/documents/[id]/reextract POST', call: () => kbReextract.POST(req('/api/knowledge/documents/x1/reextract', 'POST'), P()) },
  { name: 'knowledge/documents/[id]/reindex POST', call: () => kbDocReindex.POST(req('/api/knowledge/documents/x1/reindex', 'POST'), P()) },
  { name: 'knowledge/embedding-models GET', call: () => kbModels.GET(req('/api/knowledge/embedding-models')) },
  { name: 'knowledge/query POST', call: () => kbQuery.POST(req('/api/knowledge/query', 'POST', {})) },
  { name: 'knowledge/reindex POST', admin: true, call: () => kbReindex.POST(req('/api/knowledge/reindex', 'POST')) },
];

describe(`基建域路由接线（${ENTRIES.length} 个入口）`, () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
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

  for (const e of ENTRIES.filter((x) => x.admin)) {
    it(`${e.name}：普通成员 403（仅管理员可操作）`, async () => {
      vi.mocked(getSession).mockResolvedValue(member);
      const r = await e.call();
      const body = await r.json();
      expect(r.status).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
    });
  }
});

describe('基建域行为约束（不只是鉴权）', () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    dbRows = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('knowledge 写入对访客 403（不能只是「已登录就放行」）', async () => {
    vi.mocked(getSession).mockResolvedValue(guest);
    const r = await kb.POST(req('/api/knowledge', 'POST', { name: 'x' }));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain('访客');
  });

  it('knowledge/documents/[id] DELETE 对访客 403', async () => {
    vi.mocked(getSession).mockResolvedValue(guest);
    const r = await kbDoc.DELETE(req('/api/knowledge/documents/x1', 'DELETE'), P());
    expect(r.status).toBe(403);
  });

  it('capabilities/operations/[id] 不能看别人的操作（403 而非 200）', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    dbRows = [{ id: 'op1', userId: 'other-user', capabilityId: null, status: 'succeeded' }];
    const r = await capOpById.GET(req('/api/capabilities/operations/op1'), P('op1'));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('无权查看该操作');
  });

  it('管理员可以看任意人的操作详情', async () => {
    vi.mocked(getSession).mockResolvedValue(admin);
    dbRows = [{ id: 'op1', userId: 'other-user', capabilityId: null, status: 'succeeded' }];
    const r = await capOpById.GET(req('/api/capabilities/operations/op1'), P('op1'));
    expect(r.status).toBe(200);
  });

  it('capabilities/invoke 缺 name 时 400，不会打到下游连接器', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await capInvoke.POST(req('/api/capabilities/invoke', 'POST', {}));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('缺少 name');
  });

  it('knowledge/query 指定无权访问的库返回 403，而不是「查不到」', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await kbQuery.POST(req('/api/knowledge/query', 'POST', { query: '温度', kbId: 'kb-other' }));
    expect(r.status).toBe(403);
  });

  it('knowledge/query 空白 query 返回 400', async () => {
    vi.mocked(getSession).mockResolvedValue(member);
    const r = await kbQuery.POST(req('/api/knowledge/query', 'POST', { query: '  ' }));
    expect(r.status).toBe(400);
  });

  it('未知异常统一成 500 + INTERNAL，且不泄露内部错误原文', async () => {
    vi.mocked(getSession).mockResolvedValue(admin);
    dbRows = [];
    // 让 db 抛错，模拟「SQL 片段泄漏」场景（?all=1 走管理员全量分支，首条就是 db.select）
    const boom = vi.spyOn(dbMock, 'select').mockImplementationOnce(() => {
      throw new Error('relation "secret_table" does not exist');
    });
    const r = await capCatalog.GET(req('/api/capabilities?all=1'));
    const body = await r.json();
    expect(r.status).toBe(500);
    expect(body.code).toBe('INTERNAL');
    expect(body.traceId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('secret_table');
    boom.mockRestore();
  });
});
