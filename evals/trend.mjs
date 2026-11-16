#!/usr/bin/env node
/**
 * 评测趋势：把 reports/ 里的历史报告压成一条时间线。
 *
 * 用法：
 *   node evals/trend.mjs                 # 打终端摘要 + 重写 evals/reports/trend.html
 *   node evals/trend.mjs --last 60       # 只画最近 60 次（默认 40）
 *   node evals/trend.mjs --no-html       # 只打终端，供脚本/CI 读取
 *   node evals/trend.mjs --html D:/x.html
 *
 * 为什么需要它（以及为什么不看单次分数）：
 *   1. 单次通过率有 ±1~2 条抖动（模型随机性），一次 50/52 说明不了任何事。
 *      只有「同配置、连续多次」的曲线才能分清「真的退化了」和「抖了一下」。
 *   2. 准确率是滞后指标。切片变碎、闸门失效、向量降级这类问题，**准确率往往还不掉**，
 *      先动的是「平均命中片数」和「平均耗时」。所以趋势图画的是这四个量，不只画通过率。
 *   3. 报告是散落的 JSON，没人会去逐份翻。压成一张图，才知道该不该回滚昨天那次改动。
 *
 * 两个硬约束：
 *   - 不同配置（闸门开/关）必须分开画，否则曲线是两种实验混在一起，读不出信息；
 *   - golden 条数变过（50 → 52），所以纵向只能用百分比和均值比，不能比「通过了几条」。
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'evals', 'reports');
const args = process.argv.slice(2);
const optOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const lastN = Math.max(2, Number(optOf('--last', 40)) || 40);
const htmlPath = optOf('--html', path.join(dir, 'trend.html'));
const wantHtml = !has('--no-html');

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 文件名里的时间戳是 UTC（stamp 来自 toISOString），summary.at 也是 UTC；统一按本地时间展示 */
function pickTime(file, summary) {
  if (summary.at) {
    const d = new Date(summary.at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const m = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (m) return new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  return new Date(fs.statSync(path.join(dir, file)).mtimeMs);
}

function loadReports() {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // 半截文件（夜间任务被中断）直接跳过，不让它拖垮整条曲线
    }
    if (!j || !j.summary || !Array.isArray(j.rows) || !j.rows.length) continue;
    const s = j.summary;
    const total = s.total || j.rows.length;
    const passed = s.passed ?? j.rows.filter((r) => r.pass).length;
    // 两类报告共用 reports/ 目录，靠文件名后缀区分：`*-adversarial.json` 来自
    // adversarial-run.test.ts，其余是 golden。混着画像会把「答案通过率」和「守住率」
    // 画进同一条线——两个分母不同、含义不同，那条线没有任何解释力。
    const kind = /-adversarial$/.test(file.replace(/\.json$/, '')) ? 'adversarial' : 'golden';
    out.push({
      file,
      kind,
      at: pickTime(file, s),
      noGate: s.noGate ?? file.includes('-no-gate'),
      model: s.model || '?',
      total,
      passed,
      acc: (passed / total) * 100,
      answer: s.answer || { total: 0, passed: 0 },
      abstain: s.abstain || { total: 0, passed: 0 },
      citation: s.citation || { total: 0, passed: 0 },
      // 对抗报告字段：分类守住情况 + 输入护栏命中数（护栏召回是独立指标，不计入通过判定）
      byCategory: Array.isArray(s.byCategory) ? s.byCategory : [],
      guarded: typeof s.guarded === 'number' ? s.guarded : 0,
      passLine: typeof s.passLine === 'number' ? s.passLine : null,
      // 老报告没有 avgHits 字段，从 rows 现算，保证新老报告能画在同一张图上
      avgHits: s.avgHits ?? Number(mean(j.rows.map((r) => r.hits ?? 0)).toFixed(2)),
      avgMs: s.avgMs ?? Math.round(mean(j.rows.map((r) => r.ms ?? 0))),
      rows: j.rows,
    });
  }
  return out.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
}

const all = loadReports();
if (!all.length) {
  console.error(`[趋势] ${dir} 里没有可用报告，先跑一次 npm run eval`);
  process.exit(1);
}

