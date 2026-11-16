/**
 * 质量告警（V8.8）：让通道健康度从「要有人去看」变成「会来找人」。
 *
 * ── 缺口的确切形状 ──
 *
 * v8.7 把校验结果做成了页面，但那是**拉取式**的：没人打开「管理后台 → 评估」，
 * 一个连续三天全量 `empty_answer` 的技能就不会被任何人知道。观测数据的价值
 * 取决于「谁在什么时候会看到它」，只做到「能查到」等于把发现问题的责任
 * 转给了「碰巧想起来去看一眼的人」。
 *
 * ── 为什么不用「失败率」做阈值 ──
 *
 * 做告警最自然的指标是失败率（例如「失败率 > 20% 就告警」）。但**这个数据不存在**：
 * `operation_logs` 只在「有问题」时写行，成功执行不留痕。所以分母是未知的，
 * 任何「率」都是拿绝对数除以一个编出来的分母。
 *
 * 与其造一个看起来专业但算不出来的指标，不如换一个更可靠的信号：
 * **同一个对象在同一个窗口内反复触发同一条规则**。这是模式，不是噪声——
 * 偶发一次多半是用户输入古怪或模型抖动，一小时内同一个技能连续三次
 * `empty_answer`，几乎只能是它坏了。
 *
 * 代价要如实说：本模块**无法区分「不忙」和「坏了」**。所以恢复通知的措辞是
 * 「未再达到告警条件」，不是「已修复」——后者需要一个我们并不拥有的基线。
 *
 * ── 为什么要 cooldown，而不是「有问题就发」 ──
 *
 * 检查每 10 分钟跑一次。没有 cooldown，一个坏掉的技能会在一天内产生 144 条通知，
 * 然后所有人开始无视通知——这比不发更糟：它把「通知」这个通道本身弄坏了。
 * 但 cooldown 反过来带来一个必须解决的问题：**告警静默期和「已修好」在外部看起来一样**。
 * 所以状态（`fired` 里每条的 `at`）必须能被看到，页面与接口都要暴露，
 * 否则「为什么这次没收到告警」永远无法回答。
 *
 * ── V8.9：站内通知还不够（外发通道） ──
 *
 * 站内通知的前提是「有人登录平台」。值班时没人盯着管理后台，而一个连续三天
 * 全量 `empty_answer` 的技能，恰恰是在「没人看」的时段最需要被知道。
 * 所以补一条出站通道：`QUALITY_ALERT_WEBHOOK`（可多个，逗号分隔）。
 *
 * 三个刻意的决定：
 *  1) **合并成一条消息**。站内通知按 key 各发一条是对的（能单条已读），但 IM 群里
 *     一次 5 条机器人消息会把人推走。所以外发只发一条摘要，内含全部条目。
 *  2) **外发失败不阻断状态写入**。状态先不写、等外发成功再写，会把「站内已经
 *     通知过」的事实一起丢掉，下一轮重复通知全体管理员——用一个小概率的漏发
 *     换一个必然的重复轰炸，不划算。所以顺序是「站内 → 外发 → 写状态」。
 *  3) **失败要留下痕迹**。`lastExternal` 进状态、进页面。外发是「最多一次」语义，
 *     失败即丢失，但「本该发而没发」至少能查到原因（见下）。
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../schema';
import { rowsOf } from '../sql';
import { getSetting, setSetting } from '../settings';
import { createNotification } from '../notify';
import { logAction } from '../util';
import { tryLock, releaseLock } from '../redis';
import { parseChannelRecord, type ChannelHealthLogRow } from './channel-health';
import {
  deliverWebhook,
  normalizeWebhookKind,
  readOutboundTargets,
  type DeliverResult,
  type OutboundMessage,
  type WebhookKind,
} from '../outbound';

const MIN_MS = 60_000;
const DAY_MS = 86400000;
/** 明细行数上限：与 /api/admin/quality 同口径 */
const MAX_ROWS = 20000;
/** 状态存在 settings 表里（避免为此加一张表），key 固定 */
const STATE_KEY = 'quality_alert_state';
/** 状态里最多保留多少个 key：标签数会随技能增长，必须设上限 */
const MAX_STATE_KEYS = 500;
/** 已恢复的 key 保留 30 天后清理，避免状态无限膨胀 */
const STATE_TTL_MS = 30 * DAY_MS;
/** 「日志解析失败」这类平台自身问题，一天最多吵一次 */
const UNPARSED_COOLDOWN_MS = DAY_MS;
const LOCK_KEY = 'quality_alert_lock';
/**
 * 外发目标数量上限。
 *
 * 不是为了省流量，而是为了**锁的 TTL**：一次检查持有 Redis 锁，
 * TTL 是 `intervalMin × 2` 分钟。单个目标最坏耗时 `3 次重试 × 8s`，
 * 5 个目标 ≈ 2 分钟，仍在最短 TTL（2 分钟）边缘之内。
 * 不设上限时，运维配了 20 个群就会让本轮检查超过锁 TTL，
 * 下一轮在锁过期后启动、对着同一批日志再发一遍——重复告警恰好是本文档开头
 * 最想避免的东西。
 */
