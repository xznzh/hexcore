import { describe, expect, it } from 'vitest';
import {
  pickEmbeddingModel,
  orderEmbeddingCandidates,
  localVector,
  isMinimaxEmbedding,
  normalizeEmbeddingRef,
  isAutoEmbeddingRef,
  pickCandidateByRef,
  prioritizeCandidate,
  EMBED_DIM,
} from '@/lib/ai/embed';

type Cand = {
  id: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  apiKey: string;
  isDefault: boolean;
  enabled: boolean;
};

const c = (o: Partial<Cand> & { id: string }): Cand => ({
  id: o.id,
  provider: o.provider ?? 'openai',
  name: o.name ?? o.id,
  baseUrl: o.baseUrl ?? 'https://api.openai.com/v1',
  apiKey: o.apiKey ?? '',
  isDefault: o.isDefault ?? false,
  enabled: o.enabled ?? true,
});

describe('lib/ai/embed 向量模型选择', () => {
  it('没有配置 Key 时返回 null（走本地降级，不乱用空占位）', () => {
    const picked = pickEmbeddingModel([
      c({ id: 'm_ollama_nomic_embed' }),
      c({ id: 'm_openai_embed' }),
    ]);
    expect(picked).toBeNull();
  });

  it('多个候选时选中「已配置 Key」的那个，而不是排序靠前的空占位', () => {
    const picked = pickEmbeddingModel([
      c({ id: 'm_ollama_nomic_embed' }),
      c({ id: 'm_zhipu_embedding3', apiKey: 'key-abc' }),
    ]);
    expect(picked?.id).toBe('m_zhipu_embedding3');
  });

  it('多个都配了 Key 时优先 isDefault 的那个', () => {
    const picked = pickEmbeddingModel([
      c({ id: 'a', apiKey: 'k1' }),
      c({ id: 'b', apiKey: 'k2', isDefault: true }),
    ]);
    expect(picked?.id).toBe('b');
  });

  it('已停用的模型不参与选择', () => {
    const picked = pickEmbeddingModel([
      c({ id: 'off', apiKey: 'k1', enabled: false }),
      c({ id: 'on', apiKey: 'k2' }),
    ]);
    expect(picked?.id).toBe('on');
  });

  it('候选链去掉无 Key / 停用项，默认模型排最前，其余保持配置顺序', () => {
    const chain = orderEmbeddingCandidates([
      c({ id: 'no-key' }),
      c({ id: 'a', apiKey: 'k1' }),
      c({ id: 'off', apiKey: 'k2', enabled: false }),
      c({ id: 'def', apiKey: 'k3', isDefault: true }),
      c({ id: 'b', apiKey: 'k4' }),
    ]);
    expect(chain.map((x) => x.id)).toEqual(['def', 'a', 'b']);
  });

  it('没有 Key 时候选链为空（整体走本地降级）', () => {
    expect(orderEmbeddingCandidates([c({ id: 'a' }), c({ id: 'b' })])).toEqual([]);
  });

  it('本地降级向量是 384 维且同文本结果一致', () => {
    const a = localVector('设备状态监测');
    const b = localVector('设备状态监测');
    expect(a.length).toBe(EMBED_DIM);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe('知识库向量模型引用', () => {
  const cands = [c({ id: 'm_a', name: 'model-a', apiKey: 'k1' }), c({ id: 'm_b', name: 'model-b', apiKey: 'k2' })];

  it('空值 / 历史占位 lexical 归一为自动', () => {
    expect(normalizeEmbeddingRef(null)).toBe('auto');
    expect(normalizeEmbeddingRef('')).toBe('auto');
    expect(normalizeEmbeddingRef('  ')).toBe('auto');
    expect(normalizeEmbeddingRef('LEXICAL')).toBe('auto');
    expect(isAutoEmbeddingRef(undefined)).toBe(true);
  });

  it('保留具体模型 id 与 local 降级标记', () => {
    expect(normalizeEmbeddingRef('m_a')).toBe('m_a');
    expect(normalizeEmbeddingRef('local')).toBe('local');
  });

  it('按 id 优先、再按名称匹配，auto 不匹配任何模型', () => {
    expect(pickCandidateByRef(cands, 'm_b')?.id).toBe('m_b');
    expect(pickCandidateByRef(cands, 'model-a')?.id).toBe('m_a');
    expect(pickCandidateByRef(cands, 'auto')).toBeNull();
    expect(pickCandidateByRef(cands, 'missing')).toBeNull();
  });

  it('把指定模型提到候选链最前，未配置时保持原链', () => {
    expect(prioritizeCandidate(cands, 'm_b').map((x) => x.id)).toEqual(['m_b', 'm_a']);
    expect(prioritizeCandidate(cands, 'auto').map((x) => x.id)).toEqual(['m_a', 'm_b']);
    expect(prioritizeCandidate(cands, 'missing').map((x) => x.id)).toEqual(['m_a', 'm_b']);
  });
});

describe('MiniMax 向量协议识别', () => {
  it('按 provider 识别 MiniMax', () => {
    expect(isMinimaxEmbedding({ provider: 'minimax', baseUrl: null })).toBe(true);
  });

  it('按 baseUrl 识别 MiniMax（大小写不敏感）', () => {
    expect(isMinimaxEmbedding({ provider: 'openai-compatible', baseUrl: 'https://API.MiniMax.cn/v1' })).toBe(true);
  });

  it('普通 OpenAI 兼容端点不做 MiniMax 适配', () => {
    expect(isMinimaxEmbedding({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isMinimaxEmbedding({ provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toBe(false);
  });
});