// golden 与对抗分开：主曲线只画 golden，对抗单独成块。
// 混着画没有意义——两个分母不同、达标线也不同（golden 没有通过线，对抗有 90% 门禁）。
const goldenAll = all.filter((r) => r.kind === 'golden');
const advAll = all.filter((r) => r.kind === 'adversarial');
if (!goldenAll.length) {
  console.error('[趋势] 只找到对抗报告；golden 曲线需要至少一份 golden 报告，先跑 npm run eval');
  process.exit(1);
}

const shown = goldenAll.slice(-lastN);
const advShown = advAll.slice(-lastN);
const advLast = advAll.length ? advAll[advAll.length - 1] : null;
const gate = shown.filter((r) => !r.noGate);
const noGate = shown.filter((r) => r.noGate);
const last = goldenAll[goldenAll.length - 1];
const prevSame = [...goldenAll].reverse().find((r) => r !== last && r.noGate === last.noGate) || null;

const fmtTime = (d) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');

/** 终端里中文占两列，按 String.length 对齐会整体错位 —— 按显示宽度算 */
const dw = (s) =>
  [...String(s)].reduce(
    (n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1),
    0,
  );
const pad = (s, w, right) => {
  const sp = ' '.repeat(Math.max(0, w - dw(s)));
  return right ? sp + s : s + sp;
};
const sgn = (x, digits = 2) => (x > 0 ? `+${x.toFixed(digits)}` : x.toFixed(digits));

// ───────────────────────────── 终端摘要 ─────────────────────────────
console.log(
  `\n[趋势] 共 ${all.length} 份报告（golden ${goldenAll.length} / 对抗 ${advAll.length}）· ` +
    `${fmtTime(all[0].at)} ~ ${fmtTime(all[all.length - 1].at)} · ` +
    `闸门开 ${shown.filter((r) => !r.noGate).length} 份 / 关 ${noGate.length} 份（窗口 ${shown.length}）`,
);

const cols = ['时间', '闸门', '通过', '应答对', '应拒答', '命中片', '耗时', '模型'];
const table = [
  cols,
  ...shown.map((r) => [
    fmtTime(r.at),
    r.noGate ? '关' : '开',
    `${r.passed}/${r.total} ${Math.round(r.acc)}%`,
    pct(r.answer.passed, r.answer.total),
    pct(r.abstain.passed, r.abstain.total),
    r.avgHits.toFixed(2),
    `${(r.avgMs / 1000).toFixed(1)}s`,
    String(r.model).slice(0, 22),
  ]),
];
const widths = cols.map((c, i) => Math.max(dw(c), ...table.slice(1).map((row) => dw(row[i]))));
console.log('');
for (const [i, row] of table.entries()) {
  console.log('  ' + row.map((c, j) => pad(c, widths[j], j !== 0)).join('  '));
  if (i === 0) console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
}

if (prevSame) {
  console.log(
    `\n  本次 vs 上次（同为闸门${last.noGate ? '关' : '开'}，${fmtTime(prevSame.at)}）：` +
      `通过 ${prevSame.passed}→${last.passed} · ` +
      `命中片 ${prevSame.avgHits.toFixed(2)}→${last.avgHits.toFixed(2)}（${sgn(last.avgHits - prevSame.avgHits)}） · ` +
      `耗时 ${(prevSame.avgMs / 1000).toFixed(1)}s→${(last.avgMs / 1000).toFixed(1)}s`,
  );
}

/**
 * --check：给夜间任务用的「要不要叫醒人」判定。
 *
 * 为什么不看绝对分数：模型有 ±1~2 条抖动，写死「低于 50 条就报警」会天天误报。
 * 这里比的是**同配置的上一次**，且要掉 2 条以上才报警——1 条属于抖动，2 条才像回归。
 * 退出码 2 表示需要人看一眼，0 表示正常。
 */
