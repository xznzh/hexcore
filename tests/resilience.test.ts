import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  CircuitOpenError,
  guardCircuit,
  isCircuitOpen,
  markCircuitFailure,
  markCircuitSuccess,
  resetCircuit,
} from '@/lib/resilience';

/**
 * 熔断器是「连续失败达阈值 → 冷却期快速失败 → 到期半开放行」的最小实现。
 * 这里锁住四条边界：阈值以下不误伤、达阈值必须拦、冷却期满必须自动恢复、成功即清零。
 *
 * 本文件跑的是**无 Redis** 路径（未配置 REDIS_URL），即「进程内兜底」那一层。
 * 集群共享语义在 `tests/resilience-cluster.test.ts` 里用假 Redis 单独验。
 */
describe('lib/resilience 连接器熔断器（本地兜底）', () => {
  const key = 'connector:unit-test';

  beforeEach(async () => {
    vi.useRealTimers();
    await resetCircuit(key);
  });

  afterEach(async () => {
    await resetCircuit(key);
    vi.useRealTimers();
  });

  it('未达阈值时正常放行（不误伤偶发失败）', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) await markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(false);
    await expect(guardCircuit(key)).resolves.toBeUndefined();
  });

  it('连续失败达阈值后打开熔断，并给出可读的中文提示', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) await markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(true);
    await expect(guardCircuit(key, '行情连接器')).rejects.toThrow(CircuitOpenError);
    await expect(guardCircuit(key, '行情连接器')).rejects.toThrow(/临时熔断/);
  });

  it('冷却期满后自动半开放行', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) await markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(true);

    vi.setSystemTime(t0 + BREAKER_COOLDOWN_MS - 1000);
    expect(isCircuitOpen(key)).toBe(true); // 冷却未满，仍然拦截

    vi.setSystemTime(t0 + BREAKER_COOLDOWN_MS + 1);
    expect(isCircuitOpen(key)).toBe(false);
    await expect(guardCircuit(key)).resolves.toBeUndefined();
  });

  it('一次成功即清零，恢复正常调用', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) await markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(true);
    await markCircuitSuccess(key);
    expect(isCircuitOpen(key)).toBe(false);
    await expect(guardCircuit(key)).resolves.toBeUndefined();
  });
});
