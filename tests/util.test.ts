import { describe, expect, it } from 'vitest';
import { newId, periodNow, estimateTokens } from '@/lib/util';

describe('lib/util 基础工具', () => {
  it('newId 生成带前缀且不重复的短 id', () => {
    const a = newId('todo');
    const b = newId('todo');
    expect(a).toMatch(/^todo_[a-z0-9]+$/);
    expect(a).not.toEqual(b);
  });

  it('periodNow 返回 yyyy-mm 格式', () => {
    const p = periodNow();
    expect(p).toMatch(/^\d{4}-\d{2}$/);
  });

  it('estimateTokens 按 字符数/4 向上取整且最小为 1', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcdefg')).toBe(2);
  });
});