const MAX_OUTBOUND_TARGETS = 5;

export type AlertPolicy = {
  enabled: boolean;
  /** 观察窗口（分钟）：判断「反复触发」的时间范围 */
  windowMin: number;
  /** 同一 key 在窗口内触发多少次才告警 */
  minCount: number;
  /** 同一 key 告警后静默多久 */
  cooldownMin: number;
  /** 距上次告警至少多久才判定「已恢复」，避免刚报完就说好了 */
  recoveryMin: number;
  /** 单次最多发几条问题告警（恢复与解析失败另行合并，不占这个额度） */
  maxAlertsPerRun: number;
  /** 检查间隔（分钟） */
  intervalMin: number;
};

function envInt(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}

function envBool(name: string, def: boolean): boolean {
  const v = String(process.env[name] ?? '').toLowerCase();
  if (!v) return def;
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}

/**
 * 阈值默认值的选择依据（都可用环境变量覆盖）：
 *  - `minCount = 3`：一次是抖动，两次可疑，三次是模式；
 *  - `windowMin = 60`：一小时足够容纳一次定时任务的多次重试，又不至于把昨天的故障算进来；
 *  - `cooldownMin = 360`：一天最多 4 次提醒，够引起注意又不会让人屏蔽通知；
 *  - `recoveryMin = windowMin`：窗口里已经滚不到了才说「未再出现」，这是唯一诚实的口径。
 */
export function readAlertPolicy(): AlertPolicy {
  const windowMin = envInt('QUALITY_ALERT_WINDOW_MIN', 60, 5, 1440);
  return {
    enabled: envBool('QUALITY_ALERT_ENABLED', true),
    windowMin,
    minCount: envInt('QUALITY_ALERT_MIN_COUNT', 3, 1, 1000),
    cooldownMin: envInt('QUALITY_ALERT_COOLDOWN_MIN', 360, 5, 10080),
    recoveryMin: envInt('QUALITY_ALERT_RECOVERY_MIN', windowMin, 5, 10080),
    maxAlertsPerRun: envInt('QUALITY_ALERT_MAX_PER_RUN', 5, 1, 50),
    intervalMin: envInt('QUALITY_ALERT_INTERVAL_MIN', 10, 1, 1440),
  };
}

