import { describe, expect, it } from 'vitest';
import { parseVerdictStrict, stripCodeFence, verdictRepairPrompt } from '@/lib/agent/verdict';

/**
 * Critic 判定是「要不要返工」的开关，这里锁住的核心是**回归 bug**：
 * 旧实现用 `/通过|pass/` 正则兜底，模型说「不能通过，缺少数据」会被判成 pass，
 * 校验形同虚设。现在必须只认严格 JSON，解析不了就 fail-closed。
 */
describe('lib/agent/verdict 结构化判定', () => {
  it('纯 JSON 正常解析', () => {
    const r = parseVerdictStrict('{"verdict":"pass","reason":"覆盖了全部要点"}');
    expect(r.ok).toBe(true);
    expect(r.value?.verdict).toBe('pass');
    expect(r.value?.reason).toContain('要点');
  });

  it('剥掉 ```json 围栏后仍可解析（模型最常见的多余包装）', () => {
    const r = parseVerdictStrict('```json\n{"verdict":"fail","reason":"缺少数据来源"}\n```');
    expect(r.ok).toBe(true);
    expect(r.value?.verdict).toBe('fail');
  });

  it('散文里夹 JSON 视为不合格（不允许正则抠取）', () => {
    const r = parseVerdictStrict('我认为这个结果 {"verdict":"pass"} 是可以通过的');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/纯 JSON/);
  });

  it('自然语言「不能通过」不会被误判为 pass', () => {
    const r = parseVerdictStrict('这个方案不能通过，因为缺少关键数据。');
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
  });

  it('verdict 取值非法时报字段错误', () => {
    const r = parseVerdictStrict('{"verdict":"maybe"}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verdict/);
  });

  it('空输出 / 坏 JSON 都 fail-closed', () => {
    expect(parseVerdictStrict('').ok).toBe(false);
    expect(parseVerdictStrict('{verdict:pass}').ok).toBe(false);
  });

  it('可选字段（score / issues）在合法范围内被接受', () => {
    const r = parseVerdictStrict('{"verdict":"fail","reason":"数值缺失","score":0.2,"issues":["缺少 2025 年数据"]}');
    expect(r.ok).toBe(true);
    expect(r.value?.score).toBe(0.2);
    expect(r.value?.issues?.[0]).toContain('2025');
  });

  it('stripCodeFence 不影响普通文本', () => {
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('修正提示会带上具体错误原因与上次输出', () => {
    const p = verdictRepairPrompt('我不能通过', '输出不是纯 JSON 对象');
    expect(p).toContain('输出不是纯 JSON 对象');
    expect(p).toContain('我不能通过');
    expect(p).toContain('"verdict"');
  });
});
