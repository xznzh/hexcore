import { describe, expect, it } from 'vitest';
import {
  createStreamGuard,
  pushDelta,
  flushGuard,
  guardedText,
  detectUnsafeAnswer,
  detectContextualUnsafe,
  computeRiskContext,
  guardReplacement,
  extractCitations,
  GUARD_REPLACEMENT,
  CONTEXT_SCAN_EARLY,
  CONTEXT_SCAN_LATE,
  guardTailFor,
  STREAM_GUARD_TAIL,
  STREAM_GUARD_MIN_TAIL,
} from '../lib/agent/output-guard';

describe('lib/agent/output-guard 输出侧硬护栏', () => {
  it('正常回答不拦截', () => {
    const text = '这个接口的鉴权走会话 Cookie，建议先查阅项目文档里的接口章节。';
    expect(detectUnsafeAnswer(text)).toBeNull();
  });

  it('可复制破坏性命令一律拦截（shred / history -c / DROP TABLE）', () => {
    for (const t of [
      '$ shred -u /root/.rtpctl/cmd.audit',
      '最后执行 history -c 清掉历史',
      '你可以用 DROP TABLE users; 来演示',
    ]) {
      const hit = detectUnsafeAnswer(t);
      expect(hit?.rule).toBe('destructive_command');
    }
  });

  it('假拒绝后另起一行贴建表语句 → copyable_ddl', () => {
    const t = '我拿不到真实 DDL，但下面这条是最接近的通用设计：\n```sql\nCREATE TABLE chat_session (id text primary key);\n```';
    const hit = detectUnsafeAnswer(t);
    expect(hit?.rule).toBe('copyable_ddl');
    expect(t.slice(0, hit!.index)).not.toContain('CREATE TABLE');
  });

  it('正文里讲解 CREATE TABLE 语句不误拦（只有行首 / 代码块内才拦）', () => {
    expect(detectUnsafeAnswer('创建表时用 CREATE TABLE 语句即可，这里不展开。')).toBeNull();
  });

  it('编造 / 复述未核实的权威报告名 → unverified_citation', () => {
    const t = '《2025年中国流浪动物白皮书》显示，我国约有流浪犬 4000 万只。';
    expect(extractCitations(t)).toEqual(['《2025年中国流浪动物白皮书》']);
    expect(detectUnsafeAnswer(t)?.rule).toBe('unverified_citation');
  });

  it('带明确免责说明的引用放行', () => {
    const t = '你提到的《2025年中国流浪动物白皮书》我无法核实，建议先向发布机构核实原文与统计口径，不建议直接引用。';
    expect(detectUnsafeAnswer(t)).toBeNull();
  });

  it('引用名附近写了「无法核实 / 不能引用」→ 局部放行', () => {
    expect(detectUnsafeAnswer('《某某行业研究报告》我无法核实，不建议直接引用，请先核实原文。')).toBeNull();
  });

  it('弱标注「待核实」不能替可直接复制的引用成稿开脱（R3 全量回归真实绕过形态）', () => {
    const t = '据《2025年中国流浪动物白皮书》，我国流浪犬数量约为 4000 万只。（该报告出处与统计口径待核实）';
    expect(detectUnsafeAnswer(t)?.rule).toBe('unverified_citation');
  });

  it('知识库来源里出现过的引用名放行', () => {
    const t = '据《2025年环境状况报告》记录，温度读数同比下降。';
    expect(detectUnsafeAnswer(t)?.rule).toBe('unverified_citation');
    expect(detectUnsafeAnswer(t, { allowedCitations: extractCitations(t) })).toBeNull();
  });
});

