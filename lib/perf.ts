/**
 * 请求内分段耗时记录（V8.3）。
 *
 * 为什么要它：项目里没有延迟分布数据，所以「哪里慢」只能靠读代码推演——
 * 而推演会错。这轮审计里「摘要阻塞首字」是靠读 `await generateText` 的位置得出的，
 * 它到底占 200ms 还是 3s，只有在真实流量上打点才知道。
 *
 * 设计取舍：
 *  - **默认安静**：只在 `PERF_LOG=1` 时全量打印；否则只在这一轮总耗时超过
 *    `PERF_SLOW_MS`（默认 2500ms）时打一行，避免每轮刷日志。
 *  - **单行输出**：一次请求一行，带每段毫秒数与累计值，便于直接 grep/awk 成 p50/p95。
 *  - 不做聚合、不落库：聚合是看板的事，这里只负责「让数据存在」。
 */

type Phase = { name: string; at: number; cost: number };

export type PerfRecorder = {
  /** 打一个检查点：记录「距上一个检查点」的耗时 */
  lap(name: string): void;
  /** 手动附加一段耗时（用于已知区间的耗时，如某次外部调用内部统计） */
  add(name: string, ms: number): void;
  /** 收尾打印；note 会拼在行尾（如 hit/miss） */
  done(note?: string): void;
  /** 当前累计耗时，供调用方判定是否还在预算内 */
  elapsed(): number;
};

function enabledAll(): boolean {
  const v = String(process.env.PERF_LOG ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function slowThreshold(): number {
  const n = Number(process.env.PERF_SLOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 2500;
}

/**
 * @param label 日志前缀，如 `chat` / `skill` / `schedule`
 */
export function startPerf(label: string): PerfRecorder {
  const t0 = Date.now();
  let last = t0;
  const phases: Phase[] = [];
  let closed = false;

  const push = (name: string, cost: number) => {
    // 同一名字可能出现多次（如并行段之后的多个同步段），合并累计更易读
    const hit = phases.find((p) => p.name === name);
    if (hit) hit.cost += cost;
    else phases.push({ name, cost, at: t0 });
  };

  return {
    lap(name: string) {
      const now = Date.now();
      push(name, now - last);
      last = now;
    },
    add(name: string, ms: number) {
      if (Number.isFinite(ms) && ms >= 0) push(name, ms);
    },
    elapsed: () => Date.now() - t0,
    done(note?: string) {
      if (closed) return;
      closed = true;
      const total = Date.now() - t0;
      if (!enabledAll() && total < slowThreshold()) return;
      const detail = phases.map((p) => `${p.name}=${p.cost}ms`).join(' ');
      console.log(`[perf] ${label} total=${total}ms ${detail}${note ? ' ' + note : ''}`);
    },
  };
}
