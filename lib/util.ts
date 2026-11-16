import { db } from './db';
import { operationLogs, usage } from './schema';
import { and, eq, sql } from 'drizzle-orm';
import { traceTag, getTraceId } from './trace';

export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function periodNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 记录操作日志（失败不影响主流程）
export type LogMeta = { status?: string; durationMs?: number; detail?: string };

export async function logAction(
  userId: string | undefined,
  action: string,
  target?: string,
  meta?: LogMeta,
) {
  try {
    // 自动带上当前请求的 traceId：一次对话里的检索/工具/审批/落库会写多行日志，
    // 有 `[trace:xxx]` 前缀才能按链路还原（detail 也兼容原来的自由文本）
    const tag = traceTag();
    const detail = meta?.detail ? tag + String(meta.detail).slice(0, 3800) : tag || null;
    await db.insert(operationLogs).values({
      id: newId('log'),
      userId: userId || null,
      action,
      target: target || null,
      status: meta?.status || null,
      durationMs: meta?.durationMs ?? null,
      detail: detail ?? null,
      // V8.10：traceId 同时落真列。detail 里的前缀保留——v8.7 的通道健康度解析
      // 与历史日志的肉眼检索都依赖它，且这条写入路径是旁路，多存一个字段换两处兼容，值。
      traceId: getTraceId() || null,
      createdAt: Date.now(),
    });
  } catch {
    // ignore
  }
}

// token 估算：约 字符数 / 4
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Promise 超时封装：在 ms 内未 settle 则 reject（带友好中文错误信息）。
 * 用于给「无原生超时」的外部调用（RAG 检索 / 文件读取 / 任意 await）兜底，避免挂死拖垮整条链路。
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, msg?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(msg || `操作超时（${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// 累加用户当月用量（原子 upsert：避免并发下「查-改/插」竞态导致的漏算或重复行）
export async function addUsage(userId: string, tokens: number) {
  const period = periodNow();
  await db
    .insert(usage)
    .values({ id: newId('usg'), userId, period, tokensUsed: tokens })
    .onConflictDoUpdate({
      target: [usage.userId, usage.period],
      set: { tokensUsed: sql`${usage.tokensUsed} + ${tokens}` },
    });
}
