import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * 请求级链路追踪（轻量版，无外部依赖）。
 *
 * 为什么需要：一次对话可能触发「检索 → 多次工具调用 → 多轮模型调用 → 审批 → 落库」，
 * 分散在 operation_logs 里的多行日志彼此没有关联字段，排障时只能靠时间戳猜。
 * 这里给每个入口请求一个 traceId，用 AsyncLocalStorage 在异步调用链里透传，
 * 写日志时自动带上，于是「按 traceId 查日志」就能还原整条链路。
 *
 * 不用 OpenTelemetry 的原因：单机 Next.js 进程内，ALS + 一条 detail 字段即可覆盖；
 * 需要跨服务时再把 traceId 塞进 W3C traceparent 即可平滑演进。
 */

export type TraceCtx = {
  traceId: string;
  userId?: string;
  /** 入口标识，如 chat / skill:run / schedule / api */
  entry?: string;
};

const storage = new AsyncLocalStorage<TraceCtx>();

/** 生成 traceId：带前缀便于日志里肉眼识别（16 位十六进制，足够单机唯一） */
export function newTraceId(): string {
  return 'tr' + randomUUID().replace(/-/g, '').slice(0, 16);
}

/** 在指定 trace 上下文里执行 fn（同步/异步都支持） */
export function runWithTrace<T>(ctx: Partial<TraceCtx>, fn: () => T): T {
  const traceId = ctx.traceId || newTraceId();
  return storage.run({ traceId, userId: ctx.userId, entry: ctx.entry }, fn);
}

/** 取当前 traceId；不在上下文里时返回 undefined（调用方自行决定是否补一个） */
export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

export function getTrace(): TraceCtx | undefined {
  return storage.getStore();
}

/**
 * 从请求头取 traceId（中间件写入 x-trace-id），没有则新建。
 * 中间件已保证同一请求内各 route 拿到同一个 id；这里兜底直连场景（如单测、脚本）。
 */
export function traceIdFromHeaders(headers: { get(name: string): string | null }): string {
  const h = headers.get('x-trace-id');
  if (h && /^[\w-]{4,64}$/.test(h)) return h;
  return newTraceId();
}

/** 日志用前缀：`[trace:xxx]`，写进 detail 字段即可按 id 检索 */
export function traceTag(): string {
  const id = getTraceId();
  return id ? `[trace:${id}] ` : '';
}