/** 告警状态。放在 settings 表的一行里，随 `quality_alert_state` 一起读写。 */
export type AlertState = {
  /** key → 最近一次告警的时间与当时的次数；`recoveredAt` 非空表示已发过恢复通知 */
  fired: Record<string, { at: number; count: number; observe: boolean; recoveredAt?: number }>;
  /** 「日志解析失败」上次发出的时间 */
  unparsedAt?: number;
  /** 上次真正跑完检查的时间：页面据此回答「为什么没收到告警」 */
  lastRunAt?: number;
  lastResult?: { issues: number; recoveries: number; suppressed: number; scanned: number; truncated: boolean };
  /**
   * 最近一次外发的结果（V8.9）。
   *
   * 外发是「最多一次」语义：失败不会在下一轮补发（cooldown 已经生效），
   * 所以这个字段是事后唯一能回答「为什么不发/发失败」的地方。
   */
  lastExternal?: {
    at: number;
    /** 目标数 */
    targets: number;
    ok: number;
    failed: number;
    /** 第一个失败原因（已脱敏），便于直接看 */
    error?: string;
    /** 全部被跳过时的原因（熔断 / 未配置） */
    skipped?: string;
  };
};

export type AlertNotification = {
  kind: 'issue' | 'recovery' | 'unparsed';
  /** 涉及的告警 key（恢复通知会有多条） */
  keys: string[];
  title: string;
  body: string;
};

/**
 * 告警 key：`通道/标签#规则`。标签为空时（对话通道）退化为 `通道#规则`。
 *
 * 只用 `#` 连接、不反向解析：标签里可能带 `/`（技能名形如「日报 / 周报」），
 * 想把 key 拆回三元组一定会拆错。需要结构化字段的地方都单独存，不要靠解析 key。
 */
export function alertKey(channel: string, label: string, rule: string): string {
  return `${channel}/${label}#${rule}`;
}

type Group = {
  channel: string;
  label: string;
  rule: string;
  severity: 'block' | 'warn';
  count: number;
  /** 该 key 的所有命中都发生在观察模式下（护栏只记录不拦截） */
  observeOnly: boolean;
};

export type AlertPlan = {
  notifications: AlertNotification[];
  state: AlertState;
  /** 命中告警条件但因 cooldown / 单次上限被压掉的条数——必须能看见，否则等于静默丢弃 */
  suppressed: number;
  /** 窗口内参与解析的行数 */
  scanned: number;
  /** 解析失败的行数 */
  unparsed: number;
};

/**
 * 纯函数：给定日志行、策略、当前时间与上一次状态，产出「该发哪些通知」与「新状态」。
 *
 * 不碰 I/O 的理由：告警逻辑的每个分支都是「时间和次数」的组合，
 * 掺进数据库就只能靠等真实时间来验证。
 */
