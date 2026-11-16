import { describe, expect, it, vi } from 'vitest';

/**
 * 检索范围的安全默认（V8.3 · R6）。
 *
 * 锁的是什么：`retrieve()` 对「范围为空」的处理，必须是 **fail-closed**（查不到），
 * 而不是 fail-open（不加过滤 = 全库扫描）。
 *
 * 为什么这条值得单独锁：这是个**静默**的越权。调用方按权限算出 visibleKbIds，
 * 若结果为空（新用户、只有别人的库），旧实现的 `kbIds.length ? 过滤 : 不过滤`
 * 会走 else 分支 —— 一条过滤条件都不加，把全站所有人的个人库片段捞进 prompt。
 * 没有报错、没有日志、测试全绿，只有「这个用户怎么知道别人的文档」这种偶然发现。
 *
 * db 替身故意一用就抛错：只要实现退回 fail-open（哪怕只多走一步查询），
 * 用例会直接炸在「不该触库」而不是悄悄通过。
 */
vi.mock('@/lib/db', () => {
  const boom = () => {
    throw new Error('不该触库：空范围必须在查询前返回');
  };
  const chain: any = new Proxy(
    {},
    {
      get: () => boom,
    },
  );
  return { db: chain, ensureInit: async () => {} };
});

vi.mock('@/lib/ai/embed', () => ({
  embedText: async () => [],
  embedTextsDetailed: async () => ({ vectors: [], modelId: 'mock' }),
  cosine: () => 0,
  isAutoEmbeddingRef: () => true,
  normalizeEmbeddingRef: (x: string) => x,
}));

import { retrieve } from '@/lib/ai/rag';

describe('retrieve 的范围语义（安全默认）', () => {
  it('显式空数组 → 返回空，且不触库', async () => {
    await expect(retrieve('任意问题', 4, [])).resolves.toEqual([]);
  });

  it('全为空串的数组同样按「无可见库」处理', async () => {
    await expect(retrieve('任意问题', 4, [''])).resolves.toEqual([]);
  });

  it('字符串形态传空也返回空（单库入口同样适用）', async () => {
    await expect(retrieve('任意问题', 4, '')).resolves.toEqual([]);
  });
});
