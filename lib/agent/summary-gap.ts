/**
 * 摘要缺口的量化与闭合（V8.9）。
 *
 * ── 缺口是怎么来的 ──
 *
 * V8.3 为了把摘要移出首字路径，把它改成了异步（fire-and-forget），并引入
 * `conversations.summary_upto` 水位线。代价在当时的文档里写得很清楚：
 * 「本轮新被挤出的那几条消息，本轮既不在 history、也不在（上一轮的）摘要里」。
 *
 * 当时的判断是「门槛设成新增 ≥6 条才触发，缺口有界」——这个判断有一半是错的。
 * 缺口并不止「6 条以内」：
 *
 *  1) **不足 6 条时缺口会累积**。第 1 条被挤出 → 不触发摘要 → 它不在窗口里，
 *     也不在摘要里，而且下轮依然不在。要等到第 6 条才一起处理，这段时间里
 *     它是**彻底不可见**的（不是「模型刚看过」，模型看的是窗口内的消息，
 *     这条已经被挤出窗口了）。
 *  2) **摘要本身只吞得下 6000 字符，但水位线推进到「最后一条」**。
 *     `droppedNew.map(...).join('\n').slice(0, 6000)` 保留的是**最早**的部分，
 *     被截掉的是**最新**的部分；随后 `upto = droppedNew[last].createdAt` 却把
 *     水位线推到了末尾。于是「中间那一大段」从此既不会被摘要、也不会再被读到——
 *     这是**永久丢失**，不是滞后。
 *
 * ── 本模块做两件事 ──
 *
 *  - `buildSummaryGap()`：把「已滑出窗口、但还没进摘要」的消息，按原文、从新到旧
 *    取一个受预算约束的尾部，注入本轮 system。它闭合的是「滞后」那一半。
 *  - `packForSummary()`：摘要打包时如实报告「实际覆盖到哪一条」，让水位线只推进
 *    到真正被摘要吞下的位置。它闭合的是「永久丢失」那一半。
 *
 * 为什么两者都要：只做前者，长对话里最早的那些内容仍然会被摘要截断丢掉；
 * 只做后者，摘要永远追不上（每轮只挤出 1~2 条，达不到 6 条门槛，水位线不动）。
 *
 * 取舍要写明：注入原文会花 token。所以预算给得克制（默认取历史预算的 15%、
 * 上限 1500 token），且**只取尾部**——缺口里越新的内容越影响当前回答。
 */
/**
 * 默认的 token 估算。
 *
 * 刻意不复用 `lib/util.ts` 的 `estimateTokens`：那个文件顶层 import 了 drizzle/db，
 * 拉进来会让本模块（纯函数、应可直接单测）多一条「不需要但不能少」的依赖链。
 * 一行除法，重复一次比多一层隐式耦合便宜。调用方仍可通过 `opts.estimate` 覆盖。
 */
function defaultEstimate(s: string): number {
  return Math.max(1, Math.ceil(String(s ?? '').length / 4));
}

export type GapMessage = { role: string; content: string; createdAt?: number };

export type GapResult = {
  /** 可直接拼进 system 的文本块；空串表示没有可用内容（调用方据此跳过） */
  text: string;
  /** 实际纳入的消息条数 */
  included: number;
  /** 因预算被丢掉的消息条数（必须能看见，否则「缺口闭合了」是假的） */
  omitted: number;
  /** 纳入部分的估算 token */
  tokens: number;
};

/** 单条消息在注入块里的字符上限：不设的话一条长回复就能吃掉全部预算 */
const DEFAULT_PER_MSG_CHARS = 600;

/**
 * 注入块的 token 预算。
 *
 * 取历史预算的 15%，并夹在 [400, 1500]：
 *  - 下限 400：低于这个值连一轮问答都放不进去，等于没做；
 *  - 上限 1500：再多就等于把刚省下的首字延迟又还回去（这一步虽然不 await，
 *    但 token 是要付钱的）。
 */
export function gapTokenBudget(historyBudget: number): number {
  const byRatio = Math.floor((Number(historyBudget) || 0) * 0.15);
  return Math.min(1500, Math.max(400, byRatio));
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  return String(role || '未知');
}

