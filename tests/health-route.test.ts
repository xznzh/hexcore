/**
 * `/api/health` 探针的安全契约。
 *
 * 这个接口**匿名可访问**，所以它的响应体本身就是攻击面。原始数据库错误里常带
 * `ECONNREFUSED 10.0.3.17:5432`、`password authentication failed for user "agent"`
 * 这类内容——内网拓扑 + 用户名，一次 `curl` 就能拿走。因此这里断言的不是
 * "错误能被看到"，而是 **"错误能被判断，但看不出细节"**：只回类别枚举，
 * 原文必须只出现在服务端日志。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

type Exec = () => Promise<unknown>;
let execImpl: Exec = async () => [{ ok: 1 }];

vi.mock('@/lib/db', () => ({
  get db() {
    return { execute: () => execImpl() };
  },
  getDbSelfCheck: () => ({ vectorSupported: null, schemaIssues: [] }),
}));

vi.mock('@/lib/redis', () => ({
  pingRedis: vi.fn(async () => false),
}));

const { GET } = await import('@/app/api/health/route');

/** 带内网地址的原始错误：修复前会被截断 200 字原样吐出。 */
function pgError(message: string, code?: string) {
  const e = new Error(message) as Error & { code?: string };
  if (code) e.code = code;
  return e;
}

async function callHealth(full = true) {
  const url = `http://localhost:3000/api/health${full ? '?full=1' : ''}`;
  const res = await GET(new Request(url));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/health', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // 日志是被允许的出口，这里静音避免污染测试输出，但保留可断言性
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    execImpl = async () => [{ ok: 1 }];
  });

  it('存活探针不触库，固定 200', async () => {
    execImpl = async () => {
      throw new Error('不该被调用');
    };
    const { status, body } = await callHealth(false);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, mode: 'live' });
  });

  it('数据库正常时就绪探针 200 且 errorKind 为 null', async () => {
    const { status, body } = await callHealth();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.db.errorKind).toBeNull();
  });

  it('连接被拒：只回 unreachable，不泄漏内网 IP 与端口', async () => {
    execImpl = async () => {
      throw pgError('connect ECONNREFUSED 10.0.3.17:5432');
    };
    const { status, body } = await callHealth();

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.db.errorKind).toBe('unreachable');

    // 核心断言：整份响应里不允许出现原始错误的任何片段
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('10.0.3.17');
    expect(raw).not.toContain('5432');
    expect(raw).not.toContain('ECONNREFUSED');
    expect(body.checks.db).not.toHaveProperty('error');
  });

  it('认证失败：只回 auth_failed，不泄漏用户名', async () => {
    execImpl = async () => {
      throw pgError('password authentication failed for user "agent_admin"', '28P01');
    };
    const { body } = await callHealth();

    expect(body.checks.db.errorKind).toBe('auth_failed');
    expect(JSON.stringify(body)).not.toContain('agent_admin');
  });

  it('库不存在 → database_missing', async () => {
    execImpl = async () => {
      throw pgError('database "agent_platform" does not exist', '3D000');
    };
    const { body } = await callHealth();
    expect(body.checks.db.errorKind).toBe('database_missing');
  });

  it('域名解析失败 → dns_failed', async () => {
    execImpl = async () => {
      throw pgError('getaddrinfo ENOTFOUND db.internal.corp');
    };
    const { body } = await callHealth();
    expect(body.checks.db.errorKind).toBe('dns_failed');
    expect(JSON.stringify(body)).not.toContain('db.internal.corp');
  });

  it('超时 → timeout', async () => {
    execImpl = async () => {
      throw pgError('Connection terminated due to connection timeout');
    };
    const { body } = await callHealth();
    expect(body.checks.db.errorKind).toBe('timeout');
  });

  it('无法归类的错误 → unknown，仍然不回原文', async () => {
    execImpl = async () => {
      throw pgError('something weird happened at 192.168.1.9');
    };
    const { body } = await callHealth();
    expect(body.checks.db.errorKind).toBe('unknown');
    expect(JSON.stringify(body)).not.toContain('192.168.1.9');
  });

  it('原文进日志（可运维），但日志与响应分离', async () => {
    execImpl = async () => {
      throw pgError('connect ECONNREFUSED 10.0.3.17:5432');
    };
    await callHealth();

    expect(errSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).toContain('10.0.3.17');
    expect(logged).toContain('unreachable');
  });
});

/**
 * 分类函数本身的边界。上层的 9 条验证了「响应不泄漏」，这里验证「分类判得对」——
 * 判错了不会泄漏数据，但会让运维看着 `unknown` 无从下手。
 */
describe('classifyDbError', () => {
  const withCode = (code: string) => Object.assign(new Error('boom'), { code });

  it('按 SQLSTATE 判定（错误码独立于 message 生效）', async () => {
    const { classifyDbError } = await import('@/lib/health');
    expect(classifyDbError(withCode('28P01'))).toBe('auth_failed');
    expect(classifyDbError(withCode('3D000'))).toBe('database_missing');
    expect(classifyDbError(withCode('57P03'))).toBe('unreachable');
    expect(classifyDbError(withCode('53300'))).toBe('unreachable');
  });

  it('证书类错误单独归类，不与 unreachable 混在一起', async () => {
    const { classifyDbError } = await import('@/lib/health');
    expect(classifyDbError(new Error('self-signed certificate in certificate chain'))).toBe(
      'tls_failed',
    );
  });

  it('非 Error 入参（字符串 / null）不抛异常', async () => {
    const { classifyDbError } = await import('@/lib/health');
    expect(classifyDbError('随便一段文本')).toBe('unknown');
    expect(classifyDbError(null)).toBe('unknown');
    expect(classifyDbError(undefined)).toBe('unknown');
  });
});
