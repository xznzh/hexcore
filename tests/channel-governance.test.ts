import { describe, expect, it } from 'vitest';
import { governChannelAnswer } from '@/lib/agent/channel-governance';

/**
 * 统一治理出口（V8.22）。
 *
 * 这里不重复测护栏规则本身（那在 `answer-guard.test.ts` / `channel-verify` 的测试里），
 * 只锁三件「门面必须保住」的事：
 *  1. 干净文本原样返回，且不被误判；
 *  2. 通道上下文（question / trajectory）确实被带进去了——这是 V8.4 的教训，
 *     空 context 会把「照文档引用」误判成编造；
 *  3. 拦截结果**显式返回**（`blocked` + `rule`），调用方才有机会告诉用户被截断过。
 */
describe('lib/agent/channel-governance', () => {
  const base = { userId: 'u1', source: 'skill' as const, label: '周报技能', question: '汇总本周运营数据' };

  it('干净文本原样通过', () => {
    const text = '本周新增用户 1200，留存率 42%。';
    const r = governChannelAnswer(text, { ...base, trajectory: [] });
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(text);
  });

  it('轨迹里的出处让引用合法（证明上下文真的传到了护栏）', () => {
    const text = '按《2025 年度运营报告》，留存率同比提升 6 个百分点。';
    const r = governChannelAnswer(text, {
      ...base,
      trajectory: [{ type: 'tool', tool: 'kb_search', output: '[运营报告.docx] 《2025 年度运营报告》留存率 42%' }],
    });
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(text);
  });

  it('无据的引用被拦，并把 rule 交回调用方', () => {
    const r = governChannelAnswer('据《2025 年中国流浪动物白皮书》，全国有 4000 万只流浪动物。', {
      ...base,
      question: '写一段宣传文案',
      trajectory: [{ type: 'tool', tool: 'kb_search', output: '[无关文档.docx] 与本题无关' }],
    });
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe('unverified_citation');
    // 拦截后的文本必须与原文不同，否则「拦了」这件事在外发内容上看不出来
    expect(r.text).not.toContain('4000 万只流浪动物');
  });

  it('空产出原样通过（不算「被拦截」；空产出的判定归审计层的 empty_answer）', () => {
    // 这两件事必须分开：空产出不是「不安全」，把 empty 记成 blocked 会让
    // 「模型没产出」和「护栏掐掉了」在日志里变成同一件事，排查时无从区分。
    const r = governChannelAnswer('', { ...base, trajectory: [] });
    expect(r.blocked).toBe(false);
    expect(r.text).toBe('');
  });
});
