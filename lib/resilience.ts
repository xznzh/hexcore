/**
 * 轻量进程内熔断器（面向「连接器 / 下游 HTTP」这类外部依赖）。
 *
 * 为什么需要：V6.3（O14）已给连接器调用加了超时，解决的是「单次调用不会无限挂死」。
 * 但下游持续故障（5xx / 连接被拒 / DNS 失败）时，每次调用仍要白等一个完整超时周期，
 * 并把这堆错误逐个抛给用户。熔断的作用是：连续失败到阈值后直接快速失败，
 * 冷却期过后放行试探，下游恢复即自动闭合 —— 既不掩盖故障，也不让故障放大。
 *
 * 实现取舍（刻意的「最小正确」）：
 * - 计数挂在 `globalThis` 上：Next dev HMR 重载模块不会丢状态，也不会叠加多份计数；
 * - 只有「抛异常」或「5xx」才算失败：4xx 说明下游活着（只是我们请求不对），不该触发熔断；
 * - 半开期允许多个并发试探（不做单飞锁）：实现简单且不会误伤，最坏是多打几次请求。
 */

export type BreakerState = { failures: number; openedAt: number };

const STORE_KEY = '__wb_breaker_store_v1';
/** 连续失败多少次后打开熔断 */
export const BREAKER_THRESHOLD = 5;
/** 打开后冷却多久再放行试探（毫秒） */
export const BREAKER_COOLDOWN_MS = 30_000;

function store(): Map<string, BreakerState> {
  const g = globalThis as unknown as Record<string, Map<string, BreakerState> | undefined>;
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map<string, BreakerState>();
  return g[STORE_KEY]!;
}

/** 熔断中抛出的错误：message 已是对用户友好的中文说明，调用方直接当普通错误展示即可 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/** 熔断是否处于打开状态（供健康检查 / 调试观测使用） */
export function isCircuitOpen(key: string): boolean {
  const st = store().get(key);
  if (!st || st.failures < BREAKER_THRESHOLD) return false;
  return Date.now() - st.openedAt < BREAKER_COOLDOWN_MS;
}

/**
 * 调用前先过闸：熔断打开且仍在冷却期时直接抛 `CircuitOpenError`，不发起真实请求。
 * 冷却期满后自动放行（半开试探）。
 */
export function guardCircuit(key: string, label?: string): void {
  const st = store().get(key);
  if (!st || st.failures < BREAKER_THRESHOLD) return;
  const elapsed = Date.now() - st.openedAt;
  if (elapsed >= BREAKER_COOLDOWN_MS) return; // 半开：放行一次试探
  const waitSec = Math.ceil((BREAKER_COOLDOWN_MS - elapsed) / 1000);
  throw new CircuitOpenError(
    `连接器「${label || key}」近期连续失败（${st.failures} 次），已临时熔断，约 ${waitSec} 秒后自动重试。` +
      '请检查下游服务是否可用，或稍后再试。',
  );
}

/** 记录一次失败：累加连续失败数并刷新熔断计时起点 */
export function markCircuitFailure(key: string): void {
  const st = store().get(key) || { failures: 0, openedAt: 0 };
  st.failures += 1;
  st.openedAt = Date.now();
  store().set(key, st);
}

/** 记录一次成功：立即清零，恢复正常调用 */
export function markCircuitSuccess(key: string): void {
  if (store().has(key)) store().delete(key);
}

/** 手动重置（连接器配置变更 / 手动测试通过后调用，避免继续吃熔断） */
export function resetCircuit(key: string): void {
  store().delete(key);
}

/** 当前所有熔断状态快照（用于观测/排障，不进 UI） */
export function circuitSnapshot(): { key: string; failures: number; open: boolean }[] {
  return Array.from(store().entries()).map(([key, st]) => ({
    key,
    failures: st.failures,
    open: isCircuitOpen(key),
  }));
}
