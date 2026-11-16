/**
 * 认证域的迁移接线测试（88 个 route 的最后一批）。
 *
 * 这五个接口是全站唯一不接受「必须已登录」的入口，因此**不能**简单套默认的
 * `auth: 'user'` —— 那样 login/register 会在校验密码之前就被包装器 401 掉。
 * 迁移的真正难点不是状态码，而是三个容易被抹平的语义：
 *
 *   1. login 的 401 是「凭据不对」，不是「没登录」。若与 UNAUTHORIZED 混用，
 *      前端拦截器会把一次输错密码当成会话过期，清状态并跳登录页。
 *   2. logout 必须幂等。要求已登录时，token 已过期的用户点退出会拿到 401，
 *      与「退出失败」无法区分，容易退不出去。
 *   3. register 的四种 403/409（关闭注册 / 缺邀请码 / 邀请码失效 / 邮箱占用）
 *      前端引导动作各不相同，只靠状态码分不开，必须各带自己的 code。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const state = {
  loginRows: [] as any[],
  takenRows: [] as any[],
  inviteRows: [] as any[],
  claimedRows: [{ id: 'i1' }] as any[],
  userCount: 1,
  inserted: null as any,
  failLimit: false,
};

function makeChain(isTx: boolean) {
  let cur: any = null;
  const c: any = {
    select: () => c,
    from: (t: any) => {
      cur = t;
      return c;
    },
    where: () => c,
    limit: async () => {
      if (state.failLimit) throw new Error('relation "users" does not exist');
      if (cur === users) return isTx ? state.takenRows : state.loginRows;
      if (cur === invites) return state.inviteRows;
      return [];
    },
    insert: () => c,
    values: async (v: any) => {
      state.inserted = v;
    },
    update: () => c,
    set: () => c,
    returning: async () => state.claimedRows,
    execute: async () => [{ c: state.userCount }],
    then: (res: any, rej: any) => Promise.resolve([]).then(res, rej),
    catch: (fn: any) => Promise.resolve([]).catch(fn),
    finally: (fn: any) => Promise.resolve([]).finally(fn),
  };
  return c;
}

const dbChain = makeChain(false);
const txChain = makeChain(true);

vi.mock('@/lib/db', () => ({
  ensureInit: vi.fn(async () => undefined),
  get db() {
    return {
      ...dbChain,
      transaction: async (fn: any) => fn(txChain),
    };
  },
}));

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(async () => 'hashed'),
  signToken: vi.fn(() => 'token'),
  setAuthCookie: vi.fn(async () => undefined),
  clearAuthCookie: vi.fn(async () => undefined),
}));

vi.mock('@/lib/util', () => ({
  newId: (p: string) => `${p}_test`,
  logAction: vi.fn(async () => undefined),
}));

vi.mock('@/lib/redis', () => ({
  checkRateLimit: vi.fn(async () => true),
}));

vi.mock('@/lib/settings', () => ({
  getRegisterMode: vi.fn(async () => 'open'),
}));

import { users, invites } from '@/lib/schema';
import { getSession, verifyPassword, setAuthCookie, clearAuthCookie } from '@/lib/auth';
import { logAction } from '@/lib/util';
import { checkRateLimit } from '@/lib/redis';
import { getRegisterMode } from '@/lib/settings';
import * as login from '@/app/api/auth/login/route';
import * as logout from '@/app/api/auth/logout/route';
import * as me from '@/app/api/auth/me/route';
import * as registerMode from '@/app/api/auth/register-mode/route';
import * as register from '@/app/api/auth/register/route';

const BASE = 'http://localhost:3111';
const req = (path: string, method = 'GET', body?: unknown) =>
  new NextRequest(new URL(BASE + path), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const json = async (r: Response) => (await r.json()) as any;

const member = { userId: 'u1', email: 'm@x.com', name: 'm', role: 'member' } as any;

const setSession = (s: any) => vi.mocked(getSession).mockResolvedValue(s);

const activeUser = {
  id: 'u1',
  email: 'm@x.com',
  name: 'm',
  role: 'member',
  status: 'active',
  passwordHash: '$2a$10$realhash',
  tokenVersion: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.loginRows = [];
  state.takenRows = [];
  state.inviteRows = [];
  state.claimedRows = [{ id: 'i1' }];
  state.userCount = 1;
  state.inserted = null;
  state.failLimit = false;
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(getRegisterMode).mockResolvedValue('open');
});

describe('/api/auth/me', () => {
  it('未登录返回 401 UNAUTHORIZED，且带 traceId', async () => {
    setSession(null);
    const res = await me.GET(req('/api/auth/me'));
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.error).toBe('未登录');
    // 错误契约三件套：前端贴给运维靠的就是它
    expect(body.traceId).toBeTruthy();
  });

  it('已登录时字段完全来自 session，不去查库（避免每次导航一次 SELECT）', async () => {
    setSession(member);
    const res = await me.GET(req('/api/auth/me'));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      userId: 'u1',
      email: 'm@x.com',
      name: 'm',
      role: 'member',
    });
  });
});

describe('/api/auth/logout', () => {
  it('没有会话也要能退出（幂等），不能返回 401', async () => {
    setSession(null);
    const res = await logout.POST(req('/api/auth/logout', 'POST'));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(clearAuthCookie).toHaveBeenCalledTimes(1);
  });

  it('有会话时同样清 cookie', async () => {
    setSession(member);
    const res = await logout.POST(req('/api/auth/logout', 'POST'));
    expect(res.status).toBe(200);
    expect(clearAuthCookie).toHaveBeenCalledTimes(1);
  });
});

describe('/api/auth/register-mode', () => {
  it('匿名可读，返回当前注册模式', async () => {
    setSession(null);
    vi.mocked(getRegisterMode).mockResolvedValue('invite');
    const res = await registerMode.GET(req('/api/auth/register-mode'));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ mode: 'invite' });
  });
});

describe('/api/auth/login', () => {
  it('账号不存在与密码错误返回同一文案，避免账号枚举', async () => {
    setSession(null);
    vi.mocked(verifyPassword).mockResolvedValue(false);

    state.loginRows = [];
    const r1 = await login.POST(req('/api/auth/login', 'POST', { email: 'n@x.com', password: 'p' }));
    expect(r1.status).toBe(401);
    const b1 = await json(r1);

    state.loginRows = [activeUser];
    vi.mocked(verifyPassword).mockResolvedValue(false);
    const r2 = await login.POST(req('/api/auth/login', 'POST', { email: 'm@x.com', password: 'bad' }));
    expect(r2.status).toBe(401);
    const b2 = await json(r2);

    expect(b1.error).toBe(b2.error);
    expect(b1.code).toBe('INVALID_CREDENTIALS');
    expect(b2.code).toBe('INVALID_CREDENTIALS');
  });

  it('401 绝不能是 UNAUTHORIZED —— 那是「没登录」的约定，前端会清状态跳转', async () => {
    setSession(null);
    vi.mocked(verifyPassword).mockResolvedValue(false);
    state.loginRows = [];
    const res = await login.POST(req('/api/auth/login', 'POST', { email: 'n@x.com', password: 'p' }));
    expect((await json(res)).code).not.toBe('UNAUTHORIZED');
  });

  it('账号不存在时仍跑一次 bcrypt，抹平响应时间侧信道', async () => {
    setSession(null);
    state.loginRows = [];
    vi.mocked(verifyPassword).mockResolvedValue(false);
    await login.POST(req('/api/auth/login', 'POST', { email: 'n@x.com', password: 'p' }));
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('禁用账号返回 403 ACCOUNT_DISABLED，且不签发 token', async () => {
    setSession(null);
    state.loginRows = [{ ...activeUser, status: 'disabled' }];
    const res = await login.POST(req('/api/auth/login', 'POST', { email: 'm@x.com', password: 'p' }));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('ACCOUNT_DISABLED');
    expect(setAuthCookie).not.toHaveBeenCalled();
  });

  it('参数不合法返回 400 INVALID_ARGUMENT', async () => {
    setSession(null);
    const res = await login.POST(req('/api/auth/login', 'POST', { email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('INVALID_ARGUMENT');
  });

  it('限流命中返回 429 RATE_LIMITED（此前无任何限流，可无限撞库）', async () => {
    setSession(null);
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    const res = await login.POST(req('/api/auth/login', 'POST', { email: 'm@x.com', password: 'p' }));
    expect(res.status).toBe(429);
    expect((await json(res)).code).toBe('RATE_LIMITED');
  });

  it('成功登录签发 cookie 并记审计日志', async () => {
    setSession(null);
    state.loginRows = [activeUser];
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const res = await login.POST(req('/api/auth/login', 'POST', { email: 'M@X.com', password: 'p' }));
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe('u1');
    expect(setAuthCookie).toHaveBeenCalledWith('token');
    expect(logAction).toHaveBeenCalledWith('u1', 'login', 'm@x.com');
  });

  it('底层异常统一成 500 INTERNAL，且不把 SQL/表名原文返回给客户端', async () => {
    setSession(null);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.failLimit = true;
    const res = await login.POST(req('/api/auth/login', 'POST', { email: 'm@x.com', password: 'p' }));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.code).toBe('INTERNAL');
    expect(body.error).toBe('服务器内部错误');
    expect(JSON.stringify(body)).not.toContain('relation');
    // 但必须留在服务端日志里，否则线上无从排障
    expect(spy.mock.calls.some((c) => String(c[0]).includes('relation'))).toBe(true);
    spy.mockRestore();
  });
});

describe('/api/auth/register', () => {
  const okBody = { name: 'n', email: 'n@x.com', password: '123456' };

  it('邮箱已占用返回 409 EMAIL_TAKEN', async () => {
    setSession(null);
    state.takenRows = [{ id: 'u9' }];
    const res = await register.POST(req('/api/auth/register', 'POST', okBody));
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('EMAIL_TAKEN');
  });

  it('admin_only 模式返回 403 REGISTRATION_CLOSED', async () => {
    setSession(null);
    vi.mocked(getRegisterMode).mockResolvedValue('admin_only');
    const res = await register.POST(req('/api/auth/register', 'POST', okBody));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('REGISTRATION_CLOSED');
  });

  it('invite 模式缺邀请码返回 400 INVITE_REQUIRED', async () => {
    setSession(null);
    vi.mocked(getRegisterMode).mockResolvedValue('invite');
    const res = await register.POST(req('/api/auth/register', 'POST', okBody));
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('INVITE_REQUIRED');
  });

  it('邀请码无效返回 403 INVITE_INVALID', async () => {
    setSession(null);
    vi.mocked(getRegisterMode).mockResolvedValue('invite');
    state.inviteRows = [{ id: 'i1', code: 'X', used: true, role: 'member' }];
    const res = await register.POST(
      req('/api/auth/register', 'POST', { ...okBody, inviteCode: 'X' }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('INVITE_INVALID');
  });

  it('邀请码抢锁失败（并发下被别人先用）也返回 INVITE_INVALID，不建号', async () => {
    setSession(null);
    vi.mocked(getRegisterMode).mockResolvedValue('invite');
    state.inviteRows = [{ id: 'i1', code: 'X', used: false, role: 'member' }];
    state.claimedRows = [];
    const res = await register.POST(
      req('/api/auth/register', 'POST', { ...okBody, inviteCode: 'X' }),
    );
    expect(res.status).toBe(403);
    expect(state.inserted).toBeNull();
  });

  it('首位注册者跳过一切模式校验，直接成为 admin', async () => {
    setSession(null);
    state.userCount = 0;
    vi.mocked(getRegisterMode).mockResolvedValue('admin_only');
    const res = await register.POST(req('/api/auth/register', 'POST', okBody));
    expect(res.status).toBe(200);
    expect((await json(res)).role).toBe('admin');
    expect(state.inserted.role).toBe('admin');
  });

  it('参数不合法返回 400 INVALID_ARGUMENT（密码不足 6 位）', async () => {
    setSession(null);
    const res = await register.POST(
      req('/api/auth/register', 'POST', { name: 'n', email: 'n@x.com', password: '123' }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('INVALID_ARGUMENT');
  });

  it('唯一约束冲突（并发穿透存在性检查）兜底成 409，而不是 500', async () => {
    setSession(null);
    const tx = txChain;
    const origInsert = tx.insert;
    tx.insert = () => ({
      values: async () => {
        throw new Error('duplicate key value violates unique constraint "users_email_unique"');
      },
    });
    const res = await register.POST(req('/api/auth/register', 'POST', okBody));
    tx.insert = origInsert;
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('EMAIL_TAKEN');
  });

  it('注册成功签发 cookie 并记审计日志', async () => {
    setSession(null);
    const res = await register.POST(req('/api/auth/register', 'POST', okBody));
    expect(res.status).toBe(200);
    expect(setAuthCookie).toHaveBeenCalledWith('token');
    expect(logAction).toHaveBeenCalledWith('u_test', 'register', 'n@x.com');
  });
});