let alert = '';
const alertFile = path.join(dir, 'ALERT.md');
if (has('--check')) {
  if (!prevSame) {
    console.log('\n[检查] 只有本次同配置报告，暂无可比基线，跳过回归判定。');
  } else {
    const drop = last.passed - prevSame.passed;
    const hitsUp = last.avgHits - prevSame.avgHits;
    if (drop <= -2) alert += `通过数下降 ${-drop} 条（${prevSame.passed}→${last.passed}）`;
    if (hitsUp >= 0.8) alert += `${alert ? '；' : ''}平均命中片数上升 ${hitsUp.toFixed(2)} 片`;
    console.log(alert ? `\n[检查] ⚠ 疑似回归：${alert}` : '\n[检查] 与上次同配置相比无显著变化。');
  }

  // 夜间跑完没人盯着，告警得留个「明天一进项目就能看见」的痕迹。
  // 恢复了就自动清掉——过期的告警比没有告警更浪费时间。
  if (alert) {
    fs.writeFileSync(
      alertFile,
      [
        '# ⚠ 评测疑似回归',
        '',
        `- 检测时间：${fmtTime(last.at)}（报告 \`${last.file}\`）`,
        `- 现象：${alert}`,
        `- 对比基线：${fmtTime(prevSame.at)}（\`${prevSame.file}\`）`,
        '',
        '## 下一步',
        '',
        '```bash',
        'npm run eval:diff     # 看逐条「谁通过变失败」，分清真回归和抖动',
        'node evals/trend.mjs  # 看曲线，确认是不是持续下降',
        '```',
        '',
        '若确认是单次抖动（模型随机性，±1~2 条），重跑一次 `npm run eval`；',
        '若两次都低，按 diff 里回归的用例去查最近的改动（分块 / 检索 / 解析 / 提示词）。',
        '',
        '> 本文件由 `node evals/trend.mjs --check` 自动生成，下次判定正常时会被删除。',
      ].join('\n'),
      'utf8',
    );
    console.log(`[告警] 已写入 ${alertFile}`);
  } else if (fs.existsSync(alertFile)) {
    fs.rmSync(alertFile, { force: true });
    console.log('[检查] 上次的告警已恢复，清掉 ALERT.md');
  }
}

// 不稳定用例：比「通过率」更能指导行动——它直接告诉你去修哪条
// 只统计 golden：对抗用例的 id（adv-*）混进来会让「谁最不稳定」这张榜失去可比性
const tally = new Map();
for (const r of goldenAll) {
  for (const row of r.rows) {
    const t = tally.get(row.id) || { id: row.id, run: 0, fail: 0, reason: '' };
    t.run++;
    if (!row.pass) {
      t.fail++;
      t.reason = row.reason;
    }
    tally.set(row.id, t);
  }
}
const flaky = [...tally.values()].filter((t) => t.fail > 0).sort((a, b) => b.fail - a.fail || a.id.localeCompare(b.id));
if (flaky.length) {
  console.log('\n## 历史不稳定用例（失败次数 / 出现次数）—— 这些才是要盯的');
  for (const t of flaky.slice(0, 10)) {
    console.log(`  ${t.id.padEnd(8)} ${t.fail}/${t.run}  ${String(t.reason).slice(0, 60)}`);
  }
} else {
  console.log('\n## 历史不稳定用例\n  无。全部用例在留存期内每次都通过。');
}

// ───────────────────────────── 对抗评测 ─────────────────────────────
/**
 * 对抗单独成块，不并进上面的表。
 *
 * 理由和「golden / 对抗不能混画」是同一个：上面那张表的列是「应答对 / 应拒答 / 命中片」，
 * 对抗报告里这些字段全是 0/0，并进去只会得到一排 `-`，把真正的信号（守住率）淹掉。
 */
if (advLast) {
  const advRows = advShown.map((r) => {
    const fails = r.rows.filter((x) => !x.pass).map((x) => x.id);
    return [fmtTime(r.at), `${r.passed}/${r.total}`, `${Math.round(r.acc)}%`, `${r.guarded}/${r.total}`, fails.join(', ') || '—'];
  });
  const advCols = ['时间', '守住', '守住率', '护栏命中', '失败用例'];
  const advWidths = advCols.map((c, i) => Math.max(dw(c), ...advRows.map((row) => dw(row[i]))));

  console.log(
    `\n## 对抗评测（注入 / 越权 / 超长 / 工具返回注入）· 共 ${advAll.length} 次 · 通过线 ${
      advLast.passLine != null ? `${Math.round(advLast.passLine * 100)}%` : '90%'
    }`,
  );
  for (const [i, row] of [advCols, ...advRows].entries()) {
    console.log('  ' + row.map((c, j) => pad(c, advWidths[j], j !== 0)).join('  '));
    if (i === 0) console.log('  ' + advWidths.map((w) => '─'.repeat(w)).join('  '));
  }
  if (advLast.byCategory.length) {
    console.log(
      '  分类：' + advLast.byCategory.map((c) => `${c.category} ${c.passed}/${c.total}`).join(' · '),
    );
  }
  const advFailIds = advLast.rows.filter((x) => !x.pass).map((x) => x.id);
  if (advFailIds.length) {
    console.log(`  本次失守：${advFailIds.join(', ')}（详见最近一份 *-adversarial.md 的「失守详情」）`);
  } else {
    console.log('  本次全部守住。');
  }
}

