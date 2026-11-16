/**
 * 熔断器（面向「连接器 / 下游 HTTP」这类外部依赖）。
 *
 * 为什么需要：V6.3（O14）已给连接器调用加了超时，解决的是「单次调用不会无限挂死」。
 * 但下游持续故障（5xx / 连接被拒 / DNS 失败）时，每次调用仍要白等一个完整超时周期，
 * 并把这堆错误逐个抛给用户。熔断的作用是：连续失败到阈值后直接快速失败，
 * 冷却期过后放行试探，下游恢复即自动闭合 —— 既不掩盖故障，也不让故障放大。
 *
 * ── V8.22：从「进程内」升级为「集群共享」（这是本轮唯一的语义变更）──
 *
 * 旧实现把计数挂在 `globalThis` 的 Map 上，注释里也承认「半开期允许多个并发试探」。
 * 单副本没问题；多副本时它是**放量器而不是保护器**：同一个死上游，A 副本已熔断、
 * B 副本刚启动一无所知，照样把请求打出去，副本数 N 就放大 N 倍。而它保护的
 * 恰恰是外部依赖——最可能挂、也最不该被放大的地方。
 *
 * 对照很刺眼：同一个 `lib/redis.ts` 里，限流器早就是集群正确的
 * （Redis `INCR` 优先、抖动时回落内存计数）。相邻两套容错策略一个集群级、
 * 一个进程级，纯粹是历史顺序造成的，不是设计选择。
 *
 * 现在的分层（与限流器同一套降级姿势）：
 *   1. Redis 为权威源：`HSET failures / openedAt` + TTL 略大于冷却期；
 *   2. 进程内 Map 作镜像：Redis 抖动/未配置时兜底，也用于 `/metrics` 的本地视图；
 *   3. 读取时**合并两者取失败数更大者**：Redis 被清空（flush）时不至于让刚熔断的
 *      副本立刻恢复放量——宁可多拦几秒，不可一边熔断一边打。
 *
 * 为什么 API 变成 async：共享状态必须读 Redis，而同步函数没法 await。
 * 一次外部 HTTP 调用前多一次 Redis 往返（本地 <1ms、同机房 1~2ms），
 * 相对于它要保护的那次调用的超时窗口可以忽略。
 *
 * 刻意保留的行为：
 * - 只有「抛异常」或「5xx」才算失败：4xx 说明下游活着（只是我们请求不对），不该触发熔断；
 * - 半开期仍允许多个并发试探（不做单飞锁）：最坏是多打几次请求，实现简单且不会误伤。
 */

import { getRedis } from './redis';
import { incCounter, setGauge } from './metrics';

export type BreakerState = { failures: number; openedAt: number };

const MEMORY_KEY = '__wb_breaker_store_v1';
const REDIS_PREFIX = 'breaker:';
/** 连续失败多少次后打开熔断 */
export const BREAKER_THRESHOLD = 5;
/** 打开后冷却多久再放行试探（毫秒） */
export const BREAKER_COOLDOWN_MS = 30_000;
/**
 * Redis 侧状态存活时间：比冷却期长一倍。
 * 太短会在「刚熔断就过期」时退回放量；太长会让一个早就恢复的下游被无谓拦截几分钟。
 */
const REDIS_TTL_SEC = Math.max(60, Math.ceil((BREAKER_COOLDOWN_MS / 1000) * 2));

function memory(): Map<string, BreakerState> {
  const g = globalThis as unknown as Record<string, Map<string, BreakerState> | undefined>;
  if (!g[MEMORY_KEY]) g[MEMORY_KEY] = new Map<string, BreakerState>();
  return g[MEMORY_KEY]!;
}

/** 熔断中抛出的错误：message 已是对用户友好的中文说明，调用方直接当普通错误展示即可 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/** 读共享状态；任何异常都返回 null（Redis 抖动不该让业务跟着挂） */
async function readShared(key: string): Promise<BreakerState | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const [f, t] = await r.hmget(REDIS_PREFIX + key, 'failures', 'openedAt');
    const failures = Number(f) || 0;
    if (failures <= 0) return null;
    return { failures, openedAt: Number(t) || 0 };
  } catch {
    return null;
  }
}

/**
 * 合并本地镜像与共享状态：失败数取更大值，时间取更晚的那个。
 * 不取「Redis 优先」是因为 Redis 可能被重启/清理，而本地刚记下的失败仍是事实。
 */
