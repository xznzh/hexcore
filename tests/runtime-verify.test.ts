import { describe, expect, it } from 'vitest';
import { summarizeVerify, verifyAnswer } from '@/lib/agent/runtime-verify';

describe('lib/agent/runtime-verify 运行时 V 层', () => {
  it('正常回答通过，score 为 1', () => {
    const r = verifyAnswer({ answer: '北京今天多云，气温 18℃。' });
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.score).toBe(1);
  });

  it('空回答判定为 block', () => {
    const r = verifyAnswer({ answer: '   ' });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('empty_answer');
  });

  it('「模型未返回内容」话术判定为 block', () => {
    const r = verifyAnswer({ answer: '（模型未返回内容，请检查模型配置或稍后重试）' });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('model_empty_note');
  });

  it('残留模板变量给出 warn（不阻断）', () => {
    const r = verifyAnswer({ answer: '结果：{{prev}} 已完成' });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.rule)).toContain('template_placeholder');
    expect(r.score).toBeLessThan(1);
  });

  it('列了来源但当轮无来源 → 伪造来源 block', () => {
    const r = verifyAnswer({ answer: '结论如下。\n\n---\n\n📚 **参考来源**\n1. 某文档.pdf', sources: [] });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('fabricated_source');
  });

  it('列了来源且确有来源 → 通过', () => {
    const r = verifyAnswer({ answer: '结论如下。\n\n---\n\n📚 **参考来源**\n1. 某文档.pdf', sources: ['某文档.pdf'] });
    expect(r.ok).toBe(true);
  });

  it('声称使用能力但轨迹无对应调用 → warn', () => {
    const r = verifyAnswer({ answer: '已使用能力：天气查询\n今天晴。', trace: [] });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.rule)).toContain('ungrounded_capability');
  });

  it('声称使用能力且轨迹有 invoke_capability → 不告警', () => {
    const r = verifyAnswer({
      answer: '已使用能力：天气查询\n今天晴。',
      trace: [{ type: 'tool_call', name: 'invoke_capability' }],
    });
    expect(r.issues.map((i) => i.rule)).not.toContain('ungrounded_capability');
  });

  it('含可直接复制的破坏性 SQL → block', () => {
    const r = verifyAnswer({ answer: '你可以执行：DROP TABLE users;' });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('dangerous_copyable');
  });

  it('复用 guardrails.checkOutput 捕获密钥泄露', () => {
    const r = verifyAnswer({ answer: '这是 Key：sk-abcdefgh12345678' });
    expect(r.issues.some((i) => i.rule === 'output_secret_leak')).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('summarizeVerify 无问题返回 pass，有问题给出规则摘要', () => {
    expect(summarizeVerify(verifyAnswer({ answer: '好' }))).toBe('pass');
    expect(summarizeVerify(verifyAnswer({ answer: '' }))).toContain('empty_answer');
  });
});
