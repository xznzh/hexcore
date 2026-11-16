/**
 * 通道健康度（V8.7）：把 `operation_logs` 里的校验/拦截记录聚合成「一眼能看出哪里在漏」的视图。
 *
 * 为什么要有这一层：v8.6 把运行时 V 层接到了技能与定时任务通道，但结果只写进
 * `operation_logs` 的一行文本。要回答「哪个技能这周一直在报 empty_answer」，
 * 得自己去翻日志表——**观测数据没有出口，等于没有观测**。这一轮补的就是出口。
 *
 * ── 为什么解析字符串，而不是加结构化字段 ──
 *
 * `operation_logs.detail` 是自由文本，聚合看起来应该靠 SQL `GROUP BY`。但 detail 里
 * 承载的是「规则 + 原因」，规则数量会增长，用列去表达就得每加一条规则改一次 schema。
 * 更关键的是：这些日志的主要读者是人（排障时直接看 detail），改成 JSON 或拆列会
 * 牺牲可读性换一个「统计更方便」的收益，不值得。
 *
 * 所以这里承认 detail 是**人和机器共用的可读格式**，用解析器读它，
 * 并把这个格式用测试锁住（`tests/channel-health.test.ts`）：
 * 格式一旦变动，测试变红，而不是统计悄悄归零。
 *
 * ── `unparsed` 为什么要单独计数 ──
 *
 * 这是本项目的老问题换了个位置：如果解析器因为格式变化全部失败，统计结果会是
 * 「0 个问题」——和「这段时间真的没问题」**完全无法区分**。所以聚合结果里必须
 * 显式带上「有多少行没解析成功」，UI 上非零时提示「统计可能不完整」。
 * 宁可显示一个难看的警告，也不要显示一个干净但错误的 0。
 */

/** 一行日志里与健康度相关的字段（对应 operation_logs 的部分列） */
export type ChannelHealthLogRow = {
  action: string;
  target?: string | null;
  status?: string | null;
  detail?: string | null;
  createdAt: number;
};

export type ParsedIssue = { severity: 'block' | 'warn'; rule: string };

export type ParsedChannelRecord = {
  /** chat / skill / schedule / api；认不出来时为 'unknown' */
  channel: string;
  /** 技能名 / 定时任务名；对话通道没有 */
  label: string;
  /** 出口护栏处于观察模式（CHANNEL_GUARD=off） */
  observe: boolean;
  issues: ParsedIssue[];
};

/** logAction 会自动加 `[trace:xxx] ` 前缀（见 lib/util.ts），解析前必须剥掉 */
const TRACE_PREFIX = /^\[trace:[^\]]*\]\s*/;
/** v8.6 起非对话通道的固定前缀 */
const CHANNEL_PREFIX = 'channel · ';
/** 出口护栏观察模式的前缀（answer-guard.auditBlock） */
const OBSERVE_PREFIX = 'observe · ';
/** issue 摘要的单项：`block:empty_answer(最终回答为空)` */
const ISSUE_ITEM = /(?:^|\s\|\s)(block|warn):([A-Za-z0-9_]+)\(/g;

/** 通道名白名单：用于把「没有前缀的 eval_runtime」正确归到对话通道 */
const KNOWN_CHANNELS = new Set(['chat', 'skill', 'schedule', 'api']);

function splitChannelLabel(seg: string): { channel: string; label: string } {
  const i = seg.indexOf('/');
  if (i < 0) return { channel: seg.trim(), label: '' };
  // 只按**第一个** `/` 切：技能名/任务名本身可能带斜杠（如「日报 / 周报」）
  return { channel: seg.slice(0, i).trim(), label: seg.slice(i + 1).trim() };
}

/**
 * 提取 issue 列表。
 *
 * 不用 `split(' | ')`：issue 的 detail 部分可能自身含 ` | `（例如被拦下的原文里就有），
 * 按分隔符切会多出无主片段，统计里就会冒出一个 `unknown` 规则。
 * 直接全文扫描 `severity:rule(` 三元组更稳。
 */
function parseIssues(s: string): ParsedIssue[] {
  const out: ParsedIssue[] = [];
  ISSUE_ITEM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ISSUE_ITEM.exec(s))) {
    out.push({ severity: m[1] as 'block' | 'warn', rule: m[2] });
  }
  return out;
}

