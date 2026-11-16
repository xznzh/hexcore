import { redactSensitive } from '../redact';

/**
 * 把模型调用失败的原始错误翻成人话。
 *
 * 为什么要有这一层：上游 SDK / 各家厂商的报错长这样——
 *   `Failed after 3 attempts. Last error: Cannot connect to API: ...`
 *   `401 Incorrect API key provided: sk-abc***`
 * 直接拼进消息气泡，用户看到的是英文栈味儿文本，既不知道发生了什么，也不知道下一步做什么；
 * 更糟的是它会被当成「AI 的回答」落库，后面还跟着 RAG 的参考来源，看起来像答非所问。
 *
 * 这里的职责只有两个：归类 + 给下一步动作。原始错误一律留在服务端日志里（console.error
 * / logLlm），不丢信息；对外只输出脱敏、可执行的中文。
 */

export type ModelErrorKind =
  | 'connect'
  | 'auth'
  | 'rate_limit'
  | 'model_missing'
  | 'timeout'
  | 'context_overflow'
  | 'empty'
  | 'unknown';

export type ModelErrorInfo = { kind: ModelErrorKind; message: string };

/** 归类判定用的规则表，顺序敏感：先匹配「连不上」，再鉴权、限流、模型名、超时、上下文。 */
const RULES: Array<{ kind: ModelErrorKind; re: RegExp; text: string }> = [
  {
    kind: 'connect',
    // SDK 的 "Failed after N attempts. Last error: Cannot connect to API" / 各类 ECONN* 都归这里
    re: /Failed after \d+ attempt|Cannot connect to API|ECONNREFUSED|ECONNRESET|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|fetch failed|NetworkError|socket hang up|other side closed/i,
    text:
      '连不上模型服务：请求没有到达任何端点。请确认 Base URL 可以从本机访问（本机 Ollama 需要先启动服务），' +
      '或到「管理后台 → 模型配置」改为一个已配置 Key 的模型；不做配置也可以直接用演示模型。',
  },
  {
    kind: 'auth',
    re: /\b401\b|\b403\b|unauthorized|invalid api.?key|incorrect api.?key|authentication|permission denied|invalid_?token/i,
    text: '模型鉴权失败：API Key 无效、已过期，或该 Key 没有这个模型的权限。请到「管理后台 → 模型配置」重新填写。',
  },
  {
    kind: 'rate_limit',
    re: /\b429\b|rate.?limit|too many requests|quota|insufficient_?balance|余额不足|欠费/i,
    text: '上游限流或账户额度用尽。请稍后重试，或检查该服务商的余额与限流策略。',
  },
  {
    kind: 'model_missing',
    re: /\b404\b|model_?not_?found|does not exist|no such model|invalid model|unknown model|not found/i,
    text: '模型名不存在或未开通。请核对「模型配置」里的模型名与服务商是否一致。',
  },
  {
    kind: 'context_overflow',
    re: /context_length|maximum context|too many tokens|exceeds? the (maximum )?(context|token)/i,
    text: '本轮内容超出模型的上下文上限。请新建会话，或减少附件 / 引用文件后重试。',
  },
  {
    kind: 'timeout',
    re: /ETIMEDOUT|timed? ?out|timeout|AbortError|aborted/i,
    text: '模型响应超时，已中止本次生成。网络不稳或上游排队时常见，可以直接重发一次。',
  },
];

/** 原文兜底：脱敏 + 去掉换行 + 截断，避免把整段栈或密钥写进气泡。 */
function clean(raw: string): string {
  const oneLine = String(raw || '').replace(/\s+/g, ' ').trim();
  let text = oneLine;
  try {
    text = redactSensitive(oneLine).text;
  } catch {
    /* 脱敏失败不能反过来阻断报错展示 */
  }
  return text.length > 140 ? text.slice(0, 140) + '…' : text;
}

/** 主入口：给定原始错误文本，返回分类 + 面向用户的中文说明。 */
export function explainModelError(raw: unknown): ModelErrorInfo {
  const text = typeof raw === 'string' ? raw : String((raw as { message?: unknown })?.message ?? raw ?? '');
  for (const r of RULES) {
    if (r.re.test(text)) return { kind: r.kind, message: r.text };
  }
  const brief = clean(text);
  return { kind: 'unknown', message: brief ? `模型调用失败：${brief}` : '模型调用失败，且未返回具体原因。' };
}

/** 只要一句话时的快捷方式（气泡里用）。 */
export function userFacingModelError(raw: unknown): string {
  return explainModelError(raw).message;
}