// ───────────────────────────── HTML 图表 ─────────────────────────────
/**
 * x 轴取自「这张图自己的报告序列」，默认是 golden 的 shown。
 *
 * 原先用模块级 `const X_N = shown.length`：一旦要画第二类报告（对抗），
 * 就会拿 golden 的点数去排布，点会挤在左侧或越过画布右边界。
 */
function seriesOf(name, color, dash, pointsOf, axis = shown) {
  return { name, color, dash, points: axis.map((r, i) => ({ i, v: pointsOf(r), label: `${fmtTime(r.at)} ${r.noGate ? '(关闸门)' : ''}` })) };
}

function lineChart({ title, note, unit, series, digits = 0, axis = shown }) {
  const X_N = axis.length;
  const W = 680;
  const H = 200;
  const P = { l: 48, r: 18, t: 20, b: 30 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;

  const vals = series.flatMap((s) => s.points.filter((p) => p.v != null).map((p) => p.v));
  if (!vals.length) return '';
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-9) {
    // 只有一个数据点或全部相等：给一个人造区间，避免除以 0 画成一条贴着边框的线
    lo = lo - Math.max(1, Math.abs(lo) * 0.1);
    hi = hi + Math.max(1, Math.abs(hi) * 0.1);
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  if (unit === '%') {
    // 百分比图**不能按数据自动缩放**：98% 与 100% 只差 2 个点，自动拉伸后看起来像断崖，
    // 而实际上那就是 ±1~2 条抖动。固定「下界不高于 90、上界 100」，让视觉差与真实差成比例。
    lo = Math.min(lo, 90);
    hi = 100;
    if (hi - lo < 5) lo = hi - 5;
  } else {
    lo = Math.max(0, lo);
  }

  const xAt = (i) => P.l + (X_N <= 1 ? iw / 2 : (i / (X_N - 1)) * iw);
  const yAt = (v) => P.t + ih - ((v - lo) / (hi - lo)) * ih;

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const v = lo + (hi - lo) * t;
      const y = yAt(v);
      return (
        `<line x1="${P.l}" y1="${y.toFixed(1)}" x2="${W - P.r}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${P.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${v.toFixed(digits)}${unit === '%' ? '' : ''}</text>`
      );
    })
    .join('');

  // x 轴标签最多 6 个，避免时间戳糊成一片
  const step = Math.max(1, Math.ceil(X_N / 6));
  let picks = axis.map((r, i) => ({ r, i })).filter(({ i }) => i % step === 0);
  if (picks[picks.length - 1]?.i !== X_N - 1) picks.push({ r: axis[X_N - 1], i: X_N - 1 });
  // 末尾两个标签离得太近就丢掉前一个，否则「10-29 12:24」和「10-29 12:27」会叠在一起
  if (picks.length >= 2) {
    const a = picks[picks.length - 2];
    const b = picks[picks.length - 1];
    if (xAt(b.i) - xAt(a.i) < 46) picks = picks.filter((p) => p !== a);
  }
  const ticks = picks
    .map(({ r, i }) => {
      // 首尾标签用 start/end 锚点，否则时间戳会溢出画布被裁掉半截
      const anchor = i === 0 ? 'start' : i === X_N - 1 ? 'end' : 'middle';
      return `<text x="${xAt(i).toFixed(1)}" y="${H - 10}" text-anchor="${anchor}" font-size="10" fill="#9ca3af">${fmtTime(r.at)}</text>`;
    })
    .join('');

  const paths = series
    .map((s) => {
      // 遇到 null 就断开，不要用直线把两段不相邻的数据连起来（那是造数据）
      const segs = [];
      let cur = [];
      for (const p of s.points) {
        if (p.v == null) {
          if (cur.length) segs.push(cur);
          cur = [];
        } else cur.push(p);
      }
      if (cur.length) segs.push(cur);
      const lines = segs
        .map(
          (seg) =>
            `<polyline fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} points="${seg
              .map((p) => `${xAt(p.i).toFixed(1)},${yAt(p.v).toFixed(1)}`)
              .join(' ')}"/>`,
        )
        .join('');
      const dots = s.points
        .filter((p) => p.v != null)
        .map(
          (p) =>
            `<circle cx="${xAt(p.i).toFixed(1)}" cy="${yAt(p.v).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(p.label)} · ${p.v.toFixed(digits)}${unit}</title></circle>`,
        )
        .join('');
      return lines + dots;
    })
    .join('');

  const legend =
    series.map((s) => `<span style="color:${s.color}">${s.dash ? '┄' : '━'} ${esc(s.name)}</span>`).join('<span style="color:#d1d5db"> · </span>') +
    // 把 y 轴范围写出来：百分比图从 90 起，不写清楚会被读成「从 0 起」
    `<span class="axis-hint">y 轴 ${lo.toFixed(digits)}–${hi.toFixed(digits)}${unit}</span>`;

  return `<section class="card">
  <h2>${esc(title)}</h2>
  ${note ? `<p class="note">${esc(note)}</p>` : ''}
  <div class="legend">${legend}</div>
  <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)}">
    ${grid}${ticks}${paths}
  </svg>
</section>`;
}

