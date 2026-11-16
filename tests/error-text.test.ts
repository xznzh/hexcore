import { describe, expect, it } from 'vitest';
import { explainModelError, userFacingModelError } from '@/lib/ai/error-text';

/**
 * 模型报错翻译层的回归测试。
 *
 * 这层的价值不在于「文案好看」，而在于三条硬要求：
 *  1. 任何上游原文都不能带着英文栈、密钥、内网地址直接进用户气泡；
 *  2. 常见故障必须能被归到确定的类别（否则用户拿不到可执行的下一步）；
 *  3. 归类失败的兜底也要说人话，而不是把 JSON 打印出来。
 */
describe('lib/ai/error-text 模型报错归类', () => {
  it('SDK 的多次重试失败归为「连不上」', () => {
    const r = explainModelError(
      'Failed after 3 attempts. Last error: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434',
    );
    expect(r.kind).toBe('connect');
    expect(r.message).toContain('连不上模型服务');
    // 不能把原始英文塞回去
    expect(r.message).not.toContain('ECONNREFUSED');
  });

  it('401 / 无效 Key 归为鉴权失败', () => {
    expect(explainModelError('401 Incorrect API key provided: sk-abc123').kind).toBe('auth');
    expect(explainModelError('{"error":{"message":"Invalid API key"}}').kind).toBe('auth');
  });

  it('429 归为限流或额度问题', () => {
    expect(explainModelError('429 rate limit exceeded, please retry later').kind).toBe('rate_limit');
    expect(explainModelError('insufficient_quota: 余额不足').kind).toBe('rate_limit');
  });

  it('模型名不存在单独成一类', () => {
    expect(explainModelError('404 model_not_found: The model `gpt-9` does not exist').kind).toBe('model_missing');
  });

  it('上下文超限不会被误判成普通失败', () => {
    expect(explainModelError("maximum context length is 8192 tokens, but you requested 9000").kind).toBe(
      'context_overflow',
    );
  });

  it('超时单独成一类，且提示可以重发', () => {
    const r = explainModelError('ETIMEDOUT: socket timeout after 90000ms');
    expect(r.kind).toBe('timeout');
    expect(r.message).toContain('重发');
  });

  it('未知错误兜底仍要说人话，并截断过长原文', () => {
    const r = explainModelError('something exploded ' + 'x'.repeat(500));
    expect(r.kind).toBe('unknown');
    expect(r.message.startsWith('模型调用失败：')).toBe(true);
    expect(r.message.length).toBeLessThan(200);
  });

  it('空错误也能给出可读结果', () => {
    expect(userFacingModelError('')).toBe('模型调用失败，且未返回具体原因。');
    expect(userFacingModelError(undefined)).toBe('模型调用失败，且未返回具体原因。');
  });

  it('错误原文里的疑似密钥会被脱敏后再展示', () => {
    const r = explainModelError('upstream said: Authorization: Bearer sk-abcdef1234567890abcdef');
    expect(r.message).not.toContain('sk-abcdef1234567890abcdef');
  });
});