/**
 * 解析一行日志。认不出来返回 null（由调用方计入 `unparsed`，不要静默丢弃）。
 *
 * 三种实际格式：
 *   eval_runtime（非对话通道，v8.6+）：`channel · skill/周报 · error:empty_answer(...)`
 *   eval_runtime（对话通道）：`error:empty_answer(...)`（无通道前缀）
 *   guardrail_output_block：`observe · skill/周报 · 命中…`，规则在 target 列
 */
export function parseChannelRecord(row: ChannelHealthLogRow): ParsedChannelRecord | null {
  let d = String(row.detail ?? '').replace(TRACE_PREFIX, '').trim();
  if (!d) return null;

  let observe = false;
  if (d.startsWith(OBSERVE_PREFIX)) {
    observe = true;
    d = d.slice(OBSERVE_PREFIX.length).trim();
  }

  if (row.action === 'guardrail_output_block') {
    const idx = d.indexOf(' · ');
    const head = idx < 0 ? d : d.slice(0, idx);
    const { channel, label } = splitChannelLabel(head);
    // 拦截记录的规则名在 target 列（auditBlock 的第三个参数），deterministic
    const rule = String(row.target || '').trim() || 'unknown';
    return { channel: KNOWN_CHANNELS.has(channel) ? channel : 'unknown', label, observe, issues: [{ severity: 'block', rule }] };
  }

  if (row.action !== 'eval_runtime') return null;

  if (d.startsWith(CHANNEL_PREFIX)) {
    const body = d.slice(CHANNEL_PREFIX.length);
    const idx = body.indexOf(' · ');
    // 有前缀但没有分隔符 = 格式已经变了；返回 null 让它进 unparsed，而不是猜
    if (idx < 0) return null;
    const { channel, label } = splitChannelLabel(body.slice(0, idx));
    const issues = parseIssues(body.slice(idx + 3));
    // eval_runtime 只在「有问题」时才写（recordChannelVerify / chat 同口径），
    // 所以一条记录解析出 0 个 issue 说明格式变了，不能当成「没问题」记进 parsed
    if (!issues.length) return null;
    return { channel: KNOWN_CHANNELS.has(channel) ? channel : 'unknown', label, observe, issues };
  }

  // 没有 `channel · ` 前缀：对话通道的写法（v8.6 起非对话通道一定带前缀）。
  // 首段若不是已知通道名，说明这行是意料之外的格式，不猜。
  const issues = parseIssues(d);
  const first = splitChannelLabel(d.split(' · ')[0] || '').channel;
  if (KNOWN_CHANNELS.has(first)) return null; // 形如 `skill/xxx · ...` 却少了前缀 → 不认
  if (!issues.length) return null;
  return { channel: 'chat', label: '', observe, issues };
}

const DAY_MS = 86400000;
/** 与 lib/capabilities/metrics 一致：固定 +08 时区切天，避免服务器时区差异 */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

