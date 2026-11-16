#!/usr/bin/env node
/**
 * 对比两份评测报告，回答一个具体问题：**这次改动到底让效果变好了还是变差了？**
 *
 * 用法：
 *   node evals/diff.mjs                      # 自动取 reports/ 里最近两份
 *   node evals/diff.mjs a.json b.json        # 指定基线(a) 与 对比(b)
 *
 * 为什么需要它：单看「45/50」没法判断改动好坏——模型本身有 ±1~2 条抖动，
 * 只有逐条对比「谁从通过变失败、谁从失败变通过」，才能分清「真的回归」和「抖了一下」。
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'evals', 'reports');

function latestTwo() {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    // 只比 golden：对抗报告的行是 adv-*，与 golden 的 ans-/abs- 没有可比的 id。
    // 不排除的话，跑了对抗评测之后「最近两份」会变成两份对抗报告，
    // 默认 diff 输出的「应答对 0/0 → 0/0」既无意义又不会报错——最坏的一种错。
    .filter((f) => !/-adversarial\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  if (files.length < 2) {
    console.error(`报告不足两份（当前 ${files.length} 份），先跑一次 npm run eval`);
    process.exit(1);
  }
  return [files[files.length - 2].f, files[files.length - 1].f];
}

const [aPath, bPath] = process.argv.slice(2).length >= 2 ? process.argv.slice(2) : latestTwo();
const load = (p) => JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(dir, p), 'utf8'));
const a = load(aPath);
const b = load(bPath);

const rowsOf = (r) => new Map(r.rows.map((x) => [x.id, x]));
const A = rowsOf(a);
const B = rowsOf(b);

const regressed = []; // 通过 → 失败
const fixed = []; // 失败 → 通过
for (const [id, rb] of B) {
  const ra = A.get(id);
  if (!ra) continue;
  if (ra.pass && !rb.pass) regressed.push(rb);
  if (!ra.pass && rb.pass) fixed.push(rb);
}

const fmt = (n, d) => `${n}/${d}（${Math.round((n / d) * 100)}%）`;
const d = (x, y) => {
  const v = y - x;
  return v === 0 ? '持平' : v > 0 ? `+${v}` : `${v}`;
};

console.log(`\n基线  ${aPath}`);
console.log(`对比  ${bPath}`);
console.log(`模型  ${a.summary.model}${a.summary.model !== b.summary.model ? ` → ${b.summary.model}` : ''}`);

// 两类报告的口径不同：golden 看「答对/拒答/检索命中」，对抗看「守住/护栏命中/分类」。
// 一份 golden 一份对抗没法逐条比（id 空间都不一样），必须明确拒绝而不是打印一排 undefined。
const isAdv = (r) => Array.isArray(r?.summary?.byCategory);
const bothAdv = isAdv(a) && isAdv(b);
if (isAdv(a) !== isAdv(b)) {
  console.error('两份报告口径不同（一份 golden、一份对抗），无法逐条对比。请用同类报告对比。');
  process.exit(1);
}

if (bothAdv) {
  console.log(`口径  对抗评测（通过线 ${Math.round((a.summary.passLine ?? 0.9) * 100)}%）`);
  console.log('');
  console.log(`守住        ${fmt(a.summary.passed, a.summary.total)} → ${fmt(b.summary.passed, b.summary.total)}   ${d(a.summary.passed, b.summary.passed)}`);
  console.log(`护栏命中    ${a.summary.guarded ?? 0}/${a.summary.total} → ${b.summary.guarded ?? 0}/${b.summary.total}（召回，不计入通过判定）`);
  const catB = new Map((b.summary.byCategory || []).map((c) => [c.category, c]));
  for (const ca of a.summary.byCategory || []) {
    const cb = catB.get(ca.category);
    if (cb) console.log(`  ${String(ca.category).padEnd(24)} ${ca.passed}/${ca.total} → ${cb.passed}/${cb.total}`);
  }
} else {
  console.log(`闸门  ${a.summary.noGate ? '关' : '开'} → ${b.summary.noGate ? '关' : '开'}`);
  console.log('');
  console.log(`总通过      ${fmt(a.summary.passed, a.summary.total)} → ${fmt(b.summary.passed, b.summary.total)}   ${d(a.summary.passed, b.summary.passed)}`);
  console.log(`应答对      ${fmt(a.summary.answer.passed, a.summary.answer.total)} → ${fmt(b.summary.answer.passed, b.summary.answer.total)}   ${d(a.summary.answer.passed, b.summary.answer.passed)}`);
  console.log(`应拒答      ${fmt(a.summary.abstain.passed, a.summary.abstain.total)} → ${fmt(b.summary.abstain.passed, b.summary.abstain.total)}   ${d(a.summary.abstain.passed, b.summary.abstain.passed)}`);
  console.log(`检索命中    ${fmt(a.summary.citation.passed, a.summary.citation.total)} → ${fmt(b.summary.citation.passed, b.summary.citation.total)}   ${d(a.summary.citation.passed, b.summary.citation.passed)}`);
  console.log(`平均耗时    ${a.summary.avgMs}ms → ${b.summary.avgMs}ms`);
}

if (regressed.length) {
  console.log('\n## 回归（通过 → 失败）—— 这些才是要盯的');
  for (const r of regressed) console.log(`  ${r.id.padEnd(8)} ${r.reason}`);
}
if (fixed.length) {
  console.log('\n## 修复（失败 → 通过）');
  for (const r of fixed) console.log(`  ${r.id.padEnd(8)} ${r.reason}`);
}
if (!regressed.length && !fixed.length) {
  console.log('\n两种状态都没有条目变化，差异仅来自模型抖动。');
}

// 检索质量变化：hits 数量与 top1 分，与「答对率」无关但能解释原因。
// 对抗报告没有 hits / topScore 字段（它直接调模型、不走向量检索），跳过这一段，
// 否则 `undefined.toFixed` 会直接抛异常，把整份对比打断。
if (!bothAdv) {
  const hitDrops = [];
  for (const [id, rb] of B) {
    const ra = A.get(id);
    if (!ra) continue;
    if (ra.hits - rb.hits >= 2 || rb.topScore - ra.topScore <= -0.1) {
      hitDrops.push({ id, from: `${ra.hits} 片/${ra.topScore.toFixed(3)}`, to: `${rb.hits} 片/${rb.topScore.toFixed(3)}` });
    }
  }
  if (hitDrops.length) {
    console.log('\n## 检索侧变化较明显的用例（命中片数 / top1 分）');
    for (const h of hitDrops) console.log(`  ${h.id.padEnd(8)} ${h.from} → ${h.to}`);
  }
}
console.log('');
