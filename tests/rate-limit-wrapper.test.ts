import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 回归护栏：Bug-006「登录爆破无限制」依赖 checkRateLimit。
// 既有 rate-limit.test.ts 只覆盖了进程内 MemoryRateLimiter 本身，
// 未覆盖 checkRateLimit 的三条关键分支：无 Redis 降级 / Redis 正常计数 / Redis 异常回退。
// 这三条分支任何一条写错，都会让「限流形同虚设」但门禁依然全绿。

const state = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'throw',
  counts: new Map<string, number>(),
  expireCalls: [] as Array<{ key: string; sec: number }>,
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    constructor(_url?: string, _opts?: unknown) {}
    on() {
      return this;
    }
    async incr(key: string) {
      if (state.mode === 'throw') throw new Error('redis connection lost');
      const n = (state.counts.get(key) || 0) + 1;
      state.counts.set(key, n);
      return n;
    }
    async expire(key: string, sec: number) {
      state.expireCalls.push({ key, sec });
      return 1;
    }
    disconnect() {
      /* noop */
    }
  }
  return { default: FakeRedis };
});

/** 每个用例取全新模块实例：lib/redis 用模块级变量缓存连接与内存计数器 */
async function loadRedisModule(withRedis: boolean) {
  vi.resetModules();
  if (withRedis) process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  else delete process.env.REDIS_URL;
  return (await import('@/lib/redis')) as typeof import('@/lib/redis');
}

beforeEach(() => {
  state.mode = 'ok';
  state.counts.clear();
  state.expireCalls.length = 0;
});

afterEach(() => {
  delete process.env.REDIS_URL;
});

describe('checkRateLimit（有 Redis：多实例共享计数）', () => {
  it('窗口内按 max 放行，超出返回 false', async () => {
    const { checkRateLimit } = await loadRedisModule(true);
    expect(await checkRateLimit('ratelimit:login:1.2.3.4', 10, 60)).toBe(true);
    for (let i = 0; i < 9; i++) {
      expect(await checkRateLimit('ratelimit:login:1.2.3.4', 10, 60)).toBe(true);
    }
    expect(await checkRateLimit('ratelimit:login:1.2.3.4', 10, 60)).toBe(false);
  });

  it('只在首次计数时设置过期时间，避免 TTL 被无限续期', async () => {
    const { checkRateLimit } = await loadRedisModule(true);
    await checkRateLimit('k1', 5, 60);
    await checkRateLimit('k1', 5, 60);
    await checkRateLimit('k1', 5, 60);
    expect(state.expireCalls).toHaveLength(1);
    expect(state.expireCalls[0]).toEqual({ key: 'k1', sec: 60 });
  });

  it('不同 key 独立计数（不同 IP 互不影响）', async () => {
    const { checkRateLimit } = await loadRedisModule(true);
    expect(await checkRateLimit('ip:a', 1, 60)).toBe(true);
    expect(await checkRateLimit('ip:a', 1, 60)).toBe(false);
    expect(await checkRateLimit('ip:b', 1, 60)).toBe(true);
  });
});

describe('checkRateLimit（无 Redis：进程内降级，绝不阻断业务）', () => {
  it('未配置 REDIS_URL 时仍能正常限流', async () => {
    const { checkRateLimit } = await loadRedisModule(false);
    expect(await checkRateLimit('local:key', 2, 60)).toBe(true);
    expect(await checkRateLimit('local:key', 2, 60)).toBe(true);
    expect(await checkRateLimit('local:key', 2, 60)).toBe(false);
  });
});

describe('checkRateLimit（Redis 抖动：回退本地计数）', () => {
  it('incr 抛错时不冒泡异常，改为本地计数放行', async () => {
    const { checkRateLimit } = await loadRedisModule(true);
    state.mode = 'throw';
    await expect(checkRateLimit('fallback:key', 3, 60)).resolves.toBe(true);
    // 本地计数生效：第 4 次才拒绝
    expect(await checkRateLimit('fallback:key', 3, 60)).toBe(true);
    expect(await checkRateLimit('fallback:key', 3, 60)).toBe(true);
    expect(await checkRateLimit('fallback:key', 3, 60)).toBe(false);
  });
});