function mergeState(local: BreakerState | undefined, shared: BreakerState | null): BreakerState | null {
  if (!local) return shared;
  if (!shared) return local;
  return {
    failures: Math.max(local.failures, shared.failures),
    openedAt: Math.max(local.openedAt, shared.openedAt),
  };
}

async function currentState(key: string): Promise<BreakerState | null> {
  return mergeState(memory().get(key), await readShared(key));
}

/**
 * 熔断是否处于打开状态（**仅本进程视图**）。
 *
 * 同步保留的原因：测试与小工具想「不 await 地看一眼本地状态」。
 * 判定是否放行请用 `guardCircuit`（它会读共享状态）；用这个函数做放行判断，
 * 在多副本下就退回了旧行为。
 */
export function isCircuitOpen(key: string): boolean {
  const st = memory().get(key);
  if (!st || st.failures < BREAKER_THRESHOLD) return false;
  return Date.now() - st.openedAt < BREAKER_COOLDOWN_MS;
}

/**
 * 调用前先过闸：熔断打开且仍在冷却期时抛 `CircuitOpenError`，不发起真实请求。
 * 冷却期满后自动放行（半开试探）。
 */
export async function guardCircuit(key: string, label?: string): Promise<void> {
  const st = await currentState(key);
  if (!st || st.failures < BREAKER_THRESHOLD) return;
  const elapsed = Date.now() - st.openedAt;
  if (elapsed >= BREAKER_COOLDOWN_MS) return; // 半开：放行一次试探

  const waitSec = Math.ceil((BREAKER_COOLDOWN_MS - elapsed) / 1000);
  throw new CircuitOpenError(
    `连接器「${label || key}」近期连续失败（${st.failures} 次），已临时熔断，约 ${waitSec} 秒后自动重试。` +
      '请检查下游服务是否可用，或稍后再试。',
  );
}

/** 记录一次失败：累加连续失败数并刷新熔断计时起点（本地 + 共享） */
export async function markCircuitFailure(key: string): Promise<void> {
  const now = Date.now();
  const mem = memory();
  const prev = mem.get(key) || { failures: 0, openedAt: 0 };
  const next: BreakerState = { failures: prev.failures + 1, openedAt: now };
  mem.set(key, next);
  setGauge('hexcore_circuit_failures', '熔断器连续失败数（本进程视图）', next.failures, { breaker: key });

  let counted = false;
  const r = getRedis();
  if (r) {
    try {
      const k = REDIS_PREFIX + key;
      const res = await r
        .multi()
        .hincrby(k, 'failures', 1)
        .hset(k, 'openedAt', String(now))
        .expire(k, REDIS_TTL_SEC)
        .exec();
      // multi 的第一个命令是 HINCRBY，返回 [err, value]
      const n = Number((res?.[0]?.[1] as number) ?? 0);
      // 用共享计数判断「谁先跨过阈值」：多副本下只该计一次打开事件
      if (n === BREAKER_THRESHOLD) {
        incCounter('hexcore_circuit_opened_total', '熔断打开次数（集群口径）', { breaker: key });
        counted = true;
      }
    } catch {
      /* Redis 抖动：本地计数已生效，不阻断业务 */
    }
  }
  if (!counted && next.failures === BREAKER_THRESHOLD) {
    incCounter('hexcore_circuit_opened_total', '熔断打开次数（本地口径，无共享状态时）', { breaker: key });
  }
}

/** 记录一次成功：立即清零，恢复正常调用（本地 + 共享） */
export async function markCircuitSuccess(key: string): Promise<void> {
  memory().delete(key);
  setGauge('hexcore_circuit_failures', '熔断器连续失败数（本进程视图）', 0, { breaker: key });
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(REDIS_PREFIX + key);
  } catch {
    /* 忽略：本地已清零，最坏是其他副本再拦一会儿 */
  }
}

/** 手动重置（连接器配置变更 / 手动测试通过后调用，避免继续吃熔断） */
export async function resetCircuit(key: string): Promise<void> {
  await markCircuitSuccess(key);
}

/**
 * 当前所有熔断状态快照（**仅本进程**，用于观测/排障，不进 UI）。
 * 不扫 Redis：`SCAN` 在大实例上会拖慢主线程，而抓取指标本就按 Pod 逐个进行。
 */
export function circuitSnapshot(): { key: string; failures: number; open: boolean }[] {
  return Array.from(memory().entries()).map(([key, st]) => ({
    key,
    failures: st.failures,
    open: isCircuitOpen(key),
  }));
}
