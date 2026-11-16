/**
 * 出站投递（V8.9）：把「平台要把一句话送到平台外」这件事，集中做对一次。
 *
 * ── 为什么需要这一层 ──
 *
 * 平台此前有两处往外部发东西，各写各的：
 *  - `lib/scheduler.ts` 的定时任务 webhook；
 *  - `lib/notify.ts` 的站内通知（写库，不发 HTTP，不在此列）。
 *
 * 前者是**裸 `fetch`**，四个问题叠在一起：
 *  1) **没有超时**。Node 的 `fetch` 默认不设上限，一个挂住的接收端会把定时任务
 *     一直吊到进程重启；而定时任务的锁有 10 分钟 TTL，锁释放后下一轮又来一次。
 *  2) **没过 SSRF 校验**。`webhook_url` 由用户自己填，`http://169.254.169.254/...`
 *     就是一次云主机元数据读取。平台别处早已统一走 `safeFetch`，只有这里漏了。
 *  3) **没有重试**。接收端一次 502 就永久丢失，而「定时任务到底推没推成功」
 *     没有任何记录。
 *  4) **失败静默**。`catch {}` 后什么都不留，事后无从判断是没发、还是发失败。
 *
 * ── HTTP 200 不等于投递成功 ──
 *
 * 这是给企微/钉钉/飞书做机器人时最常踩的坑：它们的网关会返回 `200 OK`，
 * 而真正的投递结果在 body 里（`{"errcode":93000,"errmsg":"invalid webhook url"}`）。
 * 只看 `res.ok` 会把「密钥过期」记成「发送成功」，于是告警系统在被最需要的时候
 * 安静地什么都不做。所以本模块**必须读 body**，按渠道分别判定。
 *
 * ── 重试的边界 ──
 *
 * 只重试「可能自己好」的失败：网络层异常、5xx、429。4xx 不重试——
 * URL 写错、密钥失效这类问题重试三次只是把同一份错误抄三遍，还会触发接收端风控。
 * 这个区分不是为了省事，而是「重试」在语义上只对暂时性故障成立。
 *
 * ── 熔断 ──
 *
 * 复用 `lib/resilience.ts` 的进程级熔断：同一个接收端连续失败 5 次后打开 30s，
 * 期间直接返回 `circuit_open` 而不发请求。没有它，一个已经下线的 webhook
 * 会让每次告警都等满超时。代价是「恢复后可能延迟 30s 才重新尝试」，
 * 对告警场景可以接受。
 */
import { safeFetch } from './ssrf';
import { guardCircuit, markCircuitFailure, markCircuitSuccess, CircuitOpenError } from './resilience';
import { redactSensitive } from './redact';

/** 支持的接收端格式。未知值一律按 `raw` 处理并在结果里标出来。 */
export type WebhookKind = 'raw' | 'wecom' | 'dingtalk' | 'feishu' | 'slack';

export const WEBHOOK_KINDS: readonly WebhookKind[] = ['raw', 'wecom', 'dingtalk', 'feishu', 'slack'];

export function normalizeWebhookKind(raw: unknown): WebhookKind {
  const v = String(raw ?? '').trim().toLowerCase();
  return (WEBHOOK_KINDS as readonly string[]).includes(v) ? (v as WebhookKind) : 'raw';
}

export type OutboundMessage = {
  /** 机器可读的事件名，如 `quality_alert`。接收端可据此分流 */
  event: string;
  title: string;
  body: string;
  /** 附加结构化字段（会原样进入 raw 格式的 payload） */
  meta?: Record<string, unknown>;
};

export type DeliverResult = {
  ok: boolean;
  /** HTTP 状态码；网络层失败时为空 */
  status?: number;
  /** 实际发出的请求次数（含首次） */
  attempts: number;
  /** 失败原因；成功时为空 */
  error?: string;
  /** 被跳过而不是被尝试（没有 URL、熔断打开、URL 不合法） */
  skipped?: 'no_url' | 'circuit_open' | 'bad_url';
};

/**
 * 各渠道的正文长度上限。
 *
 * 企微机器人 text 消息上限 2048 **字节**（不是字符），中文按 UTF-8 算 3 字节，
 * 实际只能放 ~680 个汉字。这个值必须在这里收敛，否则超长时企微直接返回
 * `errcode 40058`，而这正是「最需要看告警」的时候。
 */
const TEXT_LIMIT: Record<WebhookKind, number> = {
  raw: 8000,
  wecom: 600,
  dingtalk: 4000,
  feishu: 4000,
  slack: 3800,
};

function clamp(s: string, limit: number): string {
  const t = String(s ?? '');
  return t.length <= limit ? t : `${t.slice(0, Math.max(0, limit - 12))}\n…（已截断）`;
}

