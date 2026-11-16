import { describe, expect, it } from 'vitest';
import { decideRetrievalPath, type PathInput } from '@/lib/ai/retrieval-path';

/**
 * 检索路径判定的回归测试。
 *
 * 锁的目标不是「返回哪个字符串」，而是**任何一条守卫不满足都不许走快路径**。
 * 反例的代价很具体：多模型向量混算不会报错，只会让相似度失去意义——
 * 排序看起来正常，答案却开始胡说，而日志里一片祥和。
 */
const base: PathInput = {
  vectorSupported: true,
  indexedChunks: 100,
  jsonOnlyChunks: 0,
  distinctModels: 1,
  vectorDimOk: true,
};

describe('lib/ai/retrieval-path 检索路径判定', () => {
  it('条件全部满足时走 pgvector 索引排序', () => {
    const v = decideRetrievalPath(base);
    expect(v.path).toBe('pgvector');
    expect(v.reason).toContain('HNSW');
  });

  it('扩展/列不可用时走内存，且说明「功能正常只是慢」', () => {
    const v = decideRetrievalPath({ ...base, vectorSupported: false });
    expect(v.path).toBe('memory');
    expect(v.reason).toContain('功能正常');
  });

  it('扩展不可用优先于其它条件：数据再完美也不许走快路径', () => {
    // 这是最容易写反的地方——先判数据形状再判能力，就会在没有扩展时仍尝试 <=> 而报错
    const v = decideRetrievalPath({ ...base, vectorSupported: false, jsonOnlyChunks: 0 });
    expect(v.path).toBe('memory');
  });

  it('库内无向量时走内存（避免对空集做向量查询）', () => {
    const v = decideRetrievalPath({ ...base, indexedChunks: 0 });
    expect(v.path).toBe('memory');
    expect(v.reason).toContain('还没有');
  });

  it('维度不一致时走内存：查询向量与列无法比较', () => {
    const v = decideRetrievalPath({ ...base, vectorDimOk: false });
    expect(v.path).toBe('memory');
    expect(v.reason).toContain('维度');
  });

  it('存在只存 JSON 的切片时走内存：单查询向量会漏掉它们', () => {
    const v = decideRetrievalPath({ ...base, jsonOnlyChunks: 7 });
    expect(v.path).toBe('memory');
    expect(v.reason).toContain('7');
  });

  it('多模型并存时走内存：不同模型的向量不能混算', () => {
    const v = decideRetrievalPath({ ...base, distinctModels: 2 });
    expect(v.path).toBe('memory');
    expect(v.reason).toContain('2');
  });

  it('每个拒绝分支都给出可读原因，不能返回空字符串让诊断页抓瞎', () => {
    const cases: PathInput[] = [
      { ...base, vectorSupported: false },
      { ...base, indexedChunks: 0 },
      { ...base, vectorDimOk: false },
      { ...base, jsonOnlyChunks: 3 },
      { ...base, distinctModels: 3 },
      base,
    ];
    for (const c of cases) {
      const v = decideRetrievalPath(c);
      expect(v.reason.length).toBeGreaterThan(6);
      expect(['pgvector', 'memory']).toContain(v.path);
    }
  });
});
