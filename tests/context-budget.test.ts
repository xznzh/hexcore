import { describe, it, expect } from 'vitest';
import { createTtlMemo, joinCapped, truncateSegment } from '../lib/agent/context-budget';

describe('context-budget · TTL memo', () => {
  it('TTL 内复用，过期后重新加载', async () => {
    let t = 1000;
    const memo = createTtlMemo<number>(30_000, () => t);
    let calls = 0;
    const load = async () => {
      calls++;
      return calls;
    };
    expect(await memo.get('k', load)).toBe(1);
    expect(await memo.get('k', load)).toBe(1);
    expect(calls).toBe(1);

    t += 30_001; // 越过 TTL
    expect(await memo.get('k', load)).toBe(2);
    expect(calls).toBe(2);
  });

  it('并发同 key 只加载一次（缓存不能在高并发时反而放大穿透）', async () => {
    const memo = createTtlMemo<number>(30_000);
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return calls;
    };
    const [a, b, c] = await Promise.all([memo.get('k', load), memo.get('k', load), memo.get('k', load)]);
    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it('不同 key 互不干扰', async () => {
    const memo = createTtlMemo<string>(30_000);
    expect(await memo.get('u1', async () => 'a')).toBe('a');
    expect(await memo.get('u2', async () => 'b')).toBe('b');
    expect(memo.size()).toBe(2);
  });

  it('加载失败不缓存（不会把错误固化一整个 TTL）', async () => {
    const memo = createTtlMemo<number>(30_000);
    let attempt = 0;
    const load = async () => {
      attempt++;
      if (attempt === 1) throw new Error('db down');
      return attempt;
    };
    await expect(memo.get('k', load)).rejects.toThrow('db down');
    expect(await memo.get('k', load)).toBe(2);
  });
});

describe('context-budget · 清单限量', () => {
  it('空清单显式写「无」，而不是空串', () => {
    expect(joinCapped([], 10, String)).toBe('无');
  });

  it('未超限时原样拼接', () => {
    expect(joinCapped(['a', 'b'], 10, String)).toBe('a、b');
  });

  it('超限时告知总数与未列出数量（否则模型会以为看到的就是全部）', () => {
    const out = joinCapped(['a', 'b', 'c', 'd', 'e'], 2, String);
    expect(out).toContain('a、b');
    expect(out).toContain('等 5 项');
    expect(out).toContain('另有 3 项未列出');
    expect(out).not.toContain('c');
  });

  it('支持自定义渲染与分隔符', () => {
    expect(joinCapped([{ n: 1 }, { n: 2 }], 5, (x) => `#${x.n}`, ' | ')).toBe('#1 | #2');
  });
});

describe('context-budget · 段预算', () => {
  it('未超限原样返回', () => {
    expect(truncateSegment('abc', 10)).toBe('abc');
  });

  it('超限时保留头部并标注截断长度', () => {
    const out = truncateSegment('x'.repeat(100), 10, '个人快照');
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('个人快照过长');
    expect(out).toContain('90 字符');
  });

  it('空值安全', () => {
    expect(truncateSegment(null as any, 10)).toBe('');
  });
});