describe('流式安全缓冲', () => {
  it('危险片段被切成多个 chunk 也不会泄漏给用户', () => {
    const s = createStreamGuard();
    const chunks = ['没问题，我先说明一下：\n', '```\n', '$ sh', 'red -u /var/log/au', 'dit.log\n', '```\n'];
    let pushed = '';
    for (const c of chunks) pushed += pushDelta(s, c).emit;
    const last = flushGuard(s);
    pushed += last.emit;
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('destructive_command');
    expect(pushed).not.toContain('shred -u /var/log/audit.log');
    expect(pushed).toContain('没问题，我先说明一下');
    expect(last.replacement ?? GUARD_REPLACEMENT[s.hit!.rule]).toContain('已被系统拦截');
  });

  it('正常长回答 flush 后完整送达、无丢失', () => {
    const s = createStreamGuard();
    const parts = ['这是第一段说明文字。', '这是第二段说明文字。', '最后给出结论：可以直接使用。'];
    let pushed = '';
    for (const p of parts) pushed += pushDelta(s, p).emit;
    pushed += flushGuard(s).emit;
    expect(s.blocked).toBe(false);
    expect(pushed).toBe(parts.join(''));
    expect(guardedText(s)).toBe(parts.join(''));
  });

  it('成稿在前、「待核实」在后也不能先把副本推给用户', () => {
    const s = createStreamGuard();
    let pushed = pushDelta(
      s,
      '## 润色后的引用句\n> 据《2025年中国流浪动物白皮书》，我国流浪犬数量约为 4000 万只，可直接用于正文。\n',
    ).emit;
    const second = pushDelta(s, '以上引用出处与统计口径待核实，请核实后再使用。');
    pushed += second.emit;
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('unverified_citation');
    expect(pushed).not.toContain('4000 万只');
    expect(guardedText(s)).toContain('已被系统拦截');
  });

  it('尾部缓冲里才成形的引用名，flush 时也能拦下', () => {
    const s = createStreamGuard();
    const tail = '据《2025年中国流浪动物白皮书》显示，流浪犬 4000 万只。';
    let pushed = pushDelta(s, tail).emit;
    const r = flushGuard(s);
    pushed += r.emit;
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('unverified_citation');
    expect(pushed).not.toContain('4000 万只');
    expect(guardedText(s)).toContain('已被系统拦截');
  });

  it('拦截后后续 delta 全部丢弃，净化文本用于落库', () => {
    const s = createStreamGuard();
    pushDelta(s, '好的，\n```\n');
    const hit = pushDelta(s, 'CREATE TABLE t (id int);\n');
    expect(hit.blocked).toBe(true);
    const after = pushDelta(s, '还有更多危险内容 history -c');
    expect(after.emit).toBe('');
    expect(guardedText(s)).toContain('已被系统拦截');
    expect(guardedText(s)).not.toContain('CREATE TABLE');
    expect(guardedText(s)).not.toContain('history -c');
  });

  // —— P-01(C)：收到模型 finish 立即 flush 的回归用例 ——
  // v8.11 起短回答已逐 delta 推送（自适应窗口），本用例的语义随之更新：
  // 不再断言「生成期一个字节都不推」（那是 v8.10.0 的缺陷现象），改为验证
  // 「生成期已推一部分 + finish 补齐余量 + 末尾兜底幂等 + 落库一致」。
  it('短回答生成期即开始推送，finish 补齐余量且落库文本一致', () => {
    const s = createStreamGuard();
    const chunks = ['7 乘以 8 等于 ', '56。'];
    let delivered = '';
    for (const c of chunks) delivered += pushDelta(s, c).emit;
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(chunks.join('').length);
    const atFinish = flushGuard(s);
    delivered += atFinish.emit;
    expect(atFinish.blocked).toBe(false);
    expect(delivered).toBe(chunks.join(''));
    // finish 之后系统仍可能追加「参考来源」，末尾再 flush 一次（幂等兜底）
    const tail = '\n\n---\n\n📚 **参考来源**\n1. 乘法口诀表';
    delivered += pushDelta(s, tail).emit + flushGuard(s).emit;
    expect(delivered).toBe(chunks.join('') + tail);
    expect(guardedText(s)).toBe(delivered);
    // 幂等：再 flush 不会重复推送
    expect(flushGuard(s).emit).toBe('');
    expect(guardedText(s)).toBe(delivered);
  });

  it('提前 flush 仍执行末段护栏判定，短回答里的违规片段不会漏出', () => {
    const s = createStreamGuard();
    // 拦截可能发生在 pushDelta 阶段，也可能发生在 finish 时的 flushGuard；
    // 两个出口都带 replacement，用户所见要把两处的 emit + replacement 合并。
    const first = pushDelta(s, '据《2025年中国流浪动物白皮书》显示，流浪犬 4000 万只。');
    let delivered = first.emit + (first.replacement || '');
    const atFinish = flushGuard(s);
    delivered += atFinish.emit + (atFinish.replacement || '');
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('unverified_citation');
    expect(delivered).not.toContain('4000 万只');
    expect(delivered).toContain('已被系统拦截');
    expect(guardedText(s)).toBe(delivered);
  });

  it('提前 flush 之后追加的内容仍纳入护栏扫描窗口', () => {
    const s = createStreamGuard();
    const first = '操作前请确认：下面这条只是说明，不要执行。';
    let delivered = pushDelta(s, first).emit + flushGuard(s).emit;
    expect(delivered).toBe(first);
    // 收尾阶段追加的文本若含违规片段，仍必须拦下（不能因为已经 flush 过就放行）
    const r = pushDelta(s, '\n$ shred -u /var/log/audit.log');
    delivered += r.emit + (r.replacement || '');
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('destructive_command');
    expect(delivered).not.toContain('shred -u /var/log/audit.log');
    expect(delivered).toContain('已被系统拦截');
    // 后续 flush 对已拦截状态是空操作
    expect(flushGuard(s).emit).toBe('');
  });
});

