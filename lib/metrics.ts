/**
 * 指标注册表 + Prometheus 文本导出。
 *
 * 为什么需要：在此之前能观测的只有三样——`/api/health`（通/不通）、`operation_logs`
 * （事后翻日志）、以及偶尔一行慢请求日志。**没有任何时间序列**，后果很具体：
 * K8s HPA 只能按 CPU 扩容，而本系统的瓶颈是「模型首字延迟」与「token 吞吐」，
 * 不是 CPU——CPU 打满之前用户已经在骂了。
 *
 * 设计取舍（刻意保持「能算出来」而不是「什么都收」）：
 * - **进程内**：多副本各自计数，由 Prometheus 抓取时按实例聚合（counter 天然可累加）。
 *   不落库：那套账 `operation_logs` 已经在记，指标再写一次盘只会两边都不准。
 * - **标签基数封顶**：每条指标最多 `MAX_SERIES` 个标签组合，超出收敛到 `overflow="true"`。
 *   路由里带 id 的路径在 `withApi` 侧已归一化成 `:id`，这里是第二道保险。
 * - **零依赖**：不引 `prom-client`。它很成熟，但这里只需要「计数器 + 直方图 + 文本格式」，
 *   为此引入一个库，换来的是一份额外的注册表生命周期和升级负担。
 * - **不打时间戳**：文本格式允许可选时间戳，但 Prometheus 抓取时会自己盖时间，
 *   写上反而在多副本时钟漂移时制造假尖刺。
 *
 * 不用担心的失败模式：指标是旁路，任何写指标的地方都不该抛异常影响主流程。
 * 因此所有入口都对非法输入静默（宁可少一条数，不可让一次对话 500）。
 */

type LabelInput = Record<string, string | number | boolean | undefined | null>;

/** 单条指标最多保留多少个标签组合；超出部分收敛成一条，避免抓取端口爆掉 */
const MAX_SERIES = 200;

