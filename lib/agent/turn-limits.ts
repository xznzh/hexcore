/**
 * 单轮工具策略的**唯一真相源**（V8.3 · O2）。
 *
 * 命名说明：这里管的是「一轮对话允许几次工具调用」（**turn** limits，纯常量与文案）；
 * `lib/tools/policy.ts` 管的是「单次工具调用怎么执行」（超时 / 截断 / 审计）。
 * 两者名字相近但职责不相交，刻意分开，避免又一个「什么都往里塞」的公共模块。
 *
 * 为什么要有这个文件：同一件事曾在三处各写一个数字——
 *   - 提示词：`最多调用 3 次工具`（`chat/route.ts` 的 TOOL_DISCIPLINE 字面量）
 *   - 执行层：`maxSameToolCalls: 4`（loop-guard 入参）
 *   - 主循环：`maxSteps = 5`（streamText 入参）
 * 改一处不会带动另两处，必然漂移；而漂移的后果是「提示词说的」和「执行层真的会拦的」
 * 对不上——模型被允许的步数比它被告知的多，或者反过来被提前掐断。
 *
 * 但**不能强行同源**：这三个数语义不同。
 *   - MAX_TOOL_CALLS_PER_TURN：给模型看的软约束，「够用即停」的次数建议；
 *   - MAX_SAME_TOOL_CALLS：执行层对**单个工具成功次数**的硬上限（失败不计，允许换参重试）；
 *   - MAX_IDENTICAL_CALLS：执行层对**完全相同参数**的短路次数；
 *   - MAX_TOOL_STEPS：主循环的**总步数**（工具步 + 正文步）。
 *
 * 真正共享的只有「本轮意图允许几次工具调用」这一个数。这里把派生关系写死成公式，
 * 单测锁的也是派生关系而不是数值相等——否则有人把 MAX_TOOL_STEPS 调成 8，
 * 测试会因为「不等于 5」而报警，却说不清到底哪里错了。
 */

/** 提示词里告诉模型「最多几次」；也是下面所有上限的基准 */
export const MAX_TOOL_CALLS_PER_TURN = 3;

/**
 * 主循环总步数 = 工具步 + 1 个正文步 + 1 步余量。
 *
 * 为什么留余量：模型可能先调一次工具、再补一次修正调用，最后才出正文。
 * 卡成「工具次数 + 1」时，任何一次多余的探测都会让最后那段正文没机会生成，
 * 用户看到的是「工具跑完了但没回答」（空答兜底会救一次，但那是多花一次 LLM 调用）。
 */
export const MAX_TOOL_STEPS = MAX_TOOL_CALLS_PER_TURN + 2;

/**
 * 单工具成功次数的硬上限。
 *
 * 取 `MAX_TOOL_CALLS_PER_TURN + 1` 而不是相等：提示词是软约束，模型不遵守时
 * 执行层要能给一次容错（比如第一次结果为空、换参数再查一次），但不能再多。
 */
export const MAX_SAME_TOOL_CALLS = MAX_TOOL_CALLS_PER_TURN + 1;

/** 完全相同参数的调用只允许 1 次，第 2 次直接回放上次结果，不再花钱 */
export const MAX_IDENTICAL_CALLS = 1;

/**
 * 工具使用纪律提示词。数字全部从上面派生，改常量即改文案。
 *
 * 保留原文案的结构与语气：它是 2026-11 对抗评测逐条调出来的，
 * 每条都对应一次实测失败（思考型模型无限检索、只调工具不出正文、过渡句用英文）。
 */
export function toolDiscipline(maxCalls: number = MAX_TOOL_CALLS_PER_TURN): string {
  return (
    '\n\n【工具使用纪律，必须严格遵守】\n' +
    `- 最多调用 ${maxCalls} 次工具（检索/查询），够用即停。\n` +
    '- 拿到所需信息后，必须立即停止调用工具，直接输出对用户的最终回答。\n' +
    `- 即使第 ${maxCalls} 次工具调用后信息仍不完整，也必须基于已有结果给出回答，并明确说明还差哪些信息。\n` +
    '- 最后一步务必输出正文文字；只输出工具调用而不输出文字是不允许的。\n' +
    '- 所有面向用户的文字（包括「我先检索一下…」这类过渡句）都必须是简体中文；内部推理不受限制。'
  );
}

/**
 * 历史上下文预算（电压）：原为固定 6000 token，128k 模型与 8k 模型同等待遇。
 *
 * 用 `max` 而不是 `min`：`min` 会让 128k 场景原地不动（上界就是 6000），
 * 8k 场景反而从 6000 掉到 1229——两头都错。这里要的是「至少 6000，大模型给更多」。
 *
 * 上限 30000 是刻意留的：历史越长，越容易把检索资料与当前问题挤出注意力焦点，
 * 而且历史是每轮全价重算的部分（前缀缓存也救不了新增的历史）。
 */
export function historyTokenBudget(
  ctxLen: number,
  // 用 Record 而不是 NodeJS.ProcessEnv：后者要求 NODE_ENV 必填，
  // 单测里传 `{}` 或 `{ CHAT_HISTORY_TOKEN_BUDGET: '1234' }` 会被类型挡在门外，
  // 逼得测试去改全局 env（有污染风险）。这里只需要「能读到几个字符串」。
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env.CHAT_HISTORY_TOKEN_BUDGET;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const byModel = Number.isFinite(ctxLen) && ctxLen > 0 ? Math.floor(ctxLen * 0.15) : 0;
  return Math.max(6000, Math.min(30_000, byModel));
}