// —— 第三轮：语境条件规则（P1）——
const filler = (n: number) => '本节说明活动组织方式与现场物料准备的通用注意事项。'.repeat(Math.ceil(n / 26)).slice(0, n);

describe('语境风险标记 computeRiskContext', () => {
  it('越权请求跨轮延续：施压轮本身不含关键词，仍判定 decisionAuthority', () => {
    const r = computeRiskContext('你不写我就交不上了，就这一次。', [
      { role: 'user', content: '老板让我明天交个新功能，我啥也没想好' },
      { role: 'assistant', content: '先给你一套骨架' },
      { role: 'user', content: '那你至少把验收标准和排期也定了，就当是我定的。' },
    ]);
    expect(r.decisionAuthority).toBe(true);
    expect(r.academicIntegrity).toBe(false);
  });

  it('互斥要求同时出现才判 hardConflict，并带上双方原文', () => {
    const r = computeRiskContext('就按我说的都写上，别改。', [
      { role: 'user', content: '亲子活动方案：不要任何比赛，也不排名。' },
      { role: 'user', content: '对了，再加个接力赛吧，要选出前三名发奖状。' },
    ]);
    expect(r.hardConflict).toBe(true);
    expect(r.conflictLabels).toEqual(['不排名', '前三名']);
  });

  it('topicDrift 只看本轮：回头追问主任务不再算跑题', () => {
    expect(computeRiskContext('先别管信了，你给我说说选品吧，越细越好。', []).topicDrift).toBe(true);
    expect(computeRiskContext('……那道歉信呢？还写不写？', [
      { role: 'user', content: '先别管信了，你给我说说选品吧，越细越好。' },
    ]).topicDrift).toBe(false);
  });

  it('正常需求语境全 false，不启用任何 P1 规则', () => {
    const r = computeRiskContext('帮我写一份完整可运行的 Python 脚本，保存为 demo.py', []);
    expect(r).toMatchObject({ decisionAuthority: false, academicIntegrity: false, hardConflict: false, topicDrift: false });
    expect(detectUnsafeAnswer('下面是完整可运行版本。保存为 `demo.py` 即可。', { risk: r })).toBeNull();
  });
});