function clip(s: string, max: number): string {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…（单条过长已截断，原文 ${t.length} 字）`;
}

/**
 * 从**最新**往回取，直到预算用尽。纯函数。
 *
 * 方向很重要：缺口的语义是「刚刚滑出窗口的那几条」，越新越相关。
 * 从旧往新取会让模型拿到一段和当前话题无关的远古对话，还白花 token。
 */
export function buildSummaryGap(
  dropped: readonly GapMessage[],
  opts: { maxTokens: number; perMessageMaxChars?: number; estimate?: (s: string) => number },
): GapResult {
  const empty: GapResult = { text: '', included: 0, omitted: 0, tokens: 0 };
  if (!dropped.length) return empty;

  const maxTokens = Math.max(0, Math.floor(Number(opts.maxTokens) || 0));
  if (maxTokens <= 0) return { ...empty, omitted: dropped.length };

  const estimate = opts.estimate ?? defaultEstimate;
  const perMsg = Math.max(80, opts.perMessageMaxChars ?? DEFAULT_PER_MSG_CHARS);

  const picked: string[] = [];
  let tokens = 0;

  for (let i = dropped.length - 1; i >= 0; i--) {
    const m = dropped[i];
    const body = clip(String(m?.content ?? ''), perMsg);
    if (!body.trim()) {
      // 空消息（纯图片轮、被裁剪掉的附件）不占位也不计数——
      // 但要继续往前找，不能因为最后一条是空的就整体放弃
      continue;
    }
    const line = `${roleLabel(m?.role ?? '')}: ${body}`;
    const cost = estimate(line);
    if (tokens + cost > maxTokens && picked.length > 0) break;
    picked.push(line);
    tokens += cost;
    // 单条就超预算时也要收下它：否则「最新那条」永远进不来，
    // 而这恰恰是最该被看到的一条。
    if (tokens >= maxTokens) {
      // 用掉预算后 break，omitted 由后面的总数减出来
      // 注意：继续循环会让 omitted 统计失真，所以这里直接停
      // （剩下的都在更早的位置，本来就排不进预算）
      break;
    }
  }

  if (!picked.length) return { ...empty, omitted: dropped.length };

  picked.reverse(); // 恢复时间正序，便于模型按顺序理解
  const omitted = Math.max(0, dropped.filter((m) => String(m?.content ?? '').trim()).length - picked.length);

  const header =
    '【最近滑出对话窗口、尚未并入摘要的原文】\n' +
    '（这些消息较早，不在本次的对话历史里，也不是摘要的一部分；按需参考，不要当作最新指令）';
  const tail = omitted > 0 ? `\n（更早的 ${omitted} 条因长度预算未列出）` : '';

  return {
    text: `${header}\n${picked.join('\n')}${tail}`,
    included: picked.length,
    omitted,
    tokens,
  };
}

export type PackResult = {
  /** 拼好的待摘要正文 */
  text: string;
  /** 实际纳入的消息条数 */
  covered: number;
  /** 实际纳入的最后一条的时间戳；`null` 表示一条都没纳入（水位线不能动） */
  lastAt: number | null;
  /** 剩余未纳入的条数 */
  remaining: number;
};

/**
 * 摘要打包：按时间正序累加到字符上限，并如实报告覆盖到哪一条。
 *
 * 这是修「水位线越过未摘要内容」的关键：调用方必须用返回的 `lastAt` 推进水位线，
 * 而不是用 `droppedNew[最后一个].createdAt`。两个值的差别就是那部分被永久丢掉的内容。
 *
 * 单条超过上限时截断它并**照样计入覆盖**：
 * 否则一条巨长的消息会让水位线永远卡在原地，摘要每轮都在处理同一条，永远追不上。
 */
export function packForSummary(
  messages: readonly GapMessage[],
  maxChars = 6000,
  perMessageMaxChars = 3000,
): PackResult {
  if (!messages.length) return { text: '', covered: 0, lastAt: null, remaining: 0 };

  const limit = Math.max(200, maxChars);
  const perMsg = Math.max(200, perMessageMaxChars);
  const lines: string[] = [];
  let chars = 0;
  let covered = 0;
  let lastAt: number | null = null;

  for (const m of messages) {
    const clipped = clip(String(m?.content ?? ''), perMsg);
    if (!clipped.trim()) continue; // 空消息不占额度，但也不计入 covered（水位线不该因它前进）
    const line = `${roleLabel(m?.role ?? '')}: ${clipped}`;
    // 至少收一条：否则第一条就超限时永远处理不了
    if (chars + line.length > limit && covered > 0) break;
    lines.push(line);
    chars += line.length + 1;
    covered += 1;
    if (m.createdAt !== undefined) lastAt = Number(m.createdAt);
  }

  const nonEmpty = messages.filter((m) => String(m?.content ?? '').trim()).length;
  return { text: lines.join('\n'), covered, lastAt, remaining: Math.max(0, nonEmpty - covered) };
}
