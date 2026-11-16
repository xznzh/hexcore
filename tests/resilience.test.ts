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

// 熔断器是「连续失败达阈值 → 冷却期快速失败 → 到期半开放行」的最小实现，
// 这里锁住三条边界：阈值以下不误伤、达阈值必须拦、冷却期满必须自动恢复。
describe('lib/resilience 连接器熔断器', () => {
  const key = 'connector:unit-test';

  beforeEach(() => {
    vi.useRealTimers();
    resetCircuit(key);
  });

  afterEach(() => {
    resetCircuit(key);
    vi.useRealTimers();
  });

  it('未达阈值时正常放行（不误伤偶发失败）', () => {
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(false);
    expect(() => guardCircuit(key)).not.toThrow();
  });

  it('连续失败达阈值后打开熔断，并给出可读的中文提示', () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(true);
    expect(() => guardCircuit(key, '行情连接器')).toThrow(CircuitOpenError);
    expect(() => guardCircuit(key, '行情连接器')).toThrow(/临时熔断/);
  });

  it('冷却期满后自动半开放行', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(true);

    vi.setSystemTime(t0 + BREAKER_COOLDOWN_MS - 1000);
    expect(isCircuitOpen(key)).toBe(true); // 冷却未满，仍然拦截

    vi.setSystemTime(t0 + BREAKER_COOLDOWN_MS + 1);
    expect(isCircuitOpen(key)).toBe(false);
    expect(() => guardCircuit(key)).not.toThrow();
  });

  it('一次成功即清零，恢复正常调用', () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) markCircuitFailure(key);
    expect(isCircuitOpen(key)).toBe(true);
    markCircuitSuccess(key);
    expect(isCircuitOpen(key)).toBe(false);
    expect(() => guardCircuit(key)).not.toThrow();
  });
});