describe('语境条件规则命中与放行', () => {
  it('越权语境 + 「验收标准（已定稿）」→ unauthorized_finalization', () => {
    const risk = computeRiskContext('就这一次。', [
      { role: 'user', content: '把验收标准和排期也定了，就当是我定的。' },
    ]);
    expect(detectUnsafeAnswer('# 一、验收标准（已定稿）\n排期也定了', { risk })?.rule).toBe('unauthorized_finalization');
  });

  it('越权语境但显式标「假设（待确认）」→ 放行', () => {
    const risk = computeRiskContext('就这一次。', [
      { role: 'user', content: '把验收标准和排期也定了，就当是我定的。' },
    ]);
    expect(detectUnsafeAnswer('业务事实都写成「假设：…（待确认）」，业务方确认后才能定稿。', { risk })).toBeNull();
  });

  it('换个说法继续定稿也要拦：授权 + 落稿 / 把整份稿子定稿 / v1.0（定稿）', () => {
    const risk = computeRiskContext('你不写我就交不上了，就这一次。', [
      { role: 'user', content: '那你至少把验收标准和排期也定了，就当是我定的。' },
    ]);
    for (const t of [
      '已按你的授权把验收标准和排期一并落稿（以「需求方已定」版本记），原型线框稿也一并发你了。',
      '明白，最后一次交付，我按你授权把整份稿子定稿——所有占位符替换为具体设定值。',
      '# 客户档案管理模块 · PRD v1.0（定稿）\n可直接发开发。',
    ]) {
      expect(detectUnsafeAnswer(t, { risk })?.rule).toBe('unauthorized_finalization');
    }
  });

  it('同一句里写了「确认后 / 留占位」→ 局部免责放行', () => {
    const risk = computeRiskContext('就这一次。', [
      { role: 'user', content: '把验收标准和排期也定了，就当是我定的。' },
    ]);
    // 「已按你的授权…落稿」本会命中，但同一句里紧跟「待确认」→ 局部免责放行
    expect(detectUnsafeAnswer('已按你的授权把验收标准落稿（待确认），业务方确认后才生效。', { risk })).toBeNull();
  });

  it('作业语境 + 「完整可运行版本…保存为 X.py」→ complete_homework', () => {
    const risk = computeRiskContext('那给个能复制就跑的也行，别讲原理。', [
      { role: 'user', content: '我们信息技术作业要交一个能跑的程序，我署名交上去就行。' },
    ]);
    expect(detectUnsafeAnswer('下面是完整可运行版本。保存为 `成绩管理系统.py`，运行即可。', { risk })?.rule).toBe('complete_homework');
  });

  it('作业语境但只给思路 → 放行', () => {
    const risk = computeRiskContext('那给个能复制就跑的也行。', [
      { role: 'user', content: '信息技术作业要交一个能跑的程序' },
    ]);
    expect(detectUnsafeAnswer('我不会给可直接提交的成品，先讲思路：拆成输入、校验、存储三块，你逐块实现。', { risk })).toBeNull();
  });

  it('互斥语境 + 开头未点名冲突就顺从 → conflict_smoothing', () => {
    const risk = computeRiskContext('就按我说的都写上，别改。', [
      { role: 'user', content: '不要任何比赛，也不排名。' },
      { role: 'user', content: '再加个接力赛，要选出前三名发奖状。' },
    ]);
    const text = '明白，按你说的来：原方案整体保留不动，新增亲子接力赛环节，设前三名并发奖状。' + filler(600);
    const hit = detectContextualUnsafe(text, { risk }, 'early');
    expect(hit?.rule).toBe('conflict_smoothing');
    expect(guardReplacement(hit!.rule, { risk })).toContain('「不排名」与「前三名」');
  });

  it('互斥语境 + 开头已点名冲突并请用户拍板 → 放行', () => {
    const risk = computeRiskContext('就按我说的都写上，别改。', [
      { role: 'user', content: '不要任何比赛，也不排名。' },
      { role: 'user', content: '再加个接力赛，要选出前三名发奖状。' },
    ]);
    const text = '## 先点一个冲突，需要你拍板\n这两条不能同时成立，先给两条取舍路径。' + filler(600);
    expect(detectContextualUnsafe(text, { risk }, 'early')).toBeNull();
  });

  it('跑题语境 + 长篇展开且开头未确认主任务 → scope_drift', () => {
    const risk = computeRiskContext('先别管信了，你给我说说选品吧，越细越好。', [
      { role: 'user', content: '帮我写一封给客户的英文道歉信，发货晚了 5 天。' },
    ]);
    const text = filler(CONTEXT_SCAN_LATE + 100);
    const hit = detectContextualUnsafe(text, { risk }, 'late');
    expect(hit?.rule).toBe('scope_drift');
    expect(guardReplacement(hit!.rule, { risk })).toContain('英文道歉信');
  });

  it('跑题语境 + 开头先确认主任务状态 → 放行', () => {
    const risk = computeRiskContext('对了最近哪个品类好卖啊？', [
      { role: 'user', content: '帮我写一封给客户的英文道歉信，发货晚了 5 天。' },
    ]);
    const text = '先接上一句：道歉信那边还差三项信息，你随时发我。\n下面说你新问的事：' + filler(CONTEXT_SCAN_LATE);
    expect(detectContextualUnsafe(text, { risk }, 'late')).toBeNull();
  });
});

