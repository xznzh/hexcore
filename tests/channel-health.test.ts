import { describe, expect, it } from 'vitest';
import {
  aggregateChannelHealth,
  parseChannelRecord,
  type ChannelHealthLogRow,
} from '@/lib/agent/channel-health';

/**
 * 这个文件锁的是**日志文本格式**。
 *
 * 聚合依赖解析 `detail`，而 detail 由 `summarizeVerify` / `recordChannelVerify` /
 * `auditBlock` 三处拼出来。任何一处改了写法，这里就该变红——
 * 否则表现是「健康度页面显示 0 个问题」，看起来像质量变好了。
 */
describe('parseChannelRecord 解析 detail 文本', () => {
  it('非对话通道：剥掉 trace 前缀，取出通道/标签/规则', () => {
    const p = parseChannelRecord({
      action: 'eval_runtime',
      target: 'fail',
      detail: '[trace:abc123] channel · skill/周报技能 · block:empty_answer(最终回答为空)',
      createdAt: 1,
    });
    expect(p).toEqual({
      channel: 'skill',
      label: '周报技能',
      observe: false,
      issues: [{ severity: 'block', rule: 'empty_answer' }],
    });
  });

  it('对话通道：没有 channel 前缀，归为 chat', () => {
    const p = parseChannelRecord({
      action: 'eval_runtime',
      target: 'pass_with_warn',
      detail: 'warn:ungrounded_capability(回答声称使用能力「天气查询」，但轨迹中无对应工具调用)',
      createdAt: 1,
    });
    expect(p?.channel).toBe('chat');
    expect(p?.label).toBe('');
    expect(p?.issues).toEqual([{ severity: 'warn', rule: 'ungrounded_capability' }]);
  });

  it('多规则：同一行的两条 issue 都要取到', () => {
    const p = parseChannelRecord({
      action: 'eval_runtime',
      detail: 'channel · schedule/每日简报 · warn:template_placeholder(残留 {{prev}}) | block:fabricated_source(无来源)',
      createdAt: 1,
    });
    expect(p?.issues).toEqual([
      { severity: 'warn', rule: 'template_placeholder' },
      { severity: 'block', rule: 'fabricated_source' },
    ]);
  });

  it('issue 原因里含 ` | ` 时不会多出 unknown 规则', () => {
    // summarizeVerify 会把 detail 原样括进括号里，而 detail 可能自带分隔符
    const p = parseChannelRecord({
      action: 'eval_runtime',
      detail: 'channel · skill/清洗 · block:dangerous_copyable(命令 A | 命令 B)',
      createdAt: 1,
    });
    expect(p?.issues).toEqual([{ severity: 'block', rule: 'dangerous_copyable' }]);
  });

  it('标签本身带斜杠时只按第一个斜杠切', () => {
    const p = parseChannelRecord({
      action: 'eval_runtime',
      detail: 'channel · skill/日报 / 周报 · block:empty_answer(x)',
      createdAt: 1,
    });
    expect(p?.channel).toBe('skill');
    expect(p?.label).toBe('日报 / 周报');
  });

  it('出口护栏记录：规则在 target 列，观察模式要被标出来', () => {
    const normal = parseChannelRecord({
      action: 'guardrail_output_block',
      target: 'dangerous_copyable',
      detail: 'skill/周报技能 · 命中可直接复制执行的破坏性命令',
      createdAt: 1,
    });
    expect(normal).toEqual({
      channel: 'skill',
      label: '周报技能',
      observe: false,
      issues: [{ severity: 'block', rule: 'dangerous_copyable' }],
    });

    const observe = parseChannelRecord({
      action: 'guardrail_output_block',
      target: 'dangerous_copyable',
      detail: 'observe · schedule/每周汇总 · 命中可直接复制执行的破坏性命令',
      createdAt: 1,
    });
    expect(observe?.channel).toBe('schedule');
    expect(observe?.label).toBe('每周汇总');
    expect(observe?.observe).toBe(true);
  });

  it('认不出的格式返回 null，而不是猜一个通道', () => {
    // 有前缀但没有分隔符：格式已经变了
    expect(parseChannelRecord({ action: 'eval_runtime', detail: 'channel · skill/x', createdAt: 1 })).toBeNull();
    // 少了 channel 前缀的技能记录：不猜成 chat
    expect(parseChannelRecord({ action: 'eval_runtime', detail: 'skill/x · block:empty_answer(x)', createdAt: 1 })).toBeNull();
    // 空 detail
    expect(parseChannelRecord({ action: 'eval_runtime', detail: '   ', createdAt: 1 })).toBeNull();
    // 其它 action 不参与
    expect(parseChannelRecord({ action: 'chat', detail: 'block:empty_answer(x)', createdAt: 1 })).toBeNull();
  });
});