export function planChannelAlerts(
  rows: readonly ChannelHealthLogRow[],
  policy: AlertPolicy,
  now: number,
  prev: AlertState = { fired: {} },
  truncated = false,
): AlertPlan {
  const since = now - policy.windowMin * MIN_MS;
  const inWindow = rows.filter((r) => {
    const t = Number(r.createdAt);
    return Number.isFinite(t) && t >= since && t <= now;
  });

  const groups = new Map<string, Group>();
  let unparsed = 0;

  for (const row of inWindow) {
    const p = parseChannelRecord(row);
    if (!p) {
      unparsed += 1;
      continue;
    }
    for (const issue of p.issues) {
      const key = alertKey(p.channel, p.label, issue.rule);
      const g = groups.get(key) || {
        channel: p.channel,
        label: p.label,
        rule: issue.rule,
        severity: issue.severity,
        count: 0,
        observeOnly: true,
      };
      g.count += 1;
      // 同一规则在不同通道可能是不同级别，展示取最严重的
      if (issue.severity === 'block') g.severity = 'block';
      if (!p.observe) g.observeOnly = false;
      groups.set(key, g);
    }
  }

  const fired: AlertState['fired'] = { ...(prev.fired || {}) };
  const notifications: AlertNotification[] = [];
  let suppressed = 0;

  // ── 1. 问题告警 ──
  const ready: { key: string; g: Group }[] = [];
  for (const [key, g] of groups) {
    if (g.count < policy.minCount) continue;
    const last = fired[key];
    // 静默期内（含「刚发过恢复通知」的情况）：不重复通知，但要把压掉了几条记下来。
    // 恢复后仍受 cooldown 约束，是为了挡住「恢复 → 立刻复发 → 再报」的抖动。
    if (last && now - last.at < policy.cooldownMin * MIN_MS) {
      suppressed += 1;
      continue;
    }
    ready.push({ key, g });
  }
  // 次数多的优先：单次上限只会截掉「相对不重要」的那些
  ready.sort((a, b) => b.g.count - a.g.count || a.key.localeCompare(b.key));
  const emit = ready.slice(0, policy.maxAlertsPerRun);
  suppressed += Math.max(0, ready.length - emit.length);

  for (const { key, g } of emit) {
    fired[key] = { at: now, count: g.count, observe: g.observeOnly };
    notifications.push(makeIssueNotification(key, g, policy));
  }

  // ── 2. 恢复通知 ──
  //
  // 判定标准是「不再达到告警条件」（`count < minCount` 或窗口里压根没有），
  // 而不是「完全没出现」——后者会让「从 5 次降到 2 次」既不报问题也不报恢复，卡在中间无人知晓。
  const recoveredKeys: string[] = [];
  for (const [key, st] of Object.entries(fired)) {
    if (st.recoveredAt !== undefined) continue;
    const g = groups.get(key);
    if (g && g.count >= policy.minCount) continue;
    if (now - st.at < policy.recoveryMin * MIN_MS) continue;
    st.recoveredAt = now;
    recoveredKeys.push(key);
  }
  if (recoveredKeys.length) {
    // 合并成一条：十个技能同时恢复时，十条通知会盖掉真正重要的问题告警
    notifications.push({
      kind: 'recovery',
      keys: recoveredKeys,
      title: `质量告警已解除 · ${recoveredKeys.length} 项`,
      body:
        `以下问题在最近 ${policy.windowMin} 分钟内未再达到告警条件：\n` +
        recoveredKeys.slice(0, 20).map((k) => `· ${k}`).join('\n') +
        (recoveredKeys.length > 20 ? `\n· 另有 ${recoveredKeys.length - 20} 项` : '') +
        '\n\n注意：这不等于「已修复」——也可能是这段时间没有执行。需要确认请到「管理后台 → 评估 → 通道健康度」看趋势。',
    });
  }

  // ── 3. 平台自身问题：日志解析失败 ──
  //
  // 这类问题会让上面的统计与告警一起失真，优先级高于业务告警，但只需要「知道」而非「处理」，
  // 所以一天一条。它同时也是本模块的自监控：解析器失效时，告警系统不能安静地继续报 0。
  let unparsedAt = prev.unparsedAt;
  if (unparsed > 0) {
    if (unparsedAt && now - unparsedAt < UNPARSED_COOLDOWN_MS) {
      suppressed += 1;
    } else {
      unparsedAt = now;
      notifications.push({
        kind: 'unparsed',
        keys: [],
        title: '质量告警自身异常 · 校验日志无法解析',
        body:
          `最近 ${policy.windowMin} 分钟有 ${unparsed} 行校验日志解析失败，` +
          '健康度统计与告警都会因此偏低（不报不等于没问题）。\n\n' +
          '常见原因：日志写入方改了 detail 格式，而 lib/agent/channel-health.ts 的解析器没跟着改。\n' +
          '排查入口：管理后台 → 评估 → 通道健康度（顶部会显示「统计可能不完整」）。',
      });
    }
  }

  // ── 4. 状态整理：清理过期、限制规模 ──
  const pruned: AlertState['fired'] = {};
  const entries = Object.entries(fired).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_STATE_KEYS);
  for (const [key, st] of entries) {
    if (now - st.at > STATE_TTL_MS) continue;
    pruned[key] = st;
  }

  const nextState: AlertState = {
    fired: pruned,
    unparsedAt,
    lastRunAt: now,
    lastResult: {
      issues: emit.length,
      recoveries: recoveredKeys.length,
      suppressed,
      scanned: inWindow.length,
      truncated,
    },
  };

  return { notifications, state: nextState, suppressed, scanned: inWindow.length, unparsed };
}