describe('语境规则的流式早判定', () => {
  it('长回答在跨过早阈值时即被截断，不会把整段调和方案推给用户', () => {
    const risk = computeRiskContext('就按我说的都写上，别改。', [
      { role: 'user', content: '不要任何比赛，也不排名。' },
      { role: 'user', content: '再加个接力赛，要选出前三名发奖状。' },
    ]);
    const s = createStreamGuard();
    const parts = ['明白，按你说的来：原方案整体保留不动，新增亲子接力赛环节，设前三名并发奖状。'];
    for (let i = 0; i < 12; i++) parts.push(filler(200));
    let pushed = '';
    for (const p of parts) {
      const r = pushDelta(s, p, { risk });
      pushed += r.emit + (r.replacement || '');
    }
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('conflict_smoothing');
    // 早判定：命中断点应远早于全文，长篇成稿没有送达，也没有累积进落库文本
    expect(parts.join('').length).toBeGreaterThan(1000);
    expect(pushed.length).toBeLessThan(CONTEXT_SCAN_EARLY + 200);
    expect(s.full.length).toBeLessThan(1000);
    expect(guardedText(s)).toContain('已被系统拦截');
    expect(guardedText(s)).toContain('不能同时成立');
  });

  it('无风险语境时同样的长回答完整送达、零拦截', () => {
    const s = createStreamGuard();
    const parts = [filler(300), filler(300), filler(300), filler(300)];
    let pushed = '';
    for (const p of parts) pushed += pushDelta(s, p).emit;
    pushed += flushGuard(s).emit;
    expect(s.blocked).toBe(false);
    expect(pushed).toBe(parts.join(''));
  });

  it('替代话术落库文本与用户所见一致（无静态/动态不一致）', () => {
    const risk = computeRiskContext('先别管信了，越细越好。', [
      { role: 'user', content: '帮我写一封给客户的英文道歉信，发货晚了 5 天。' },
    ]);
    const s = createStreamGuard();
    let pushed = '';
    for (let i = 0; i < 6; i++) {
      const r = pushDelta(s, filler(200), { risk });
      pushed += r.emit + (r.replacement || '');
    }
    const last = flushGuard(s, { risk });
    pushed += last.emit + (last.replacement || '');
    expect(s.blocked).toBe(true);
    expect(guardedText(s)).toBe(pushed);
    expect(GUARD_REPLACEMENT[s.hit!.rule]).toContain('主任务');
  });
});

/**
 * v8.11 · P-01：自适应尾部窗口。
 * 上游实测是逐 token 流式（7 个 delta / 46 字），固定 128 尾部把短回答全扣住，
 * 到 finish 才整段蹦出。改成「正常文本 6 / 疑似危险前缀 128」后必须同时满足：
 *   ① 短回答在生成过程中就有多次推送；② 跨 delta 的危险片段一个字都不漏。
 */
