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

/**
 * `dbErrorHint` 与 `classifyDbError` 是同一套判定的两个出口：
 * 分类给探针（机器读、不含细节），建议给人（启动日志与首屏报错、要具体到命令）。
 *
 * 这里守的不是文案本身，而是三条会导致「提示等于没提示」的底线：
 *   1. 每一类都必须给出下一步 —— 只回「数据库连不上」和回「服务器内部错误」一样没用；
 *   2. 已知类别的提示必须可执行（含命令或明确的检查点）；
 *   3. 任何一类都不得带出连接串细节（提示会出现在前端错误里，那是公网可见的位置）。
 */
describe('dbErrorHint', () => {
  const KINDS = [
    'auth_failed',
    'database_missing',
    'unreachable',
    'timeout',
    'dns_failed',
    'tls_failed',
    'unknown',
  ] as const;

  it('每个类别都有标题与修复建议，不存在空文案', async () => {
    const { dbErrorHint } = await import('@/lib/health');
    for (const k of KINDS) {
      const h = dbErrorHint(k);
      expect(h.title.trim().length, `${k} 缺标题`).toBeGreaterThan(0);
      expect(h.fix.trim().length, `${k} 缺修复建议`).toBeGreaterThan(0);
    }
  });

  it('库不存在给出 createdb 这一步（新手最容易漏的就是它）', async () => {
    const { dbErrorHint } = await import('@/lib/health');
    const h = dbErrorHint('database_missing');
    expect(h.title).toContain('不存在');
    expect(h.fix).toContain('createdb');
    // 表是自动建的，必须说清「只差库」这件事，否则新手会去手工跑迁移
    expect(h.fix).toContain('自动创建');
  });

  it('连不上时点明容器内不能用 localhost', async () => {
    const { dbErrorHint } = await import('@/lib/health');
    const h = dbErrorHint('unreachable');
    expect(h.fix).toContain('localhost');
    expect(h.fix).toMatch(/服务名|postgres:5432/);
  });

  it('任何类别的文案都不泄漏连接串 / 密码', async () => {
    const { dbErrorHint } = await import('@/lib/health');
    for (const k of KINDS) {
      const text = `${dbErrorHint(k).title} ${dbErrorHint(k).fix}`;
      expect(text.includes('postgres://'), `${k} 泄漏了连接串`).toBe(false);
      expect(text.includes('postgres:postgres'), `${k} 泄漏了用户名密码`).toBe(false);
    }
  });

  it('与分类函数串联：3D000 应一路走到「数据库不存在」', async () => {
    const { classifyDbError, dbErrorHint } = await import('@/lib/health');
    // 只给错误码、消息留空：模拟中文 Windows 下消息被打成乱码的情形，
    // 证明这条链路不依赖 message 文本。
    const err = Object.assign(new Error(''), { code: '3D000' });
    const kind = classifyDbError(err);
    expect(kind).toBe('database_missing');
    expect(dbErrorHint(kind).title).toBe('数据库不存在');
  });
});
