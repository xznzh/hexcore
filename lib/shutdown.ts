import { stopScheduler } from './scheduler';
import { closeQueue } from './queue';
import { closeRedis } from './redis';
import { closeDb } from './db';

/**
 * 进程退出时的资源回收。
 *
 * 背景：全仓库原先没有任何 `process.on('SIGTERM')`。容器滚动发布 / `kill` 时，
 * 进行中的 SSE 流被硬切、BullMQ 的 job 变成 stalled、PG 连接要等 TCP 超时才释放
 * （max_connections 被打满会导致新副本的第一个请求就 500）。
 *
 * 能力边界（诚实说明，不做过度承诺）：
 *   Next.js 的 `next start` 不对外暴露 HTTP server 句柄，所以**拿不到「在途请求数」**，
 *   无法实现「等所有请求结束后再退」的真正 drain。这里用固定 2s 的宽限窗口近似：
 *   先停调度（不再产生新任务）→ 等 2s 让短请求收尾 → 再关队列与连接。
 *   长流式请求（>2s）仍会被切断，但已生成的半截回答在 chat 路由的 cancel 路径里会落库。
 */

const GRACE_MS = 2_000;
const HARD_TIMEOUT_MS = 10_000;

let registered = false;
let closing = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (t.unref) t.unref();
  });
}

/**
 * 注册信号处理。挂在 instrumentation 的 register() 里，保证每个 server 进程只注册一次。
 * 用 `process.on` 而非 `once`：连续两次 SIGTERM（docker stop 的第二次）也要能被吞掉，
 * 否则第二次会走默认行为直接杀进程，把清理打断一半。
 */
export function registerShutdownHooks(): void {
  if (registered) return;
  registered = true;

  const onSignal = (signal: string) => {
    void shutdown(signal);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

/**
 * 执行关闭流程（幂等；重复调用只跑一次）。
 * 导出是为了让测试和脚本可以主动触发，不依赖真发信号。
 */
export async function shutdown(
  signal: string,
  opts?: { exit?: boolean; graceMs?: number },
): Promise<void> {
  if (closing) return;
  closing = true;
  const started = Date.now();

  const work = (async () => {
    // 1) 先停调度：不再产生新的定时任务与会话
    stopScheduler();
    // 2) 留出宽限窗口，让手头的短请求收尾（测试可传 0 跳过）
    await sleep(opts?.graceMs ?? GRACE_MS);
    // 3) 队列 Worker 会等当前 job 跑完（内部有 5s 上限）
    await closeQueue();
    // 4) 连接池最后关，且 Redis 早于 PG（限流/缓存先失去意义）
    await closeRedis();
    await closeDb();
  })().catch((e: any) => {
    console.error('[shutdown] 资源回收异常:', e?.message || e);
  });

  // 硬超时：宁可丢掉清理，也不能让容器卡在 Terminating 直到被 SIGKILL
  await Promise.race([work, sleep(HARD_TIMEOUT_MS)]);

  console.log(`[shutdown] ${signal} 处理完成，用时 ${Date.now() - started}ms`);

  // 注册了 listener 后 Node 的默认退出行为失效，必须显式退出
  if (opts?.exit !== false) process.exit(0);
}