const head = [...all].reverse().find((r) => !r.noGate) || last; // KPI 用最近一次「正常配置」，别用对照实验

const cards = `<p class="note kpi-src">以下五张卡取自最近一次闸门开的运行：${fmtTime(head.at)}</p>
<section class="cards">
  <div class="kpi"><span>总通过</span><b>${head.passed}/${head.total}</b><i>${Math.round(head.acc)}%</i></div>
  <div class="kpi"><span>应答对</span><b>${head.answer.passed}/${head.answer.total}</b><i>${pct(head.answer.passed, head.answer.total)}</i></div>
  <div class="kpi"><span>应拒答</span><b>${head.abstain.passed}/${head.abstain.total}</b><i>${pct(head.abstain.passed, head.abstain.total)}</i></div>
  <div class="kpi"><span>平均命中片数</span><b>${head.avgHits.toFixed(2)}</b><i>越低越聚焦</i></div>
  <div class="kpi"><span>平均耗时</span><b>${(head.avgMs / 1000).toFixed(1)}s</b><i>每条</i></div>
</section>`;

const chartAcc = lineChart({
  title: '总通过率',
  note: '满分不代表没问题，只代表「已知问题没有复发」；看的是有没有掉下来。',
  unit: '%',
  digits: 0,
  series: [
    seriesOf('闸门开', '#2563eb', '', (r) => r.acc),
    seriesOf('闸门关（对照）', '#94a3b8', '4 3', (r) => (r.noGate ? r.acc : null)),
  ],
});

const chartSplit = lineChart({
  title: '应答对 vs 应拒答',
  note: '两者一起掉 = 检索/解析坏了；只有「应拒答」掉 = 模型开始编；只有「应答对」掉 = 资料够了但没读对。',
  unit: '%',
  digits: 0,
  series: [
    seriesOf('应答对', '#2563eb', '', (r) => (r.answer.total ? (r.answer.passed / r.answer.total) * 100 : null)),
    seriesOf('应拒答', '#d97706', '', (r) => (r.abstain.total ? (r.abstain.passed / r.abstain.total) * 100 : null)),
  ],
});

const chartHits = lineChart({
  title: '平均命中片数',
  note: '滞后于「切片变碎/闸门失效」、先于「准确率下降」。这条线抬头，通常意味着分块或召回退化了。',
  unit: ' 片',
  digits: 2,
  series: [seriesOf('闸门开', '#2563eb', '', (r) => (r.noGate ? null : r.avgHits))],
});

const chartMs = lineChart({
  title: '平均耗时',
  note: '模型或检索变慢会先反映在这里；也用来发现「重试了一次空回答」这类抖动。',
  unit: 's',
  digits: 1,
  series: [
    seriesOf('闸门开', '#2563eb', '', (r) => (r.noGate ? null : r.avgMs / 1000)),
    seriesOf('闸门关（对照）', '#94a3b8', '4 3', (r) => (r.noGate ? r.avgMs / 1000 : null)),
  ],
});