function makeIssueNotification(key: string, g: Group, policy: AlertPolicy): AlertNotification {
  const name = g.label ? `${g.channel}/${g.label}` : g.channel;
  const sev = g.severity === 'block' ? '阻断级' : '提示级';
  const observeNote = g.observeOnly
    ? '\n\n注意：出口护栏处于观察模式（CHANNEL_GUARD=off），这些命中只被记录、**没有**拦截。'
    : '';
  return {
    kind: 'issue',
    keys: [key],
    title: `质量告警 · ${name} · ${g.rule}`,
    body:
      `最近 ${policy.windowMin} 分钟内「${name}」有 ${g.count} 次触发 ${g.rule}（${sev}）。\n` +
      `同一问题 ${Math.round(policy.cooldownMin / 60)} 小时内不再重复提醒。\n` +
      '到「管理后台 → 评估 → 通道健康度」看原文与最近记录。' +
      observeNote,
  };
}

// ─────────────────── 外发（V8.9）：纯逻辑在前，I/O 在后 ───────────────────

export type AlertOutboundConfig = { urls: string[]; kind: WebhookKind; truncatedTargets: boolean };

/**
 * 读取外发配置。
 *
 * 用环境变量而不是界面配置，理由与 `lib/outbound.ts` 的 `readOutboundTargets` 相同：
 * 告警接收端是运维配置，URL 里常带密钥；放进界面就要额外做权限、审计、掩码展示，
 * 而它一年也改不了几次。
 */
export function readAlertOutbound(): AlertOutboundConfig {
  const all = readOutboundTargets('QUALITY_ALERT_WEBHOOK');
  return {
    urls: all.slice(0, MAX_OUTBOUND_TARGETS),
    kind: normalizeWebhookKind(process.env.QUALITY_ALERT_WEBHOOK_KIND),
    truncatedTargets: all.length > MAX_OUTBOUND_TARGETS,
  };
}

/**
 * 把本次所有通知合并成**一条**外发消息。纯函数。
 *
 * 合并的理由见文件头：站内可以一条一条看，IM 群里五条机器人消息只会被无视。
 * 反过来说，合并也带来一个必须写明的损失：外发消息里没有「逐条已读」，
 * 所以它必须自带足够定位的信息（通道、标签、规则、次数），让人不登录也能判断严重性。
 *
 * 返回 `null` 表示本次没有要外发的内容——调用方据此跳过，避免发一条空消息。
 */
export function composeAlertDigest(
  notifications: readonly AlertNotification[],
  policy: AlertPolicy,
  extra?: { suppressed?: number; scanned?: number },
): OutboundMessage | null {
  if (!notifications.length) return null;

  const issues = notifications.filter((n) => n.kind === 'issue');
  const recoveries = notifications.filter((n) => n.kind === 'recovery');
  const unparsed = notifications.filter((n) => n.kind === 'unparsed');

  const parts: string[] = [];
  if (issues.length) {
    parts.push(
      `【问题 ${issues.length} 项】\n` +
        issues
          .map((n) => `· ${n.title.replace(/^质量告警 · /, '')}\n  ${n.body.split('\n')[0]}`)
          .join('\n'),
    );
  }
  if (recoveries.length) {
    // 恢复通知本身就是合并过的（里面可能含多个 key），这里只取标题与首段说明
    for (const n of recoveries) parts.push(`【${n.title}】\n${n.body.split('\n\n')[0]}`);
  }
  if (unparsed.length) parts.push('【平台自身】校验日志无法解析，健康度统计可能偏低（不报不等于没问题）');

  const suppressedNote = extra?.suppressed
    ? `\n\n另有 ${extra.suppressed} 条命中被静默期或单次上限压掉，未在此列出。`
    : '';

  return {
    event: 'quality_alert',
    title: `质量告警 ${issues.length} 项${recoveries.length ? ` / 恢复 ${recoveries.length} 项` : ''}`,
    body:
      `观察窗口 ${policy.windowMin} 分钟，扫描 ${extra?.scanned ?? 0} 条校验记录。\n\n` +
      parts.join('\n\n') +
      suppressedNote +
      '\n\n详情：管理后台 → 评估 → 通道健康度',
    meta: {
      issues: issues.length,
      recoveries: recoveries.length,
      unparsed: unparsed.length,
      suppressed: extra?.suppressed ?? 0,
      scanned: extra?.scanned ?? 0,
      windowMin: policy.windowMin,
    },
  };
}

