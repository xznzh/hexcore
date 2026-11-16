/**
 * 工具调用幂等（V8 · R3 / V8.2 · C1 落库）。
 *
 * 要解决的问题：`streamText` 在瞬时错误时会重试同一步，工具 execute 可能被**重放**——
 * `create_todo` 会建出两条重复待办，`run_skill` 会把多 Agent 工作流跑两遍（真金白银的 token），
 * `generate_ppt` 会生成两份 PPT 并各占一份产物，`call_connector` 会对下游重复下单/重复提交。
 *
 * 两层去重，各管一件事：
 *  - **内存层（热路径）**：同一进程内的并发重放。存的是 Promise 而不是结果，
 *    所以并发的第二个调用会**共享同一个 promise**，既不会双写，也不用等第一次跑完再查表。
 *  - **DB 层（账本）**：跨请求、跨进程、进程重启后的重放。`idempotency_keys` 的主键
 *    就是幂等键，插入成功即「抢到执行权」；别人抢到时读它的结果。
 *
 * 为什么 DB 层失败不能让工具调用失败：幂等是**增强**，不是业务前置条件。数据库抖一下
 * 就拒绝用户建待办，是把可用性拿去换一个边缘正确性。所以 DB 任何异常都退回纯内存，
 * 并明确打一条 warn，而不是静默——静默降级会让人以为账本在工作。
 */

import { db } from '../db';
import { idempotencyKeys } from '../schema';
import { and, eq, lt } from 'drizzle-orm';

type Entry = { at: number; promise: Promise<Outcome<unknown>> };
export type Outcome<T> = { value: T; deduped: boolean };

const store = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

/** 抢到执行权后的结果 */
type Claim = { type: 'claimed' } | { type: 'done'; value: unknown } | { type: 'busy' } | null;

/**
 * 是否启用 DB 账本。
 * - `IDEMPOTENCY_STORE=memory` 强制关闭（压测 / 排障 / 无库环境）
 * - `IDEMPOTENCY_STORE=db` 强制开启（CI 里专门验证落库路径）
 * - 未设置时：单测环境走内存（常规单测必须零 I/O），其余走 DB
 */
export function persistentEnabled(): boolean {
  const mode = (process.env.IDEMPOTENCY_STORE || '').toLowerCase();
  if (mode === 'memory') return false;
  if (mode === 'db') return true;
  return process.env.NODE_ENV !== 'test';
}

/** 浅层稳定序列化：对象键排序，保证「同参数不同键序」生成同一个 key */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** 构造工具幂等键：会话 + 工具名 + 规范化参数 */
export function makeToolKey(conversationId: string, toolName: string, args: unknown): string {
  return `${conversationId || '-'}::${toolName}::${stableStringify(args)}`;
}

/** 结果序列化：包一层 `{v}`，这样 `undefined` / `null` 也能与「没有结果」区分开 */
function packResult(value: unknown): string | null {
  try {
    return JSON.stringify({ v: value });
  } catch {
    // 含循环引用 / BigInt / 函数的返回值不落库：仍然执行，只是这一条不能跨进程去重
    return null;
  }
}

function unpackResult(raw: string | null): { ok: boolean; value?: unknown } {
  if (!raw) return { ok: false };
  try {
    const p = JSON.parse(raw);
    return { ok: true, value: p?.v };
  } catch {
    return { ok: false };
  }
}

let lastSweep = 0;
/** 过期行清理：懒触发，不做后台定时器（单实例不需要额外的常驻任务） */
function sweepExpired(): void {
  const now = Date.now();
  if (now - lastSweep < 300_000) return;
  lastSweep = now;
  // 多留 60s 余量：避免刚过期就被删、而另一个进程正好在同一瞬间读取
  db.delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, now - 60_000))
    .catch(() => {});
}

/** 轮询等待别的进程把结果写回来（最多 timeoutMs） */
async function waitForDone(
  key: string,
  timeoutMs: number,
): Promise<{ found: boolean; value?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const row = (
      await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).limit(1)
    )[0];
    if (!row) return { found: false };
    if (row.status === 'done') {
      const u = unpackResult(row.result);
      if (u.ok) return { found: true, value: u.value };
      return { found: false };
    }
  }
  return { found: false };
}

/**
 * 抢执行权。
 * 返回 null 表示「DB 不可用」——调用方应退回纯内存语义继续执行。
 */