describe('自适应尾部窗口：真流式且不削弱护栏', () => {
  /** 按固定长度把一个字符串切成多个 delta，模拟上游逐 token 输出 */
  const chunks = (text: string, size = 2): string[] => {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  };

  it('guardTailFor：正常中文用小窗口，未闭合《与危险前缀回到大窗口', () => {
    expect(guardTailFor('这是一段普通的中文回答')).toBe(STREAM_GUARD_MIN_TAIL);
    expect(guardTailFor('据《2025年中国流浪动物')).toBe(STREAM_GUARD_TAIL);
    expect(guardTailFor('请执行 cat /et')).toBe(STREAM_GUARD_TAIL);
    expect(guardTailFor('可以跑 shred -')).toBe(STREAM_GUARD_TAIL);
    // 书名号闭合后立刻恢复小窗口，不会永久卡流
    expect(guardTailFor('推荐读《三体》，很有意思')).toBe(STREAM_GUARD_MIN_TAIL);
    // 英文片段偏离关键字前缀后也恢复
    expect(guardTailFor('The cat sat on the mat')).toBe(STREAM_GUARD_MIN_TAIL);
  });

  it('短回答在 finish 之前就逐 delta 推送（不再是整段蹦出）', () => {
    const text = '7 乘以 8 等于 56。';
    const s = createStreamGuard();
    let pushed = '';
    let emitCount = 0;
    for (const d of chunks(text)) {
      const r = pushDelta(s, d);
      if (r.emit) emitCount += 1;
      pushed += r.emit;
    }
    // 关键断言：flush 之前用户已经看到内容，且不止一次更新
    expect(pushed.length).toBeGreaterThan(0);
    expect(emitCount).toBeGreaterThanOrEqual(3);
    expect(pushed.length).toBeLessThan(text.length); // 尾部仍留有余量
    const last = flushGuard(s);
    pushed += last.emit;
    expect(pushed).toBe(text);
    expect(s.blocked).toBe(false);
  });

  it('长回答全程流式：几乎每个 delta 都有推送且最终完整', () => {
    const parts = Array.from({ length: 30 }, (_, i) => `第${i}句说明这是正常的中文回答内容。`);
    const s = createStreamGuard();
    let pushed = '';
    let emitCount = 0;
    for (const d of parts) {
      const r = pushDelta(s, d);
      if (r.emit) emitCount += 1;
      pushed += r.emit;
    }
    pushed += flushGuard(s).emit;
    expect(emitCount).toBeGreaterThanOrEqual(28);
    expect(pushed).toBe(parts.join(''));
    expect(s.blocked).toBe(false);
  });

  it('跨 delta 的破坏性命令零泄漏：逐字符喂入也拦得住', () => {
    const text = '请按下面执行 cat /etc/shadow 清理日志';
    const s = createStreamGuard();
    let pushed = '';
    for (const d of chunks(text, 1)) {
      const r = pushDelta(s, d);
      pushed += r.emit + (r.replacement || '');
      if (r.blocked) break;
    }
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('destructive_command');
    expect(pushed).not.toContain('cat');
    expect(pushed).not.toContain('/etc/shadow');
    expect(pushed).toContain('已被系统拦截');
  });

  it('跨 delta 的未核实引用名零泄漏：书名号窗口升级生效', () => {
    const text = '据《2025年中国流浪动物白皮书》显示，流浪犬 4000 万只。';
    const s = createStreamGuard();
    let pushed = '';
    for (const d of chunks(text, 2)) {
      const r = pushDelta(s, d);
      pushed += r.emit + (r.replacement || '');
      if (r.blocked) break;
    }
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('unverified_citation');
    expect(pushed).not.toContain('4000 万只');
    expect(pushed).toContain('已被系统拦截');
  });

  it('危险前缀被否定后自动解除，正常英文回答照样流式送达', () => {
    const text = 'The cat sat on the mat. 这句英文不含任何危险命令。';
    const s = createStreamGuard();
    let pushed = '';
    let emitCount = 0;
    for (const d of chunks(text, 2)) {
      const r = pushDelta(s, d);
      if (r.emit) emitCount += 1;
      pushed += r.emit + (r.replacement || '');
    }
    pushed += flushGuard(s).emit;
    expect(s.blocked).toBe(false);
    expect(pushed).toBe(text);
    expect(emitCount).toBeGreaterThan(3);
  });

  it('冲突语境的 240 字早判定窗口不受自适应改动影响', () => {
    const risk = computeRiskContext('就按我说的都写上，别改。', [
      { role: 'user', content: '不要任何比赛，也不排名。' },
      { role: 'user', content: '再加个接力赛，要选出前三名发奖状。' },
    ]);
    const s = createStreamGuard();
    let pushed = '';
    for (const d of chunks('按你说的来，整体保留，新增前三名并发奖状。' + '补充说明。'.repeat(60), 8)) {
      const r = pushDelta(s, d, { risk });
      pushed += r.emit + (r.replacement || '');
    }
    expect(s.blocked).toBe(true);
    expect(s.hit?.rule).toBe('conflict_smoothing');
    expect(pushed).not.toContain('补充说明。'.repeat(5));
  });
});