/** 外发结果摘要：写进状态与日志的那一份 */
export type ExternalOutcome = NonNullable<AlertState['lastExternal']>;

/** 投递到全部目标并汇总。永不抛异常。 */
async function dispatchExternal(
  notifications: readonly AlertNotification[],
  policy: AlertPolicy,
  extra: { suppressed?: number; scanned?: number },
  now: number,
): Promise<ExternalOutcome | null> {
  const cfg = readAlertOutbound();
  // 未配置 = 不启用。返回 null 而不是「0 个目标失败」，否则页面会一直挂一条无意义的失败记录。
  if (!cfg.urls.length) return null;

  const msg = composeAlertDigest(notifications, policy, extra);
  if (!msg) return null;

  const results: DeliverResult[] = [];
  for (const url of cfg.urls) {
    results.push(await deliverWebhook(url, msg, { kind: cfg.kind }));
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const firstError = results.find((r) => !r.ok && r.error)?.error;
  const allSkipped = results.length > 0 && results.every((r) => r.skipped);

  return {
    at: now,
    targets: results.length,
    ok,
    failed,
    error: firstError ? String(firstError).slice(0, 300) : undefined,
    skipped: allSkipped ? results.find((r) => r.skipped)?.skipped : undefined,
  };
}

// ───────────────────────── 以下为 I/O 侧 ─────────────────────────

function parseState(raw: string | null): AlertState {
  if (!raw) return { fired: {} };
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return { fired: {} };
    return {
      fired: o.fired && typeof o.fired === 'object' ? o.fired : {},
      unparsedAt: Number(o.unparsedAt) || undefined,
      lastRunAt: Number(o.lastRunAt) || undefined,
      lastResult: o.lastResult,
      // 外发结果同样要跨轮保留：它是「上一轮到底发出去了没有」的唯一记录，
      // 丢了就退化成「每次检查只看本轮」，而本轮没告警时看起来和「一切正常」一样。
      lastExternal: o.lastExternal && typeof o.lastExternal === 'object' ? o.lastExternal : undefined,
    };
  } catch {
    // 状态损坏按「没有历史」处理：继续跑，下一轮会覆盖。
    // 但必须留下痕迹——否则「告警规则莫名其妙重新开始刷」将无从解释。
    console.warn('[quality-alert] 告警状态损坏，已按空状态重置');
    return { fired: {} };
  }
}

export type QualityCheckResult = {
  ok: boolean;
  skipped?: 'disabled' | 'locked';
  scanned: number;
  unparsed: number;
  /** 本次实际发出的通知条数（已合并恢复、解析失败） */
  issued: number;
  suppressed: number;
  /** 收到通知的管理员数量；0 表示「有问题但没人可通知」 */
  notified: number;
  truncated: boolean;
  dryRun?: boolean;
  /** dryRun 时把计划内容一并返回，便于调阈值 */
  planned?: { kind: string; title: string; body: string }[];
  /** 本轮外发结果；null = 未配置外发通道（不是失败） */
  external?: ExternalOutcome | null;
};