async function tryClaim(key: string, expiresAt: number): Promise<Claim> {
  const now = Date.now();
  try {
    // 1) 主键插入即抢锁：并发下只有一个进程能插进去
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ key, status: 'running', result: null, createdAt: now, expiresAt })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length) {
      sweepExpired();
      return { type: 'claimed' };
    }

    // 2) 已存在：若已过期则接管（条件更新，天然防止两个进程同时接管）
    const took = await db
      .update(idempotencyKeys)
      .set({ status: 'running', result: null, createdAt: now, expiresAt })
      .where(and(eq(idempotencyKeys.key, key), lt(idempotencyKeys.expiresAt, now)))
      .returning({ key: idempotencyKeys.key });
    if (took.length) return { type: 'claimed' };

    const row = (
      await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).limit(1)
    )[0];
    // 极端竞态：刚好被清理掉了，当作自己抢到（总比不执行安全）
    if (!row) return { type: 'claimed' };

    if (row.status === 'done') {
      const u = unpackResult(row.result);
      // 结果落库失败（不可序列化）时不能当作命中，否则会返回一个空结果给模型
      return u.ok ? { type: 'done', value: u.value } : { type: 'claimed' };
    }

    // 3) 别人正在跑：等一小会儿，等到就复用，等不到就自己执行
    const waited = await waitForDone(key, 3000);
    if (waited.found) return { type: 'done', value: waited.value };
    return { type: 'busy' };
  } catch (e) {
    console.warn(
      `[idempotency] 账本不可用，本次降级为进程内去重：${String((e as Error)?.message || e).slice(0, 160)}`,
    );
    return null;
  }
}

async function markDone(key: string, value: unknown, expiresAt: number): Promise<void> {
  const raw = packResult(value);
  await db
    .update(idempotencyKeys)
    .set({ status: 'done', result: raw, expiresAt })
    .where(eq(idempotencyKeys.key, key));
}

/** 失败时释放：失败不是「已完成」，必须允许后续重试 */
async function release(key: string): Promise<void> {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
}

async function execute<T>(key: string, fn: () => Promise<T>, ttlMs: number): Promise<Outcome<T>> {
  if (!persistentEnabled()) {
    return { value: await fn(), deduped: false };
  }

  const claim = await tryClaim(key, Date.now() + ttlMs);

  // DB 不可用：退回纯内存语义，本次照常执行
  if (claim === null) return { value: await fn(), deduped: false };

  if (claim.type === 'done') {
    return { value: claim.value as T, deduped: true };
  }

  // claimed / busy 都要真正执行一次
  try {
    const value = await fn();
    // 记账失败不影响已经产生的结果：工具副作用已经发生了，不能因为写账本失败就报错
    await markDone(key, value, Date.now() + ttlMs).catch(() => {});
    return { value, deduped: false };
  } catch (e) {
    await release(key).catch(() => {});
    throw e;
  }
}

/**
 * 同一 key 在 ttlMs 内只执行一次：
 * - 内存命中 → 复用同进程里的那次执行（deduped=true）；
 * - 账本里已完成 → 直接返回上次结果（deduped=true），跨进程也成立；
 * - 执行中     → 先等同进程的 promise / 短暂等账本，避免并发双写；
 * - 失败       → 释放条目，允许后续重试（失败不是「已完成」）。
 */
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs = 120_000,
): Promise<Outcome<T>> {
  const t = Date.now();
  const hit = store.get(key);
  if (hit && t - hit.at < ttlMs) {
    const prev = (await hit.promise) as Outcome<T>;
    return { value: prev.value, deduped: true };
  }

  // 容量保护：超过上限时清理过期项（懒清理，避免后台定时器）
  if (store.size >= MAX_ENTRIES) {
    for (const [k, e] of store) {
      if (t - e.at >= ttlMs) store.delete(k);
    }
    if (store.size >= MAX_ENTRIES) store.clear();
  }

  const task = execute(key, fn, ttlMs);
  // 必须在 await 之前入表：否则并发进来的第二个调用看不到条目，会各跑一遍
  store.set(key, { at: t, promise: task as Promise<Outcome<unknown>> });
  try {
    return await task;
  } catch (err) {
    store.delete(key);
    throw err;
  }
}

/** 测试用：清空内部状态 */
export function resetIdempotencyForTests(): void {
  store.clear();
  lastSweep = 0;
}

/** 测试用：当前条目数 */
export function idempotencySize(): number {
  return store.size;
}
