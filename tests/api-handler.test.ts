import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ ensureInit: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));

import { withApi, apiError } from '@/lib/api/handler';
import { getSession } from '@/lib/auth';

const BASE = 'http://localhost:3111';
const mk = (path = '/api/x', method = 'GET', headers: Record<string, string> = {}) =>
  new NextRequest(new URL(BASE + path), { method, headers });

const member = { userId: 'u1', email: 'm@x.com', role: 'member', name: 'm' };
const admin = { userId: 'u2', email: 'a@x.com', role: 'admin', name: 'a' };

describe('withApi 契约', () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('未登录返回 401，且响应体带 code 与 traceId', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const h = withApi(async () => new Response('should not run'));
    const r = await h(mk());
    const body = await r.json();

    expect(r.status).toBe(401);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.error).toBe('未登录');
    expect(body.traceId).toMatch(/^tr[\w]{4,}$/);
  });

  it('admin 路由：普通成员返回 403，管理员放行', async () => {
    vi.mocked(getSession).mockResolvedValue(member as any);
    const h = withApi(async () => new Response('ok'), { auth: 'admin' });
    expect((await h(mk())).status).toBe(403);

    vi.mocked(getSession).mockResolvedValue(admin as any);
    expect((await h(mk())).status).toBe(200);
  });

  it('业务抛 ApiError 时按声明翻译，不透出 500', async () => {
    vi.mocked(getSession).mockResolvedValue(member as any);
    const h = withApi(async () => {
      apiError(404, 'NOT_FOUND', '待办不存在');
    });
    const r = await h(mk());
    const body = await r.json();
    expect(r.status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toBe('待办不存在');
  });

  it('未预期异常返回 500，且不把内部错误原文吐给客户端', async () => {
    vi.mocked(getSession).mockResolvedValue(member as any);
    const h = withApi(async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    const r = await h(mk());
    const body = await r.json();

    expect(r.status).toBe(500);
    expect(body.error).toBe('服务器内部错误');
    expect(JSON.stringify(body)).not.toContain('secret_table');
    // 但服务端日志必须留痕，否则没法查
    expect(console.error).toHaveBeenCalled();
  });

  it('沿用中间件写入的 x-trace-id，保证链路可串', async () => {
    vi.mocked(getSession).mockResolvedValue(member as any);
    const h = withApi(async ({ traceId }) => new Response(traceId));
    const r = await h(mk('/api/x', 'GET', { 'x-trace-id': 'trabcdef12345678' }));
    expect(await r.text()).toBe('trabcdef12345678');
  });

  it("auth:'none' 时无需会话，也不应调用 getSession", async () => {
    const h = withApi(async () => new Response('ok'), { auth: 'none' });
    expect((await h(mk('/api/health'))).status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
  });
});