/**
 * 按渠道组装请求体。纯函数，便于把「五个渠道的字段差异」单测掉。
 *
 * 企微与钉钉的 text 消息结构一样，但企微对长度更敏感，所以分开处理。
 */
export function buildWebhookPayload(kind: WebhookKind, msg: OutboundMessage): unknown {
  const title = String(msg.title ?? '');
  const body = clamp(String(msg.body ?? ''), TEXT_LIMIT[kind]);
  const text = title ? `【${title}】\n${body}` : body;

  switch (kind) {
    case 'wecom':
      return { msgtype: 'text', text: { content: clamp(text, TEXT_LIMIT.wecom) } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: clamp(text, TEXT_LIMIT.dingtalk) } };
    case 'feishu':
      return { msg_type: 'text', content: { text: clamp(text, TEXT_LIMIT.feishu) } };
    case 'slack':
      return { text: clamp(text, TEXT_LIMIT.slack) };
    case 'raw':
    default:
      // raw 是给「自己写接收端」的：字段稳定、带 event 便于分流。
      // 不塞企业微信那套结构，否则自建接收端要反过来猜渠道。
      return {
        event: String(msg.event ?? ''),
        title,
        body,
        meta: msg.meta ?? {},
        ts: Date.now(),
      };
  }
}

/**
 * 判定「HTTP 200 但业务失败」。
 *
 * 返回 `null` 表示成功；返回字符串表示接收端明确拒绝了，字符串是给人看的原因。
 * 只检查已知字段，不认识的 body 一律当成功——把「网关多返回了一个字段」
 * 判成失败会造成大量假告警，比漏判更难排查。
 */
export function inspectWebhookBody(kind: WebhookKind, raw: string): string | null {
  if (kind === 'raw' || kind === 'slack') return null; // 无统一业务码，只看 HTTP 状态
  const t = String(raw ?? '').trim();
  if (!t) return null;
  let j: any;
  try {
    j = JSON.parse(t);
  } catch {
    // 非 JSON 响应（某些网关返回纯文本 "ok"）：不据此判失败
    return null;
  }
  if (!j || typeof j !== 'object') return null;

  // 企微 / 钉钉：errcode（钉钉新版偶有 code）
  const codeRaw = j.errcode ?? j.code ?? j.StatusCode;
  if (codeRaw === undefined || codeRaw === null) return null;
  const code = Number(codeRaw);
  if (!Number.isFinite(code) || code === 0) return null;
  const msg = String(j.errmsg ?? j.msg ?? j.message ?? '').trim();
  return `接收端返回错误码 ${code}${msg ? `：${msg}` : ''}`;
}

/** 只对「可能自己好」的失败重试：网络层异常 / 5xx / 429 */
function isRetryable(status: number | undefined, err?: string): boolean {
  if (status === undefined) return true; // 没拿到状态码 = 网络层失败
  if (status === 429) return true;
  if (status >= 500) return true;
  // 网关层超时/限流也常以 408 出现
  if (status === 408) return true;
  return false;
}

/** 日志里只出现 origin：URL 的 query 常带 access_token，整条打出来等于泄露密钥 */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(非法 URL)';
  }
}

function envInt(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}

/** 默认重试间隔（毫秒）。测试可覆盖为 0 以跳过等待。 */
const DEFAULT_DELAYS = [200, 600, 1500];

export type DeliverOptions = {
  /** 单次请求超时（毫秒），默认 OUTBOUND_TIMEOUT_MS=8000 */
  timeoutMs?: number;
  /** 最多尝试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 重试间隔，测试注入 0 */
  retryDelaysMs?: number[];
};

/**
 * 底层投递：POST 一个 JSON 出去，负责超时 / 重试 / 熔断 / 结果判定。
 *
 * 与 `deliverWebhook` 分开的原因：定时任务的 webhook 有自己的 payload 结构
 * （`{schedule, status, aborted, result}`），已经被外部接收端依赖，
 * 不能为了统一而改掉。拆成「组包」和「传输」两层后，两者共用同一套加固，
 * 各自的契约都不用动。
 *
 * `inspect` 用于「HTTP 200 但业务失败」的渠道（企微/钉钉/飞书），
 * 返回 null 表示成功、返回字符串表示接收端明确拒绝。
 */
