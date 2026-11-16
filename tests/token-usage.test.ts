import { describe, expect, it } from 'vitest';
import { readTokenUsage } from '../lib/agent/token-usage';

/**
 * 这个模块存在的唯一理由是「字段名跨 SDK 版本不一致」：
 * v3/v4 用 promptTokens/completionTokens，v5 改成 inputTokens/outputTokens。
 * 读错名不会报错，只会让输入/输出长期为 null，而页面上的金额看起来仍然"有数"。
 */
describe('readTokenUsage', () => {
  it('v4 形态：promptTokens / completionTokens / totalTokens', () => {
    expect(readTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 })).toEqual({
      total: 150,
      prompt: 100,
      completion: 50,
    });
  });

  it('v5 形态：inputTokens / outputTokens（没有 totalTokens 时相加）', () => {
    expect(readTokenUsage({ inputTokens: 200, outputTokens: 80 })).toEqual({
      total: 280,
      prompt: 200,
      completion: 80,
    });
  });

  it('同时存在两套字段时优先 v4 名（本项目 SDK 版本是 v4 语义）', () => {
    const u = readTokenUsage({ promptTokens: 10, completionTokens: 5, inputTokens: 999, outputTokens: 999 });
    expect(u.prompt).toBe(10);
    expect(u.completion).toBe(5);
  });

  it('只有 totalTokens 时不编造拆分（拆不出来就该是 undefined）', () => {
    expect(readTokenUsage({ totalTokens: 300 })).toEqual({ total: 300, prompt: undefined, completion: undefined });
  });

  it('streamText 的 usage 是 Promise：读不到同步属性，返回空对象且不抛', () => {
    const thenable = { then: () => undefined, promptTokens: 999 };
    expect(readTokenUsage(thenable)).toEqual({});
  });

  it('null / undefined / 字符串 / 数组 都安全返回空对象', () => {
    for (const v of [null, undefined, 'usage', 42, []]) {
      expect(readTokenUsage(v)).toEqual({});
    }
  });

  it('非法数字（NaN / Infinity / 负数）当缺失处理，不写进日志', () => {
    expect(readTokenUsage({ promptTokens: NaN, completionTokens: -1 }).prompt).toBeUndefined();
    expect(readTokenUsage({ promptTokens: NaN, completionTokens: -1 }).completion).toBeUndefined();
    expect(readTokenUsage({ totalTokens: Infinity }).total).toBeUndefined();
  });

  it('0 是合法值（缓存命中时 prompt 可能为 0），不能当成缺失', () => {
    expect(readTokenUsage({ promptTokens: 0, completionTokens: 0 }).total).toBe(0);
  });
});