/** 取窗口内的校验日志。与 /api/admin/quality 同一查询口径，便于两处数字对得上。 */
async function fetchWindowRows(since: number, until: number): Promise<{ rows: ChannelHealthLogRow[]; truncated: boolean }> {
  const raw = rowsOf(
    await db.execute(sql`
      SELECT action, target, status, detail, created_at
      FROM operation_logs
      WHERE created_at >= ${since}
        AND created_at <= ${until}
        AND action IN ('eval_runtime', 'guardrail_output_block')
      ORDER BY created_at DESC
      LIMIT ${MAX_ROWS}
    `),
  );
  return {
    rows: raw.map((r) => ({
      action: String(r?.action || ''),
      target: r?.target ?? null,
      status: r?.status ?? null,
      detail: r?.detail ?? null,
      createdAt: Number(r?.created_at ?? 0),
    })),
    truncated: raw.length >= MAX_ROWS,
  };
}

/** 收件人：启用状态的管理员。成员看不到别人的技能名，所以不能发广播（userId=null 会发给所有人）。 */
async function alertRecipients(): Promise<string[]> {
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
    return rows.map((r: any) => String(r.id));
  } catch {
    return [];
  }
}

/**
 * 跑一次检查。
 *
 * `dryRun` 只算不发：调阈值时不该先给全平台管理员发一轮通知再后悔。
 */
export async function runQualityCheck(opts: { now?: number; dryRun?: boolean } = {}): Promise<QualityCheckResult> {
  const policy = readAlertPolicy();
  const base: QualityCheckResult = {
    ok: true,
    scanned: 0,
    unparsed: 0,
    issued: 0,
    suppressed: 0,
    notified: 0,
    truncated: false,
  };
  if (!policy.enabled) return { ...base, skipped: 'disabled' };
  if (opts.dryRun) return runCheckInner(policy, opts, base, true);

  // 多副本部署时只让一个实例跑。与调度器同一思路：锁只解决「同时跑两次」，
  // 而「每个副本都各发一遍」需要靠这把锁挡住。
  const got = await tryLock(LOCK_KEY, Math.max(60, policy.intervalMin * 60 * 2));
  if (!got) return { ...base, skipped: 'locked' };
  try {
    return await runCheckInner(policy, opts, base, false);
  } finally {
    await releaseLock(LOCK_KEY);
  }
}