export async function postJson(
  url: string | null | undefined,
  payload: unknown,
  opts: DeliverOptions & { inspect?: (body: string) => string | null } = {},
): Promise<DeliverResult> {
  const target = String(url ?? '').trim();
  if (!target) return { ok: false, attempts: 0, skipped: 'no_url' };

  const timeoutMs = opts.timeoutMs ?? envInt('OUTBOUND_TIMEOUT_MS', 8000, 500, 60000);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? envInt('OUTBOUND_MAX_ATTEMPTS', 3, 1, 6));
  const delays = opts.retryDelaysMs ?? DEFAULT_DELAYS;

  // 熔断 key 用 origin 而不是完整 URL：同一个坏掉的服务，换条路径也一样坏。
  // 用完整 URL 会让熔断形同虚设（每个 key 各失败一次）。
  const circuitKey = `webhook:${safeOrigin(target)}`;
  try {
    guardCircuit(circuitKey, 'webhook');
  } catch (e) {
    if (e instanceof CircuitOpenError) {
      return { ok: false, attempts: 0, skipped: 'circuit_open', error: '接收端连续失败，熔断中（30 秒后重试）' };
    }
    throw e;
  }

  let lastError = '';
  let lastStatus: number | undefined;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts += 1;
    try {
      // safeFetch 内部逐跳校验重定向；这里只负责超时与结果判定。
      // SSRF 逃生口与平台其它出站路径共用 SSRF_ALLOW_PRIVATE，不再单独开一个开关——
      // 多一个开关就多一处「配了没生效」的解释成本。
      const res = await safeFetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = res.status;

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // 逐次计数，而不是「整轮投递算一次」：每次重试都是一次真实的等待
        // （最坏 3×8s 超时），按轮计数会让一个死掉的端点在告警场景下
        // 要 5 轮 ≈ 50 分钟才熔断，期间每轮都白等。
        markCircuitFailure(circuitKey);
        if (!isRetryable(res.status)) break; // 4xx：重试只是把同一份错误抄三遍
      } else {
        if (opts.inspect) {
          const text = await res.text().catch(() => '');
          const bizError = opts.inspect(text);
          if (bizError) {
            // HTTP 200 + 业务错误码：不可重试（密钥/URL 失效，重试无意义），
            // 但同样在浪费请求，计入熔断
            lastError = bizError;
            markCircuitFailure(circuitKey);
            break;
          }
        }
        markCircuitSuccess(circuitKey);
        return { ok: true, status: res.status, attempts };
      }
    } catch (e: any) {
      lastStatus = undefined;
      const isBadUrl = /URL 被安全策略拒绝|URL 格式不合法|不支持的协议/.test(String(e?.message || ''));
      lastError = String(e?.message || e);
      if (isBadUrl) {
        // 配置错误不重试、也不计入熔断失败（否则改好配置要等 30 秒）
        return { ok: false, attempts, skipped: 'bad_url', error: redactSensitive(lastError).text.slice(0, 300) };
      }
      markCircuitFailure(circuitKey);
    }

    if (i < maxAttempts - 1 && isRetryable(lastStatus, lastError)) {
      const wait = delays[Math.min(i, delays.length - 1)] ?? 0;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break;
  }

  // 错误信息可能含 token（URL 拼接在错误文案里），统一脱敏后再往外给
  return {
    ok: false,
    status: lastStatus,
    attempts,
    error: redactSensitive(lastError || '投递失败').text.slice(0, 300),
  };
}

/**
 * 按渠道组装 payload 后投递。**永不抛异常**——调用方都是旁路（定时任务、告警），
 * 投递失败不该把主流程带崩；失败信息通过返回值与日志呈现。
 */
export async function deliverWebhook(
  url: string | null | undefined,
  msg: OutboundMessage,
  opts: DeliverOptions & { kind?: WebhookKind } = {},
): Promise<DeliverResult> {
  const kind = opts.kind ?? 'raw';
  return postJson(url, buildWebhookPayload(kind, msg), {
    ...opts,
    // 只对「有业务码约定」的渠道读 body。raw/slack 没有统一约定，
    // 读进来也判不出东西，反而会因为某些接收端返回巨大响应体而白占内存。
    inspect: kind === 'raw' || kind === 'slack' ? undefined : (body) => inspectWebhookBody(kind, body),
  });
}

/**
 * 读取环境变量配置的投递目标。多个 URL 用逗号分隔。
 *
 * 为什么用环境变量而不是界面配置：告警接收端是**运维配置**，不是业务数据。
 * 放进界面就要额外做权限、审计、脱敏展示（URL 里有密钥），
 * 而这类配置的变更频率极低——两者不匹配时，选实现成本低且不易泄密的那条。
 */
export function readOutboundTargets(name: string): string[] {
  return String(process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 批量投递：每个目标独立判定，任一失败不影响其余。 */
export async function deliverToAll(
  urls: readonly string[],
  msg: OutboundMessage,
  opts: DeliverOptions = {},
): Promise<DeliverResult[]> {
  const out: DeliverResult[] = [];
  for (const u of urls) out.push(await deliverWebhook(u, msg, opts));
  return out;
}
