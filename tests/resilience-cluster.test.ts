import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 熔断器的**集群语义**（V8.22）。
 *
 * 为什么单独一个文件：这一层要证明的不是「计数能不能加」，而是
 * 「A 副本熔断之后，B 副本会不会继续把请求打向同一个死掉的上游」。
 * 旧实现里 B 一无所知，副本数 N 就把故障放大 N 倍——而它保护的恰恰是外部依赖。
 *
 * 用一个内存版 Redis 替身来模拟共享状态：它只实现熔断器真正用到的四个命令
 * （HMGET / MULTI-HINCRBY / HSET / EXPIRE / DEL），行为与真实 Redis 一致到
 * 「够用就好」——替身写得越像，测试越是在测替身。
 */

const h = vi.hoisted(() => {
  const hashes = new Map<string, Map<string, string>>();
  const flags = { redisAvailable: true };

  const multi = () => {
    const ops: Array<() => [null, number]> = [];
    const api = {
      hincrby(key: string, field: string, n: number) {
        ops.push(() => {
          const map = hashes.get(key) || new Map<string, string>();
          hashes.set(key, map);
          const v = Number(map.get(field) || 0) + n;
          map.set(field, String(v));
          return [null, v] as [null, number];
        });
        return api;
      },
      hset(key: string, field: string, value: string) {
        ops.push(() => {
          const map = hashes.get(key) || new Map<string, string>();
          hashes.set(key, map);
          map.set(field, String(value));
          return [null, 1] as [null, number];
        });
        return api;
      },
      expire() {
        ops.push(() => [null, 1] as [null, number]);
        return api;
      },
      async exec() {
        return ops.map((f) => f());
      },
    };
    return api;
  };

  const client = {
    async hmget(key: string, ...fields: string[]) {
      const map = hashes.get(key);
      return fields.map((f) => map?.get(f) ?? null);
    },
    multi,
    async del(key: string) {
      hashes.delete(key);
      return 1;
    },
  };

  return { hashes, flags, client };
});

vi.mock('@/lib/redis', () => ({
  getRedis: () => (h.flags.redisAvailable ? h.client : null),
}));

import {
  BREAKER_THRESHOLD,
  guardCircuit,
  isCircuitOpen,
  markCircuitFailure,
  markCircuitSuccess,
  resetCircuit,
} from '@/lib/resilience';

describe('lib/resilience 熔断器（集群共享）', () => {
  afterEach(() => {
    h.flags.redisAvailable = true;
  });

  it('别的副本已熔断 → 本副本不再放量（本地毫无记录也要拦）', async () => {
    // 模拟「A 副本失败 5 次后写进了共享状态，B 副本刚启动、内存里什么都没有」
    h.hashes.set('breaker:connector:shared', new Map([
      ['failures', String(BREAKER_THRESHOLD)],
      ['openedAt', String(Date.now())],
    ]));

    expect(isCircuitOpen('connector:shared')).toBe(false); // 本地视图确实是干净的
    await expect(guardCircuit('connector:shared', '共享连接器')).rejects.toThrow(/临时熔断/);
  });

  it('失败计数写进共享状态（不是只加本地）', async () => {
    await markCircuitFailure('connector:shared-write');
    await markCircuitFailure('connector:shared-write');
    expect(h.hashes.get('breaker:connector:shared-write')?.get('failures')).toBe('2');
  });

  it('一次成功即清掉共享状态（否则别的副本还要被拦一个冷却期）', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) await markCircuitFailure('connector:shared-reset');
    expect(h.hashes.has('breaker:connector:shared-reset')).toBe(true);
    await markCircuitSuccess('connector:shared-reset');
    expect(h.hashes.has('breaker:connector:shared-reset')).toBe(false);
    await expect(guardCircuit('connector:shared-reset')).resolves.toBeUndefined();
  });

  it('Redis 不可用时回落本地计数，功能不降级为「永不熔断」', async () => {
    h.flags.redisAvailable = false;
    const key = 'connector:no-redis';
    await resetCircuit(key);

    for (let i = 0; i < BREAKER_THRESHOLD; i++) await markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(true);
    await expect(guardCircuit(key)).rejects.toThrow(/临时熔断/);
    await resetCircuit(key);
  });
});
