import Redis from 'ioredis';

// Redis 为可选基础设施：未配置 REDIS_URL 时所有调用自动降级（放行/跳过），不影响主流程。
let client: Redis | null = null;
let initialized = false;

/** 限流/缓存用的轻量客户端（懒连接，离线即降级） */
export function getRedis(): Redis | null {
  if (initialized) return client;
  initialized = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    client.on('error', () => {
      /* 静默：离线时降级 */
    });
  } catch {
    client = null;
  }
  return client;
}

/**
 * BullMQ 需要独立的、非懒连接的 Redis 客户端，且 maxRetriesPerRequest 必须为 null。
 * 无 REDIS_URL 时返回 null（调用方应跳过队列）。
 * 注意：必须挂 error 监听器 —— 否则 Redis 不可用时 ioredis 的 'error' 事件无人处理，
 * Node 会因「未处理的 error 事件」直接抛异常（表现为接口报错 + 进程日志刷屏）。
 */
export function getBullConnection(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const conn = new Redis(url, { maxRetriesPerRequest: null });
    conn.on('error', () => {
      /* 静默：Redis 不可用时由调用方降级 */
    });
    return conn;
  } catch {
    return null;
  }
}

/**
 * 优雅关闭：释放限流/缓存用的连接。
 * 不关也没关系（进程退出时内核会回收），但滚动发布时留着会占住 Redis 的
 * maxclients 名额，密集重启可能撞上限。BullMQ 的专用连接由 lib/queue 负责。
 */
export async function closeRedis(): Promise<void> {
  const c = client;
  client = null;
  initialized = false;
  if (!c) return;
  try {
    await c.quit();
  } catch {
    // 未连接 / 已断开时 quit 会 reject，disconnect 是同步的兜底
    try {
      c.disconnect();
    } catch {
      /* 已断开 */
    }
  }
}

/**
 * 一次性探测客户端：用于「Redis 到底通不通」的快速判断。
 * 带 error 监听 + 不排队离线命令，探测完立即断开，避免连接泄漏与日志刷屏。
 */
export async function pingRedis(timeoutMs = 1500): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  let conn: Redis | null = null;
  try {
    conn = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null, // 不重试，失败即返回
    });
    conn.on('error', () => {
      /* 静默 */
    });
    await Promise.race([
      conn.ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      conn?.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 进程内滑动窗口限流：没有 Redis（或 Redis 不可用）时的兜底。
 * 只对当前实例生效，多实例部署时每实例各算一份；单机/小团队足够挡住误触发的刷屏。
 * 命中记录超过窗口自动清理，避免 Map 无限增长。
 */
export class MemoryRateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly maxKeys = 5000) {}

  /** now 参数仅用于测试注入时间 */
  check(key: string, max: number, windowSec = 60, now = Date.now()): boolean {
    const windowMs = Math.max(1, windowSec) * 1000;
    if (this.hits.size > this.maxKeys || now - this.lastSweep > windowMs) this.sweep(now, windowMs);
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  private sweep(now: number, windowMs: number) {
    this.lastSweep = now;
    for (const [k, arr] of this.hits) {
      const last = arr[arr.length - 1] || 0;
      if (now - last >= windowMs) this.hits.delete(k);
    }
    // 极端情况下仍然过多：直接清空，宁可放宽一次也不占内存
    if (this.hits.size > this.maxKeys) this.hits.clear();
  }

  /** 仅供测试/诊断 */
  get size() {
    return this.hits.size;
  }
}

const memoryLimiter = new MemoryRateLimiter();

/**
 * 滑动窗口限流：windowSec 内最多 max 次。
 * 优先用 Redis（多实例共享）；未配置或连接异常时退回进程内计数，绝不阻断业务。
 */
export async function checkRateLimit(key: string, max: number, windowSec = 60): Promise<boolean> {
  const r = getRedis();
  if (!r) return memoryLimiter.check(key, max, windowSec);
  try {
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, windowSec);
    return n <= max;
  } catch {
    return memoryLimiter.check(key, max, windowSec); // Redis 抖动时用本地计数兜底
  }
}

/**
 * 分布式锁：基于 Redis `SET key value NX EX`（获取不到则跳过，不阻塞）。
 * 无 Redis（单机/未配置）时直接返回 true（放行）——单进程本身不会重复触发。
 * 用于多 replica 部署下保证「定时任务」等只被一个实例执行一次。
 * 调用方需在使用后（finally）调用 releaseLock 释放。
 */
export async function tryLock(key: string, ttlSec = 3600): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  try {
    const ok = await r.set(key, String(Date.now()), 'EX', ttlSec, 'NX');
    return ok === 'OK';
  } catch {
    return true; // Redis 抖动时放行，最坏是可能重复执行，不阻断业务
  }
}

/** 释放分布式锁 */
export async function releaseLock(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    /* 忽略 */
  }
}

/**
 * 续期（租约心跳，V8.3 · R4）。
 *
 * 为什么需要：原来的锁 TTL 是写死的 3600s，且只在 `finally` 里释放。
 * 一旦执行体挂在上游（原来 `generateText` 没有超时，真的会永久挂起），
 * `finally` 永远不执行，这把锁就一直占到自然过期——后续一小时内该任务全部
 * `skipped: locked`，而且因为通知在调用之后，用户连「失败了」都收不到。
 *
 * 修法两层，缺一不可：
 *  1) TTL 缩短成租约（默认 600s），挂起时最多 10 分钟自然过期；
 *  2) 正常执行中每 TTL/3 续期一次，长任务不会被自己过期掉。
 *
 * 不做「value 比对后再续期/删除」：那需要每个持有者一个随机 owner token，
 * 会把本函数的签名传染到所有调用点。当前场景下重复执行的代价是「多跑一次任务」，
 * 而误删锁的代价是「两个实例同时跑」——两者都已被上游幂等与额度检查兜住，
 * 不值得为此扩大改动面。
 */
export async function extendLock(key: string, ttlSec = 600): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  try {
    const n = await r.expire(key, ttlSec);
    return Number(n) === 1;
  } catch {
    return false; // 续期失败不影响本次执行：最多让锁自然过期
  }
}