/** 毫秒直方图默认分桶：覆盖「快缓存命中」到「整轮对话超时」 */
export const DEFAULT_MS_BUCKETS = [10, 50, 100, 200, 500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

type Entry = {
  /** 归一化后的标签（未转义，渲染时统一转义），用于 key 比较 */
  labels: Record<string, string>;
  key: string;
  value: number;
};

type HistEntry = Entry & {
  buckets: number[];
  /** 与 buckets 等长；第 i 项是「落在 (buckets[i-1], buckets[i]] 的数量」 */
  counts: number[];
  count: number;
  sum: number;
};

type ScalarMetric = { name: string; help: string; type: 'counter' | 'gauge'; entries: Map<string, Entry> };
type HistMetric = { name: string; help: string; type: 'histogram'; buckets: number[]; entries: Map<string, HistEntry> };
type Metric = ScalarMetric | HistMetric;

const STORE_KEY = '__wb_metrics_store_v1';

function store(): Map<string, Metric> {
  const g = globalThis as unknown as Record<string, Map<string, Metric> | undefined>;
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map<string, Metric>();
  return g[STORE_KEY]!;
}

function escapeLabel(v: string): string {
  // Prometheus 文本格式：反斜杠、双引号、换行必须转义
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function normalize(labels?: LabelInput): Record<string, string> {
  if (!labels) return {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(labels)) {
    const v = labels[k];
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

function keyOf(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',');
}

/**
 * 基数额满后不再新建序列，统一记到 overflow 桶里。
 *
 * 关键细节：overflow 桶必须**丢掉原标签**，只留 `overflow="true"`。
 * 如果保留原标签（`{...labels, overflow:'true'}`），每个新标签组合仍然会生成
 * 一个新序列——封顶等于没做，只是多贴了个标签。
 */
function bounded(labels: Record<string, string>, size: number, key: string): { labels: Record<string, string>; key: string } {
  if (size < MAX_SERIES) return { labels, key };
  const merged = { overflow: 'true' };
  return { labels: merged, key: keyOf(merged) };
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  // 保留 6 位小数即可：指标是趋势不是账本，多余精度只会让文本更长
  return String(Math.round(v * 1e6) / 1e6);
}

/** 计数器累加。by 默认 1；负数会被忽略（计数器不该减小，改小请用 gauge） */
export function incCounter(name: string, help: string, labels?: LabelInput, by = 1): void {
  if (!(by > 0)) return;
  const m = ensureScalar(name, help, 'counter');
  const raw = normalize(labels);
  const b = bounded(raw, m.entries.size, keyOf(raw));
  const hit = m.entries.get(b.key);
  if (hit) hit.value += by;
  else m.entries.set(b.key, { labels: b.labels, key: b.key, value: by });
}

/** 仪表：直接覆盖当前值（抓取时通常是「现在多少」，不是「一共多少」） */
export function setGauge(name: string, help: string, value: number, labels?: LabelInput): void {
  const m = ensureScalar(name, help, 'gauge');
  const raw = normalize(labels);
  const b = bounded(raw, m.entries.size, keyOf(raw));
  const hit = m.entries.get(b.key);
  if (hit) hit.value = value;
  else m.entries.set(b.key, { labels: b.labels, key: b.key, value });
}

/** 毫秒观测：同时累加耗时直方图与次数（分桶固定，便于算 p50/p95） */
export function observeMs(name: string, help: string, ms: number, labels?: LabelInput, buckets = DEFAULT_MS_BUCKETS): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const m = ensureHist(name, help, buckets);
  const raw = normalize(labels);
  const b = bounded(raw, m.entries.size, keyOf(raw));
  let hit = m.entries.get(b.key);
  if (!hit) {
    hit = { labels: b.labels, key: b.key, value: 0, buckets: m.buckets, counts: m.buckets.map(() => 0), count: 0, sum: 0 };
    m.entries.set(b.key, hit);
  }
  hit.count += 1;
  hit.sum += ms;
  hit.value = hit.count;
  // 找到第一个 >= ms 的桶；比最大桶还大则落到 +Inf（只体现在 _count 上）
  const idx = hit.buckets.findIndex((x) => ms <= x);
  if (idx >= 0) hit.counts[idx] += 1;
}

function ensureScalar(name: string, help: string, type: 'counter' | 'gauge'): ScalarMetric {
  const hit = store().get(name);
  // 同名不同型：调用处写错了。保留先注册的那条，返回一个**游离**对象让本次写入丢失——
  // 静默改写类型会让已抓取的序列突然变义，比少一条数更糟。
  if (hit && hit.type !== type) return { name, help, type, entries: new Map() };
  if (hit) return hit as ScalarMetric;
  const created: ScalarMetric = { name, help, type, entries: new Map() };
  store().set(name, created);
  return created;
}

function ensureHist(name: string, help: string, buckets: number[]): HistMetric {
  const hit = store().get(name);
  if (hit && hit.type !== 'histogram') return { name, help, type: 'histogram', buckets, entries: new Map() };
  if (hit) return hit as HistMetric;
  const created: HistMetric = {
    name,
    help,
    type: 'histogram',
    buckets: [...buckets].sort((a, b) => a - b),
    entries: new Map(),
  };
  store().set(name, created);
  return created;
}

/** 清空某条指标（抓取时重新收集的 gauge 用，避免已消失的序列变成僵尸） */
export function clearMetric(name: string): void {
  store().delete(name);
}

/** 仅测试用：清空整个注册表 */
export function resetMetrics(): void {
  store().clear();
}

function renderLabels(labels: Record<string, string>, extra?: Record<string, string>): string {
  const all = { ...labels, ...(extra || {}) };
  const keys = Object.keys(all).sort();
  if (!keys.length) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(all[k])}"`).join(',')}}`;
}

/**
 * 渲染成 Prometheus 文本格式（version 0.0.4）。
 * 指标按名字排序，便于 diff 两次抓取结果——随机顺序会让「有没有变化」这件事看不出来。
 */
export function renderMetrics(): string {
  const s = store();
  const lines: string[] = [];
  for (const name of [...s.keys()].sort()) {
    const m = s.get(name)!;
    lines.push(`# HELP ${name} ${m.help.replace(/\n/g, ' ')}`);
    lines.push(`# TYPE ${name} ${m.type}`);

    const entries = [...m.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
    if (m.type === 'histogram') {
      for (const e of entries as HistEntry[]) {
        let cum = 0;
        e.buckets.forEach((bound, i) => {
          cum += e.counts[i];
          lines.push(`${name}_bucket${renderLabels(e.labels, { le: fmt(bound) })} ${cum}`);
        });
        lines.push(`${name}_bucket${renderLabels(e.labels, { le: '+Inf' })} ${e.count}`);
        lines.push(`${name}_sum${renderLabels(e.labels)} ${fmt(e.sum)}`);
        lines.push(`${name}_count${renderLabels(e.labels)} ${e.count}`);
      }
    } else {
      for (const e of entries) lines.push(`${name}${renderLabels(e.labels)} ${fmt(e.value)}`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
