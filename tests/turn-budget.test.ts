import { describe, it, expect, afterEach } from 'vitest';
import { createTurnBudget, turnBudgetFromEnv } from '@/lib/agent/turn-budget';

describe('turn-budget', () => {
  const ORIGINAL = process.env.CHAT_TURN_TOKEN_BUDGET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CHAT_TURN_TOKEN_BUDGET;
    else process.env.CHAT_TURN_TOKEN_BUDGET = ORIGINAL;
  });

  it('按步累加，超过上限才触发（恰好等于上限不算超）', () => {
    const b = createTurnBudget(100);
    expect(b.add(60)).toBe(false);
    expect(b.add(40)).toBe(false); // 恰好 100，不应中止
    expect(b.used()).toBe(100);
    expect(b.add(1)).toBe(true);
    expect(b.used()).toBe(101);
  });

  it('limit=0 表示不限制，永远不会中止', () => {
    const b = createTurnBudget(0);
    expect(b.add(1_000_000)).toBe(false);
    expect(b.used()).toBe(1_000_000);
  });

  it('非法输入不计入累计，避免把预算算成 NaN 后永不触发', () => {
    const b = createTurnBudget(100);
    expect(b.add(Number.NaN)).toBe(false);
    expect(b.add(-5)).toBe(false);
    expect(b.add('abc' as unknown as number)).toBe(false);
    expect(b.add(undefined as unknown as number)).toBe(false);
    expect(b.used()).toBe(0);
  });

  it('默认 6 万，可被环境变量覆盖；非法值回退默认', () => {
    delete process.env.CHAT_TURN_TOKEN_BUDGET;
    expect(turnBudgetFromEnv()).toBe(60_000);

    process.env.CHAT_TURN_TOKEN_BUDGET = '1000';
    expect(turnBudgetFromEnv()).toBe(1000);

    process.env.CHAT_TURN_TOKEN_BUDGET = '0'; // 显式关闭
    expect(turnBudgetFromEnv()).toBe(0);

    process.env.CHAT_TURN_TOKEN_BUDGET = 'abc';
    expect(turnBudgetFromEnv()).toBe(60_000);
  });
});