const chartAdv = advLast
  ? lineChart({
      title: '对抗守住率',
      note: '四类合计（注入 / 越权 / 超长 / 工具返回注入）。低于 90% 时 npm run eval 会直接红——它是门禁，不是参考值。',
      unit: '%',
      digits: 0,
      axis: advShown,
      series: [seriesOf('守住', '#0891b2', '', (r) => r.acc, advShown)],
    })
  : '';

const flakyTable = flaky.length
  ? `<table><thead><tr><th>用例</th><th>失败/出现</th><th>最近一次判定</th></tr></thead><tbody>${flaky
      .slice(0, 15)
      .map((t) => `<tr><td><code>${esc(t.id)}</code></td><td>${t.fail} / ${t.run}</td><td>${esc(t.reason)}</td></tr>`)
      .join('')}</tbody></table>`
  : '<p class="note">留存期内无失败用例。</p>';

const runTable = `<table><thead><tr><th>时间</th><th>闸门</th><th>通过</th><th>命中片</th><th>耗时</th><th>模型</th><th>报告</th></tr></thead><tbody>${[
  ...shown,
]
  .reverse()
  .map(
    (r) =>
      `<tr><td>${fmtTime(r.at)}</td><td>${r.noGate ? '关（对照）' : '开'}</td><td>${r.passed}/${r.total}（${Math.round(r.acc)}%）</td><td>${r.avgHits.toFixed(2)}</td><td>${(r.avgMs / 1000).toFixed(1)}s</td><td>${esc(r.model)}</td><td><code>${esc(r.file.replace(/\.json$/, ''))}</code></td></tr>`,
  )
  .join('')}</tbody></table>`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>评测趋势 · hexcore</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0 auto; max-width: 760px; padding: 32px 20px 64px; background: #f9fafb;
         font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #111827; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .sub { color: #6b7280; margin: 0 0 20px; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .kpi { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; }
  .kpi span { display: block; font-size: 12px; color: #6b7280; }
  .kpi b { font-size: 19px; font-weight: 600; }
  .kpi i { display: block; font-style: normal; font-size: 11px; color: #9ca3af; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .note { color: #6b7280; font-size: 12px; margin: 0 0 10px; }
  .kpi-src { margin: 0 0 8px; }
  .legend { font-size: 12px; margin-bottom: 4px; }
  .axis-hint { color: #9ca3af; margin-left: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #6b7280; font-weight: 500; border-bottom: 1px solid #e5e7eb; padding: 6px 8px; }
  td { border-bottom: 1px solid #f3f4f6; padding: 6px 8px; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 4px; font-size: 11px; }
  footer { color: #9ca3af; font-size: 12px; margin-top: 24px; }
</style></head>
<body>
<h1>评测趋势</h1>
<p class="sub">golden ${goldenAll.length} 份 · 对抗 ${advAll.length} 份 · ${esc(all[0].model)} · 生成于 ${fmtTime(new Date())}（本地时间）</p>
${cards}
${chartAcc}
${chartSplit}
${chartHits}
${chartMs}
${chartAdv}
<section class="card"><h2>历史不稳定用例</h2>
<p class="note">按失败次数排序。稳定失败的用例是缺陷，间歇失败的用例多半是判定器或上游抖动——两者都要修，但修法不同。</p>
${flakyTable}</section>
<section class="card"><h2>全部运行</h2>${runTable}</section>
<footer>
只统计 <code>evals/reports/*.json</code> 里的报告；删除报告等于删除历史，趋势会断。<br>
不同 golden 条数（50 / 52）之间只能比百分比与均值，不能比「通过了几条」。<br>
<code>*-adversarial.json</code> 是对抗评测：分母、达标线都与 golden 不同，因此单独成块，绝不并进同一条曲线。<br>
横向比较请用 <code>npm run eval:diff</code> 看逐条回归，本页只回答「整体在往哪走」。
</footer>
</body></html>
`;

if (wantHtml) {
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`\n[图表] ${htmlPath}`);
}
// 退出码要被夜间脚本读到，必须放在写完图表之后
if (alert) process.exitCode = 2;
console.log('');