async function runCheckInner(
  policy: AlertPolicy,
  opts: { now?: number; dryRun?: boolean },
  base: QualityCheckResult,
  dryRun: boolean,
): Promise<QualityCheckResult> {
  const now = opts.now ?? Date.now();
  const since = now - policy.windowMin * MIN_MS;

  const { rows, truncated } = await fetchWindowRows(since, now);
  const prev = parseState(await getSetting(STATE_KEY).catch(() => null));
  const plan = planChannelAlerts(rows, policy, now, prev, truncated);

  if (dryRun) {
    return {
      ...base,
      scanned: plan.scanned,
      unparsed: plan.unparsed,
      suppressed: plan.suppressed,
      issued: plan.notifications.length,
      truncated,
      dryRun: true,
      planned: plan.notifications.map((n) => ({ kind: n.kind, title: n.title, body: n.body })),
    };
  }

  const recipients = plan.notifications.length ? await alertRecipients() : [];
  for (const n of plan.notifications) {
    for (const uid of recipients) await createNotification(uid, n.title, n.body);
  }

  /**
   * 外发（V8.9）。
   *
   * 顺序是「站内 → 外发 → 写状态」，不是「外发成功才写状态」：
   * 后者会把「站内已经通知过」这个事实一起丢掉，下一轮对全体管理员重复通知。
   * 用一个小概率的漏发，换掉一个必然的重复轰炸——这与本模块选择 cooldown
   * 而不是「有问题就发」是同一个判断。
   *
   * 代价要如实说：外发失败不会在下一轮补发（cooldown 已写入），
   * 所以 `lastExternal` 是事后唯一能查的地方。
   */
  const external = await dispatchExternal(
    plan.notifications,
    policy,
    { suppressed: plan.suppressed, scanned: plan.scanned },
    now,
  ).catch(() => null);

  // 状态在发送之后写：`createNotification` 内部吞异常，所以这里无法区分成功与失败。
  // 选择「最多发一次」而不是「保证发到」——重复的告警会让所有人开始无视通知，
  // 那比漏一条更严重。代价是发送失败时本轮会静默丢失，为此把计划与结果都写进状态，
  // 使「本该发而没发」至少在页面与日志里留下痕迹。
  const nextState: AlertState = {
    ...plan.state,
    // 本轮没有外发内容时保留上一轮的结果：它仍然回答「上次外发是什么情况」
    lastExternal: external ?? prev.lastExternal,
  };
  await setSetting(STATE_KEY, JSON.stringify(nextState)).catch(() => {
    /* 写不进状态最多导致下轮重复提醒，不阻断 */
  });

  const result: QualityCheckResult = {
    ...base,
    scanned: plan.scanned,
    unparsed: plan.unparsed,
    issued: plan.notifications.length,
    suppressed: plan.suppressed,
    notified: recipients.length,
    truncated,
    external,
  };

  // 只在「有话说」时写日志：每 10 分钟一条正常心跳会把操作日志淹掉，
  // 而真正需要回溯的是「什么时候发过告警、发给了几个人」。
  // 外发失败必须单独留痕：它是最容易被忽略的失败（站内看着一切正常）。
  if (plan.notifications.length || !recipients.length || (external && external.failed > 0)) {
    await logAction(null, 'quality_alert', plan.notifications.map((n) => n.kind).join(',') || 'no_recipient', {
      status: !recipients.length && plan.notifications.length ? 'error' : external && external.failed > 0 ? 'warn' : 'ok',
      detail:
        `issues=${result.issued} suppressed=${result.suppressed} notified=${result.notified} ` +
        `scanned=${result.scanned} unparsed=${result.unparsed}` +
        (external
          ? ` external=${external.ok}/${external.targets}${external.error ? ` externalError=${external.error}` : ''}${external.skipped ? ` externalSkipped=${external.skipped}` : ''}`
          : ''),
    });
  }

  return result;
}

/** 模块级节流：调度器每分钟调一次，但真正检查按 `intervalMin` 走。 */
let lastAttemptAt = 0;

/**
 * 调度器 tick 调用的入口：内部做节流，重复调用是安全的。
 *
 * 为什么挂在调度器的 tick 上而不是另起一个 setInterval：
 *  - `SCHEDULER_ENABLED=false` 的副本本就不该做平台级周期工作，复用它省掉一套开关；
 *  - 多一套定时器就多一处「进程退出没清掉」的隐患（调度器那份已经踩过）。
 */
export async function maybeRunQualityCheck(now = Date.now(), force = false): Promise<QualityCheckResult | null> {
  const policy = readAlertPolicy();
  if (!policy.enabled) return null;
  if (!force && lastAttemptAt && now - lastAttemptAt < policy.intervalMin * MIN_MS) return null;
  // 先占位再 await：否则同一次 tick 内的重入会跑两遍（并发写同一份状态）
  lastAttemptAt = now;
  try {
    const r = await runQualityCheck({ now });
    if (r.notified === 0 && r.issued > 0) {
      console.warn('[quality-alert] 命中告警但没有可通知的管理员，请检查管理员账号状态');
    }
    return r;
  } catch (e: any) {
    // 告警系统自己坏了必须能被看到：这条日志是唯一的痕迹（通知发不出去，因为它坏了）
    console.error('[quality-alert] 检查失败:', e?.message || e);
    return null;
  }
}

/** 仅供测试：重置节流计时器 */
export function __resetThrottle(): void {
  lastAttemptAt = 0;
}