const row = (over: Partial<ChannelHealthLogRow> & { detail: string }): ChannelHealthLogRow => ({
  action: 'eval_runtime',
  target: null,
  status: null,
  createdAt: Date.UTC(2026, 10, 10, 4),
  ...over,
});

describe('aggregateChannelHealth 聚合口径', () => {
  const rows: ChannelHealthLogRow[] = [
    // 技能：一次 block
    row({ detail: 'channel · skill/周报 · block:empty_answer(空)', target: 'fail', createdAt: Date.UTC(2026, 10, 10, 2) }),
    // 技能：一次 warn
    row({ detail: 'channel · skill/周报 · warn:ungrounded_capability(x)', target: 'pass_with_warn', createdAt: Date.UTC(2026, 10, 10, 3) }),
    // 调度：一次 block
    row({ detail: 'channel · schedule/日报 · block:fabricated_source(x)', target: 'fail', createdAt: Date.UTC(2026, 10, 9, 3) }),
    // 对话：一次 warn
    row({ detail: 'warn:template_placeholder(x)', target: 'pass_with_warn', createdAt: Date.UTC(2026, 10, 9, 4) }),
    // 一行里既有 block 又有 warn → 只算 failed
    row({ detail: 'channel · skill/周报 · block:empty_answer(x) | warn:template_placeholder(y)', target: 'fail', createdAt: Date.UTC(2026, 10, 8, 4) }),
  ];

  const now = Date.UTC(2026, 10, 11, 0);

  it('failed 以「行」为单位：同行 block+warn 只记一次', () => {
    const s = aggregateChannelHealth(rows, { now });
    expect(s.parsed).toBe(5);
    expect(s.failed).toBe(3); // 3 行含 block
    expect(s.warned).toBe(2); // 2 行只有 warn
    expect(s.channels.find((c) => c.channel === 'skill')).toEqual({ channel: 'skill', failed: 2, warned: 1, total: 3 });
    expect(s.channels.find((c) => c.channel === 'schedule')).toEqual({ channel: 'schedule', failed: 1, warned: 0, total: 1 });
    expect(s.channels.find((c) => c.channel === 'chat')).toEqual({ channel: 'chat', failed: 0, warned: 1, total: 1 });
  });

  it('规则榜按出现次数排，取最严重的级别', () => {
    const s = aggregateChannelHealth(rows, { now });
    const empty = s.rules.find((r) => r.rule === 'empty_answer');
    expect(empty?.count).toBe(2);
    expect(empty?.severity).toBe('block');
    expect(s.rules[0].count).toBeGreaterThanOrEqual(s.rules[s.rules.length - 1].count);
  });

  it('标签榜只收带标签的通道，并给出该标签最常触发的规则', () => {
    const s = aggregateChannelHealth(rows, { now });
    const weekly = s.labels.find((l) => l.label === '周报');
    expect(weekly).toMatchObject({ channel: 'skill', total: 3, failed: 2 });
    // 周报三次里 empty_answer 出现两次，是第一
    expect(weekly?.topRule).toBe('empty_answer');
    // 对话通道没有标签，不该出现在榜里
    expect(s.labels.some((l) => l.channel === 'chat')).toBe(false);
  });

  it('按 +08 时区切天', () => {
    const s = aggregateChannelHealth(rows, { now });
    // UTC 10-10 02:00 = 北京时间 10-10 10:00；UTC 10-09 20:00 才属于 10-10
    expect(s.byDay.map((d) => d.day)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10']);
    expect(s.byDay.find((d) => d.day === '2026-11-10')).toEqual({ day: '2026-11-10', failed: 1, warned: 1 });
  });

  it('recent 取最近的若干条，与输入顺序无关', () => {
    const s = aggregateChannelHealth([...rows].reverse(), { now, recentLimit: 2 });
    expect(s.recent).toHaveLength(2);
    expect(s.recent[0].at).toBeGreaterThan(s.recent[1].at);
  });

  it('无法解析的行计入 unparsed，不静默丢弃', () => {
    const s = aggregateChannelHealth(
      [...rows, row({ detail: 'channel · skill/x', target: 'fail' }), row({ detail: '' })],
      { now },
    );
    expect(s.parsed).toBe(5);
    expect(s.unparsed).toBe(2);
  });

  it('days 之外的记录不参与统计', () => {
    const old = row({ detail: 'channel · skill/老技能 · block:empty_answer(x)', target: 'fail', createdAt: Date.UTC(2026, 9, 1) });
    const s = aggregateChannelHealth([...rows, old], { days: 7, now });
    expect(s.parsed).toBe(5);
    expect(s.labels.some((l) => l.label === '老技能')).toBe(false);
  });

  it('全是无法解析的行时，统计是 0 但 unparsed 必须能看出来', () => {
    // 这是「干净但错误」与「真的没问题」唯一的区分点
    const s = aggregateChannelHealth([row({ detail: '格式变了' }), row({ detail: '也变了' })], { now });
    expect(s.parsed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.unparsed).toBe(2);
  });
});
