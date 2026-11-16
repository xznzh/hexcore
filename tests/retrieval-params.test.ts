import { describe, expect, it } from 'vitest';
import { clampTopK } from '@/lib/ai/rag';

// 回归护栏：BUG-023
// 旧写法 `Math.max(1, Math.min(20, Number(v) || 3))` 里 Number(0) 是 falsy，
// 被 `|| 3` 吃掉 → topK=0 静默变成 3，下限分支对 0 永远不可达。
// 与 BUG-007（额度 0 被 || 当默认值）同源，属同类残留缺陷。

describe('clampTopK（检索条数解析）', () => {
  it('未传 / null / 空串 → 默认 3', () => {
    expect(clampTopK(undefined)).toBe(3);
    expect(clampTopK(null)).toBe(3);
    expect(clampTopK('')).toBe(3);
  });

  it('非数值 → 默认 3（不能变成 NaN 或 0）', () => {
    expect(clampTopK('abc')).toBe(3);
    expect(clampTopK(NaN)).toBe(3);
    expect(clampTopK(Infinity)).toBe(3);
    expect(clampTopK({})).toBe(3);
  });

  it('0 与负数 → 夹到下限 1（BUG-023 的核心断言）', () => {
    expect(clampTopK(0)).toBe(1);
    expect(clampTopK('0')).toBe(1);
    expect(clampTopK(-5)).toBe(1);
  });

  it('正常值原样返回，超过上限夹到 20', () => {
    expect(clampTopK(1)).toBe(1);
    expect(clampTopK(5)).toBe(5);
    expect(clampTopK(20)).toBe(20);
    expect(clampTopK(21)).toBe(20);
    expect(clampTopK(100)).toBe(20);
  });

  it('数字字符串按数值处理（表单提交常见）', () => {
    expect(clampTopK('7')).toBe(7);
  });

  it('小数向下取整，避免 SQL limit 收到非整数', () => {
    expect(clampTopK(2.9)).toBe(2);
  });
});
