import { describe, it, expect, afterEach } from 'vitest';
import {
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_STEPS,
  MAX_SAME_TOOL_CALLS,
  MAX_IDENTICAL_CALLS,
  toolDiscipline,
  historyTokenBudget,
} from '@/lib/agent/turn-limits';

describe('turn-limits（O2：三处字面量的单一真相源）', () => {
  it('派生关系成立（锁关系，不锁数值）', () => {
    // 改基准值时下面全部跟着走，测试不会因为「不等于 5」而报错；
    // 但一旦有人手改某一个常量、破坏派生关系，就会立刻失败。
    expect(MAX_TOOL_STEPS).toBe(MAX_TOOL_CALLS_PER_TURN + 2);
    expect(MAX_SAME_TOOL_CALLS).toBe(MAX_TOOL_CALLS_PER_TURN + 1);
    expect(MAX_IDENTICAL_CALLS).toBe(1);

    // 语义约束：执行层的单工具上限不能低于提示词承诺的次数，
    // 否则模型按提示词调第 3 次会被执行层拦掉，表现为「工具没反应」。
    expect(MAX_SAME_TOOL_CALLS).toBeGreaterThanOrEqual(MAX_TOOL_CALLS_PER_TURN);
    // 总步数必须留出正文步：全是工具步的话，最后那段正文没机会生成
    expect(MAX_TOOL_STEPS).toBeGreaterThan(MAX_SAME_TOOL_CALLS);
  });

  it('提示词里的数字来自常量，不另写一份', () => {
    const text = toolDiscipline();
    expect(text).toContain(`最多调用 ${MAX_TOOL_CALLS_PER_TURN} 次工具`);
    expect(text).toContain(`第 ${MAX_TOOL_CALLS_PER_TURN} 次工具调用后`);

    const custom = toolDiscipline(7);
    expect(custom).toContain('最多调用 7 次工具');
    expect(custom).not.toContain('最多调用 3 次工具');
  });

  it('提示词保留全部硬约束条目（防被「文案优化」删条）', () => {
    const text = toolDiscipline();
    expect(text).toContain('必须立即停止调用工具');
    expect(text).toContain('只输出工具调用而不输出文字是不允许的');
    expect(text).toContain('简体中文');
  });

  it('历史预算随上下文伸缩，大模型不会比小模型更低', () => {
    // 8k 模型：兜底 6000（不是 8k×0.15=1229）—— `min` 写法在这里会导致倒退
    expect(historyTokenBudget(8000, {})).toBe(6000);
    // 128k 模型：显著高于 6000
    const big = historyTokenBudget(131072, {});
    expect(big).toBeGreaterThan(6000);
    expect(big).toBe(Math.min(30_000, Math.floor(131072 * 0.15)));
    // 超大上下文也不会无限放大（历史是每轮全价重算的部分）
    expect(historyTokenBudget(2_000_000, {})).toBe(30_000);
  });

  it('historyTokenBudget 的 env 覆盖与非法值', () => {
    expect(historyTokenBudget(8000, { CHAT_HISTORY_TOKEN_BUDGET: '1234' })).toBe(1234);
    expect(historyTokenBudget(8000, { CHAT_HISTORY_TOKEN_BUDGET: 'abc' })).toBe(6000);
    expect(historyTokenBudget(8000, { CHAT_HISTORY_TOKEN_BUDGET: '0' })).toBe(6000);
    expect(historyTokenBudget(8000, { CHAT_HISTORY_TOKEN_BUDGET: '' })).toBe(6000);
  });

  describe('默认 env（不传参时读 process.env）', () => {
    const ORIGINAL = process.env.CHAT_HISTORY_TOKEN_BUDGET;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.CHAT_HISTORY_TOKEN_BUDGET;
      else process.env.CHAT_HISTORY_TOKEN_BUDGET = ORIGINAL;
    });

    it('未配置时走模型推导', () => {
      delete process.env.CHAT_HISTORY_TOKEN_BUDGET;
      expect(historyTokenBudget(0)).toBe(6000);
      expect(historyTokenBudget(32000)).toBe(6000);
      expect(historyTokenBudget(100000)).toBe(15_000);
    });
  });
});
