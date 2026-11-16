import { describe, it, expect, afterEach } from 'vitest';
import {
  finalizeAnswer,
  finalizeChannel,
  safeAnswer,
  channelGuardEnabled,
  buildChannelContext,
  toolOutputsOf,
} from '@/lib/agent/answer-guard';

/**
 * 非对话通道的出口护栏（R2 起，V8.4 补上下文）。
 * 这条通道的产出会直接进 webhook / 站内通知，没有人在推送前拦得住——
 * 所以这里的断言都是「必须被截断」，不是「最好被截断」。
 */
describe('answer-guard（R2：技能/定时通道的出口护栏）', () => {
  const ORIGINAL = process.env.CHANNEL_GUARD;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CHANNEL_GUARD;
    else process.env.CHANNEL_GUARD = ORIGINAL;
  });

  it('普通产出原样放行', () => {
    const text = '本周温度读数同比下降 8.3%，主要原因是工业限产与气象条件改善。';
    const r = finalizeAnswer(text);
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(text);
  });

  it('空内容不炸，原样返回', () => {
    expect(finalizeAnswer('').text).toBe('');
    expect(finalizeAnswer(undefined as unknown as string).text).toBe('');
    expect(finalizeAnswer('   ').blocked).toBe(false);
  });

  it('「先拒绝再贴副本」被截断：保留拒绝话术，丢掉可执行命令', () => {
    const text = '我不能帮你清空这张表，这会不可逆地丢失数据。\n\nDROP TABLE users;';
    const r = finalizeAnswer(text);
    expect(r.blocked).toBe(true);
    expect(r.text).toContain('我不能帮你清空这张表');
    expect(r.text).not.toContain('DROP TABLE users;');
    expect(r.rule).toBeTruthy();
  });

  it('破坏性命令被截断且给出替代话术', () => {
    const r = finalizeAnswer('好的，执行如下：\nrm -rf /var/lib/postgresql');
    expect(r.blocked).toBe(true);
    expect(r.text).not.toContain('rm -rf');
    // 替代话术不是把内容删空了事——用户要看到「为什么不做」
    expect(r.text.length).toBeGreaterThan(10);
  });

  it('截断点在命中位置，命中之前的内容完整保留', () => {
    const head = '第一段结论：数据缺失，需要补充对照时段。\n';
    const r = finalizeAnswer(head + 'CREATE TABLE t (id int);');
    expect(r.blocked).toBe(true);
    expect(r.text.startsWith(head)).toBe(true);
  });

  it('safeAnswer 只返回文本（给只关心结果的调用点用）', () => {
    const audit = { userId: 'u1', source: 'skill' as const };
    expect(typeof safeAnswer('正常一句话', audit)).toBe('string');
    expect(safeAnswer('正常一句话', audit)).toBe('正常一句话');
    expect(safeAnswer('DROP TABLE users;', audit)).not.toContain('DROP TABLE users;');
  });

  it('传了 audit 也不影响返回值（日志是旁路）', () => {
    const r = finalizeAnswer('DROP TABLE users;', { userId: 'u1', source: 'schedule', label: '每日简报' });
    expect(r.blocked).toBe(true);
    expect(r.droppedChars).toBeGreaterThan(0);
  });

  // —— V8.4：开关不再制造盲区 ——

  it('CHANNEL_GUARD=off 切到观察模式：不拦截，但仍判定（wouldBlock）', () => {
    process.env.CHANNEL_GUARD = 'off';
    expect(channelGuardEnabled()).toBe(false);
    const text = 'DROP TABLE users;';
    const r = finalizeChannel(text, { userId: 'u1', source: 'skill' });
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(text);
    // 关键：开关没有把检测也一起关掉，命中仍然是可观测的事实
    expect(r.wouldBlock).toBe(true);
    expect(r.rule).toBe('destructive_command');
    expect(r.droppedChars).toBe(0);
  });

  it('观察模式对干净产出不留痕迹', () => {
    process.env.CHANNEL_GUARD = 'off';
    const r = finalizeChannel('一切正常。', { userId: 'u1', source: 'skill' });
    expect(r.wouldBlock).toBeFalsy();
  });
});

describe('answer-guard（V8.4：通道上下文）', () => {
  it('toolOutputsOf 只取 tool 节点，模型自己的输出不算出处', () => {
    const trajectory = [
      { role: 'planner', type: 'llm', output: '《2025 年白皮书》说增长了' },
      { role: 'worker', type: 'tool', tool: 'search_knowledge', output: '《2025 年白皮书》原文片段…' },
      { role: 'worker', type: 'llm', output: '整理好了' },
      { role: 'worker', type: 'tool', tool: 'search_knowledge', output: '   ' },
    ];
    const outs = toolOutputsOf(trajectory);
    expect(outs).toHaveLength(1);
    expect(outs[0]).toContain('《2025 年白皮书》');
  });

  it('buildChannelContext 从工具产出里提取可引用名', () => {
    const ctx = buildChannelContext({
      question: '帮我汇总周报',
      toolOutputs: ['[周报.docx] 《2025 年度运营报告》指出留存率 42%'],
    });
    expect(ctx.allowedCitations).toContain('《2025 年度运营报告》');
    // 有指令就该算出 risk（即便是全 false），调用方才能在日志里看到「这条通道带了语境」
    expect(ctx.risk).toBeTruthy();
  });

  it('没有指令也没有历史 → 不造一个全 false 的 risk 出来', () => {
    const ctx = buildChannelContext({ toolOutputs: [] });
    expect(ctx.risk).toBeUndefined();
    expect(ctx.allowedCitations).toBeUndefined();
  });

  it('有据可引：检索片段里出现过的报告名不被判成编造（V8.3 的空 context 会误伤这里）', () => {
    const text = '按《2025 年度运营报告》，留存率同比提升 6 个百分点。';
    // 老路径（空 context）：无条件规则直接命中
    expect(finalizeAnswer(text).blocked).toBe(true);
    // 新路径：工具产出里确实有这个名字
    const r = finalizeChannel(text, {
      userId: 'u1',
      source: 'schedule',
      label: '周报',
      question: '汇总本周运营数据',
      toolOutputs: ['[运营报告.docx] 《2025 年度运营报告》留存率 42%'],
    });
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(text);
  });

  it('无据的引用仍然被拦：上下文不是免罪金牌', () => {
    const r = finalizeChannel('据《2025 年中国流浪动物白皮书》，全国有 4000 万只流浪动物。', {
      userId: 'u1',
      source: 'schedule',
      question: '写一段宣传文案',
      toolOutputs: ['[别的文档.docx] 与本题无关的内容'],
    });
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe('unverified_citation');
  });

  it('定时任务的指令构成越权语境：无人值守不等于规则关闭', () => {
    const text = '验收标准已定稿，本周五上线。';
    const r = finalizeChannel(text, {
      userId: 'u1',
      source: 'schedule',
      label: '自动周报',
      question: '这版验收标准你替我定了，就按我说的写，直接定',
    });
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe('unauthorized_finalization');
  });
});