function dayKey(ts: number): string {
  const d = new Date(ts + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export type ChannelHealthSummary = {
  /** 成功解析的行数 */
  parsed: number;
  /** 解析失败的行数：非零表示「统计可能不完整」，必须显式暴露 */
  unparsed: number;
  /** 涉及 block 级问题的行数（含被拦截的） */
  failed: number;
  /** 只有 warn 级问题的行数 */
  warned: number;
  channels: { channel: string; failed: number; warned: number; total: number }[];
  rules: { rule: string; severity: 'block' | 'warn'; count: number }[];
  labels: { channel: string; label: string; total: number; failed: number; topRule: string }[];
  byDay: { day: string; failed: number; warned: number }[];
  /** 最近若干条，供人直接看原文场景 */
  recent: { at: number; channel: string; label: string; observe: boolean; issues: string }[];
};

export type AggregateOptions = {
  /** 只保留最近 N 天的数据（按 createdAt 过滤）；不传表示全部 */
  days?: number;
  /** 现在的时间戳（测试可注入） */
  now?: number;
  /** recent 保留多少条，默认 20 */
  recentLimit?: number;
};

/**
 * 聚合。纯函数：不做 I/O、不依赖当前时间（`now` 可注入）。
 *
 * `failed` 的口径：**含 block 级 issue** 的行。同一行里既有 block 又有 warn 时只算 failed，
 * 否则「总问题数」会因为同一行的两条规则被重复计入。
 */
export function aggregateChannelHealth(
  rows: readonly ChannelHealthLogRow[],
  opts: AggregateOptions = {},
): ChannelHealthSummary {
  const now = opts.now ?? Date.now();
  const since = opts.days && opts.days > 0 ? now - opts.days * DAY_MS : -Infinity;
  const recentLimit = opts.recentLimit ?? 20;

  const channelMap = new Map<string, { failed: number; warned: number }>();
  const ruleMap = new Map<string, { severity: 'block' | 'warn'; count: number }>();
  const labelMap = new Map<string, { channel: string; label: string; total: number; failed: number; rules: Map<string, number> }>();
  const dayMap = new Map<string, { failed: number; warned: number }>();

  let parsed = 0;
  let unparsed = 0;
  let failed = 0;
  let warned = 0;
  const recent: ChannelHealthSummary['recent'] = [];

  // 先按时间倒序，保证 recent 是「最近的 N 条」，与输入顺序无关
  const sorted = [...rows].filter((r) => r.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt);

  for (const row of sorted) {
    const p = parseChannelRecord(row);
    if (!p) {
      unparsed += 1;
      continue;
    }
    parsed += 1;

    const isFail = p.issues.some((i) => i.severity === 'block');
    if (isFail) failed += 1;
    else warned += 1;

    const ch = channelMap.get(p.channel) || { failed: 0, warned: 0 };
    if (isFail) ch.failed += 1;
    else ch.warned += 1;
    channelMap.set(p.channel, ch);

    for (const issue of p.issues) {
      const cur = ruleMap.get(issue.rule) || { severity: issue.severity, count: 0 };
      cur.count += 1;
      // block 优先级更高：同一规则在不同通道可能有不同级别，展示取最严重的
      if (issue.severity === 'block') cur.severity = 'block';
      ruleMap.set(issue.rule, cur);
    }

    // 只有带标签的通道才进 label 榜：对话通道没有标签，混进来会是一个空名字的巨无霸
    if (p.label) {
      const key = `${p.channel}/${p.label}`;
      const cur = labelMap.get(key) || { channel: p.channel, label: p.label, total: 0, failed: 0, rules: new Map<string, number>() };
      cur.total += 1;
      if (isFail) cur.failed += 1;
      for (const issue of p.issues) cur.rules.set(issue.rule, (cur.rules.get(issue.rule) || 0) + 1);
      labelMap.set(key, cur);
    }

    const day = dayKey(row.createdAt);
    const d = dayMap.get(day) || { failed: 0, warned: 0 };
    if (isFail) d.failed += 1;
    else d.warned += 1;
    dayMap.set(day, d);

    if (recent.length < recentLimit) {
      recent.push({
        at: row.createdAt,
        channel: p.channel,
        label: p.label,
        observe: p.observe,
        issues: p.issues.map((i) => `${i.severity}:${i.rule}`).join(' | '),
      });
    }
  }

  const labels = [...labelMap.values()]
    .map((v) => {
      // topRule：这个技能/任务最常触发的规则，比「总共 8 次」更能指向问题
      const topRule = [...v.rules.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return { channel: v.channel, label: v.label, total: v.total, failed: v.failed, topRule };
    })
    .sort((a, b) => b.total - a.total);

  return {
    parsed,
    unparsed,
    failed,
    warned,
    channels: [...channelMap.entries()]
      .map(([channel, v]) => ({ channel, failed: v.failed, warned: v.warned, total: v.failed + v.warned }))
      .sort((a, b) => b.total - a.total),
    rules: [...ruleMap.entries()]
      .map(([rule, v]) => ({ rule, severity: v.severity, count: v.count }))
      .sort((a, b) => b.count - a.count),
    labels: labels.slice(0, 20),
    byDay: [...dayMap.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    recent,
  };
}
