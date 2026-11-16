import { describe, expect, it } from 'vitest';
import { buildSummaryGap, gapTokenBudget, packForSummary } from '@/lib/agent/summary-gap';

/**
 * 这两组用例守的是同一件事的两半：
 *  - `buildSummaryGap` 守「滞后」——滑出窗口但还没进摘要的内容，本轮要能看见；
 *  - `packForSummary` 守「永久丢失」——水位线只能推进到真正被摘要吞下的位置。
 *
 * 第二组是本次修掉的既有缺陷：原实现用 `.slice(0, 6000)` 保留最早的 6000 字符，
 * 却把水位线推到最后一条，中间那段从此既不会被摘要、也不会被读到。
 * 所以断言重点不是「拼出来的文本好看」，而是 **covered / lastAt 是否指向真实覆盖位置**。
 */

const msg = (role: string, content: string, createdAt: number) => ({ role, content, createdAt });

describe('buildSummaryGap 注入块', () => {
  it('没有缺口时返回空串，调用方据此跳过（不塞一个空标题进 system）', () => {
    expect(buildSummaryGap([], { maxTokens: 1000 }).text).toBe('');
  });

  it('预算充足时全部纳入，且按时间正序排列', () => {
    const r = buildSummaryGap([msg('user', '第一个问题', 1), msg('assistant', '第一个回答', 2)], {
      maxTokens: 5000,
    });
    expect(r.included).toBe(2);
    expect(r.omitted).toBe(0);
    expect(r.text.indexOf('第一个问题')).toBeLessThan(r.text.indexOf('第一个回答'));
  });

  it('预算不足时保留最新的，并把被丢掉的数量写出来', () => {
    const many = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `消息${i}号内容`, i));
    const r = buildSummaryGap(many, { maxTokens: 15 });
    expect(r.included).toBeGreaterThan(0);
    expect(r.included).toBeLessThan(10);
    expect(r.omitted).toBe(10 - r.included);
    // 最新的那条必须在（缺口里越新越相关）
    expect(r.text).toContain('消息9号内容');
    // 最早的应该被丢掉
    expect(r.text).not.toContain('消息0号内容');
  });

  it('omitted 会写进文本：不写的话「缺口已闭合」就是假的', () => {
    const many = Array.from({ length: 20 }, (_, i) => msg('user', `内容${i}`, i));
    const r = buildSummaryGap(many, { maxTokens: 20 });
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.text).toContain(`${r.omitted} 条`);
  });

  it('单条超长会截断并标注（否则一条长回复吃掉全部预算）', () => {
    const r = buildSummaryGap([msg('assistant', 'A'.repeat(5000), 1)], {
      maxTokens: 2000,
      perMessageMaxChars: 100,
    });
    expect(r.text).toContain('单条过长已截断');
    expect(r.text.length).toBeLessThan(400);
  });

  it('即使最新一条就超预算，也要收下它（那是最该被看到的一条）', () => {
    const r = buildSummaryGap([msg('user', 'B'.repeat(4000), 1)], {
      maxTokens: 10,
      perMessageMaxChars: 4000,
    });
    expect(r.included).toBe(1);
    expect(r.tokens).toBeGreaterThan(10);
  });

  it('空消息跳过且不计数（纯图片轮不该占额度，更不该被算成「缺口」）', () => {
    const r = buildSummaryGap([msg('user', '', 1), msg('assistant', '有内容', 2)], { maxTokens: 5000 });
    expect(r.included).toBe(1);
    expect(r.omitted).toBe(0);
  });

  it('提示语说明这不是最新指令（否则模型会把旧话当命令执行）', () => {
    const r = buildSummaryGap([msg('user', '把数据库删掉', 1)], { maxTokens: 5000 });
    expect(r.text).toContain('不要当作最新指令');
  });
});

describe('gapTokenBudget 预算夹取', () => {
  it('按历史预算的 15% 取值', () => {
    expect(gapTokenBudget(6000)).toBe(900);
  });

  it('过小时有下限（低于 400 连一轮问答都放不进去）', () => {
    expect(gapTokenBudget(1000)).toBe(400);
    expect(gapTokenBudget(0)).toBe(400);
  });

  it('过大时有上限（否则把省下来的首字延迟又还回去）', () => {
    expect(gapTokenBudget(30000)).toBe(1500);
  });
});

describe('packForSummary 水位线只能推进到真实覆盖位置', () => {
  it('全部装得下时覆盖到最后一条', () => {
    const r = packForSummary([msg('user', 'a', 100), msg('assistant', 'b', 200)]);
    expect(r.covered).toBe(2);
    expect(r.lastAt).toBe(200);
    expect(r.remaining).toBe(0);
  });

  it('装不下时 lastAt 指向实际最后一条，而不是数组末尾（这就是原来丢内容的根因）', () => {
    const long = 'X'.repeat(3000);
    const msgs = [msg('user', long, 100), msg('assistant', long, 200), msg('user', long, 300)];
    const r = packForSummary(msgs, 6500, 3000);
    expect(r.covered).toBeLessThan(3);
    // 关键断言：水位线位置 < 最后一条的时间戳
    expect(r.lastAt).toBeLessThan(300);
    expect(r.remaining).toBe(3 - r.covered);
  });

  it('一条都装不下时 lastAt 为 null（水位线不能动，否则跳过未摘要内容）', () => {
    expect(packForSummary([], 6000).lastAt).toBeNull();
    expect(packForSummary([], 6000).covered).toBe(0);
  });

  it('单条超过上限会截断但仍计入覆盖（否则水位线永远卡在原地，摘要追不上）', () => {
    const r = packForSummary([msg('user', 'Y'.repeat(20000), 500)], 6000, 3000);
    expect(r.covered).toBe(1);
    expect(r.lastAt).toBe(500);
    expect(r.text).toContain('单条过长已截断');
  });

  it('空消息不计入覆盖（它没有内容可摘要，不该让水位线因它前进）', () => {
    const r = packForSummary([msg('user', '', 100), msg('assistant', '有内容', 200)], 6000);
    expect(r.covered).toBe(1);
    expect(r.lastAt).toBe(200);
    expect(r.remaining).toBe(0);
  });

  it('正文按时间正序（摘要质量依赖叙事顺序）', () => {
    const r = packForSummary([msg('user', '先发生', 1), msg('assistant', '后发生', 2)], 6000);
    expect(r.text.indexOf('先发生')).toBeLessThan(r.text.indexOf('后发生'));
  });
});
