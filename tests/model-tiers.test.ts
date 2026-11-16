import { describe, it, expect } from 'vitest';
import { decideAssignment, pickCheapest, isTieringEnabled, DEGRADABLE_TASKS } from '../lib/agent/model-tiers';

const CANDIDATES = [
  { id: 'gpt-4o', priceIn: 30, priceOut: 60 },
  { id: 'gpt-4o-mini', priceIn: 1, priceOut: 2 },
  { id: 'qwen-turbo', priceIn: 0.3, priceOut: 0.6 },
  { id: 'local-7b', priceIn: 0, priceOut: 0 }, // 本地部署：无价格数据
];

describe('model-tiers · 白名单', () => {
  it('chat 不在可降档白名单里（主线质量不参与降档）', () => {
    expect(DEGRADABLE_TASKS.has('chat')).toBe(false);
    expect(DEGRADABLE_TASKS.has('memory-extract')).toBe(true);
  });

  it('chat 任务永远返回主模型，即使有便宜档', () => {
    const a = decideAssignment('chat', 'gpt-4o', CANDIDATES, {});
    expect(a.tier).toBe('primary');
    expect(a.modelId).toBeNull();
  });
});

describe('model-tiers · 选档', () => {
  it('可降档任务挑最便宜的（按 3:1 加权，排除无价格数据与主模型）', () => {
    const a = decideAssignment('summary', 'gpt-4o', CANDIDATES, {});
    expect(a.tier).toBe('cheap');
    // qwen-turbo: 0.3*3+0.6 = 1.5，低于 gpt-4o-mini 的 5
    expect(a.modelId).toBe('qwen-turbo');
  });

  it('主模型恰好是最便宜时不选自己（否则是假降档）', () => {
    const a = decideAssignment('summary', 'qwen-turbo', CANDIDATES, {});
    expect(a.modelId).toBe('gpt-4o-mini');
  });

  it('候选全无价格数据时不猜，回退主模型并说明原因', () => {
    const a = decideAssignment('summary', 'x', [{ id: 'local-7b', priceIn: 0, priceOut: 0 }], {});
    expect(a.tier).toBe('primary');
    expect(a.reason).toContain('no-cheap-model');
  });

  it('MODEL_TIERING=off 一键全回退', () => {
    expect(isTieringEnabled({ MODEL_TIERING: 'off' })).toBe(false);
    expect(isTieringEnabled({ MODEL_TIERING: 'OFF' })).toBe(false);
    expect(isTieringEnabled({})).toBe(true);
    const a = decideAssignment('summary', 'gpt-4o', CANDIDATES, { MODEL_TIERING: 'off' });
    expect(a.tier).toBe('primary');
  });

  it('同价时结果稳定（按 id 排序，不随数组顺序变）', () => {
    const tie = [
      { id: 'b-model', priceIn: 1, priceOut: 1 },
      { id: 'a-model', priceIn: 1, priceOut: 1 },
    ];
    expect(pickCheapest(tie, 'primary')?.id).toBe('a-model');
    expect(pickCheapest([...tie].reverse(), 'primary')?.id).toBe('a-model');
  });
});

describe('model-tiers · 环境变量覆盖', () => {
  it('MODEL_CHEAP_ID 指定档位优先于按价格挑选', () => {
    const a = decideAssignment('summary', 'gpt-4o', CANDIDATES, { MODEL_CHEAP_ID: 'gpt-4o-mini' });
    expect(a.modelId).toBe('gpt-4o-mini');
    expect(a.reason).toContain('MODEL_CHEAP_ID');
  });

  it('指向不存在的模型时忽略，不被坏配置打挂', () => {
    const a = decideAssignment('summary', 'gpt-4o', CANDIDATES, { MODEL_CHEAP_ID: 'ghost' });
    expect(a.modelId).toBe('qwen-turbo');
  });

  it('任务级覆盖（MODEL_TIER_MEMORY_EXTRACT）优先于全局', () => {
    const a = decideAssignment('memory-extract', 'gpt-4o', CANDIDATES, {
      MODEL_CHEAP_ID: 'gpt-4o-mini',
      MODEL_TIER_MEMORY_EXTRACT: 'qwen-turbo',
    });
    expect(a.modelId).toBe('qwen-turbo');
    expect(a.reason).toContain('MODEL_TIER_MEMORY_EXTRACT');
  });
});
