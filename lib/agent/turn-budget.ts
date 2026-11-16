/**
 * 单轮对话的 Token 预算闸门。
 *
 * 要解决的问题：`app/api/chat/route.ts` 原来只在请求前估算「输入 + 400」，
 * 但一次请求最多 `maxSteps(5) × maxTokens(8192)` 的输出；而额度扣减发生在事后
 * （`addUsage`），所以「用超了再拦」等于没拦 —— 单轮可以烧掉估算值的数十倍。
 *
 * 实现取舍：不改 `streamText` 的调用方式，只提供累计与判定。调用方在
 * `onStepFinish` 里累加，超限时 abort 自己持有的 AbortController，再与
 * 「断连 / 超时」那条 signal 合并 —— 中止路径复用已有的错误提示与半截落库逻辑。
 *
 * 多步时的口径：`ai@4.3.x` 的 `StreamTextResult.usage` 在多步下是各步之和，
 * 但 `onStepFinish` 给的是**单步** usage，所以这里必须自己累加。
 */

export type TurnBudget = {
  /** 上限，0 表示不限制 */
  readonly limit: number;
  /** 已累计消耗（含所有步） */
  used(): number;
  /** 累加本步 token；返回 true 表示已超预算，调用方应中止 */
  add(stepTokens: number): boolean;
};

export function createTurnBudget(limit: number): TurnBudget {
  let used = 0;
  return {
    limit,
    used: () => used,
    add(stepTokens: number) {
      const n = Number(stepTokens);
      used += Number.isFinite(n) && n > 0 ? n : 0;
      return limit > 0 && used > limit;
    },
  };
}

/**
 * 默认单轮上限 6 万 token（含工具多步）。
 *
 * 为什么不是更小：思考型模型（如 MiniMax-M3.x）的推理 token 也计入，
 * 正常 3 步内的对话远低于此；卡太紧会把正常长回答打断。
 * `CHAT_TURN_TOKEN_BUDGET=0` 可完全关闭（应急开关，不建议长期关）。
 */
export function turnBudgetFromEnv(): number {
  const raw = process.env.CHAT_TURN_TOKEN_BUDGET;
  // 注意不能写成 `Number(process.env.X || '')`：Number('') 是 0 而不是 NaN，
  // 会让「没配这个变量」被当成「显式关闭预算」，闸门静默失效。
  if (raw === undefined || raw.trim() === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}
