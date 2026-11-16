/**
 * 从模型调用的返回值里读用量（纯函数）。
 *
 * 为什么值得单独一个文件：字段名在不同 SDK 版本里不一样——v3/v4 是
 * `promptTokens` / `completionTokens`，v5 改成了 `inputTokens` / `outputTokens`。
 * 读错名字不会报错，只会让 `promptTokens` 长期为 `null`，而成本看板照样显示
 * 一个"看起来有数"的金额（因为 total 还在）。这类**静默为空**最难发现，
 * 所以把三种形态都显式写出来，并用单测钉住。
 *
 * 另一个坑：`streamText` 的 `usage` 是 Promise。这里只读同步属性，
 * 碰到 thenable 直接返回空对象，绝不 await——埋点不能拖慢流式返回。
 */

export type TokenUsage = {
  /** 总用量：有 totalTokens 就用它，否则用输入 + 输出相加 */
  total?: number;
  prompt?: number;
  completion?: number;
};

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * @param raw `generateText` / `streamText` 的 `usage`（或已 await 的结果）
 * @returns 拿不到的字段为 undefined，调用方按"未知"处理，不要当成 0
 */
export function readTokenUsage(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== 'object') return {};
  // thenable = 还没结束的流式 usage 承诺；读它的属性只会拿到 undefined
  if (typeof (raw as any).then === 'function') return {};

  const o = raw as Record<string, unknown>;
  const prompt = num(o.promptTokens) ?? num(o.inputTokens);
  const completion = num(o.completionTokens) ?? num(o.outputTokens);
  const total = num(o.totalTokens) ?? (prompt !== undefined || completion !== undefined ? (prompt ?? 0) + (completion ?? 0) : undefined);

  return { total, prompt, completion };
}
