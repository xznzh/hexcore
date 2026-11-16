import { describe, expect, it } from 'vitest';
import { parseRerankResponse } from '@/lib/ai/rerank';

/**
 * rerank 的响应解析（纯函数，无网络）。
 *
 * 这里只测「解析」，不测「调用」：调用真实 rerank 端点需要 Key，属于部署侧验证。
 * 解析必须严，因为越界 index 不会抛异常——它会静默取到 undefined 或错位文档，
 * 表现为「检索结果莫名其妙排序不对」，是最难定位的一类问题。
 */
describe('parseRerankResponse', () => {
  it('解析标准 Jina / Cohere 格式', () => {
    const r = parseRerankResponse(
      {
        results: [
          { index: 2, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.42 },
        ],
      },
      3,
    );
    expect(r).toEqual([
      { index: 2, score: 0.91 },
      { index: 0, score: 0.42 },
    ]);
  });

  it('兼容用 score 字段的网关', () => {
    const r = parseRerankResponse({ results: [{ index: 1, score: 0.7 }] }, 2);
    expect(r).toEqual([{ index: 1, score: 0.7 }]);
  });

  it('越界 index 被丢弃（不能静默取到错位文档）', () => {
    const r = parseRerankResponse(
      {
        results: [
          { index: 5, relevance_score: 0.9 },
          { index: -1, relevance_score: 0.8 },
          { index: 1, relevance_score: 0.6 },
        ],
      },
      3,
    );
    expect(r).toEqual([{ index: 1, score: 0.6 }]);
  });

  it('非数字分数被丢弃', () => {
    const r = parseRerankResponse(
      { results: [{ index: 0, relevance_score: 'high' }, { index: 1, relevance_score: 0.5 }] },
      2,
    );
    expect(r).toEqual([{ index: 1, score: 0.5 }]);
  });

  it('结构不符时返回空数组，而不是抛异常', () => {
    expect(parseRerankResponse(null, 3)).toEqual([]);
    expect(parseRerankResponse({}, 3)).toEqual([]);
    expect(parseRerankResponse({ results: 'nope' }, 3)).toEqual([]);
  });
});
