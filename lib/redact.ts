/**
 * 入库存前脱敏。
 *
 * 背景：知识库会把文件正文切片后向量化，检索命中时原样回填到对话上下文和检索结果里。
 * 一旦文档里带着 `Authorization: Bearer xxx`、数据库密码、身份证号、手机号，
 * 任何有该库读权限的成员都能把它们捞出来——入库即等于扩散。
 *
 * 设计取舍：
 * - 在**入库时**打码，而不是展示时打码：向量库里不留原文，后续所有读取路径（检索、对话、
 *   导出、二次索引）自动安全，不用每处都记得过滤。
 * - 只掩码「像凭证/个人身份信息」的片段，正文语义基本保留，检索质量不受影响。
 * - 可重复执行（幂等）：`Bearer ***` 再跑一次仍然是 `Bearer ***`。
 */

type Rule = { name: string; re: RegExp; to: string };

const RULES: Rule[] = [
  // JWT：三段 base64url，header 一定以 eyJ 开头
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, to: '***JWT***' },
  // Authorization: Bearer xxx / Basic xxx
  { name: 'Authorization 头', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, to: '$1 ***' },
  // 带前缀的 API Key（OpenAI / GitHub / Slack 等常见形态）
  { name: 'API Key', re: /\b(sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, to: '$1-***' },
  // key=value / key: value 形式的凭据
  {
    name: '凭据字段',
    re: /\b(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key)\b(\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[A-Za-z0-9._\-+/=]{4,})/gi,
    to: '$1$2***',
  },
  // 18 位身份证：保留前 6（地区）后 4（含校验位）
  { name: '身份证号', re: /\b(\d{6})\d{8}(\d{3}[\dXx])\b/g, to: '$1********$2' },
  // 大陆手机号：保留前 3 后 4
  { name: '手机号', re: /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, to: '$1****$2' },
];

export type RedactResult = {
  text: string;
  /** 命中并被打码的片段数 */
  count: number;
  /** 命中的规则名（去重），用于给用户提示「文档里含哪些敏感类型」 */
  kinds: string[];
};

/** 对文本做敏感信息掩码；无命中时原样返回（count=0）。 */
export function redactSensitive(input: string): RedactResult {
  if (!input) return { text: input || '', count: 0, kinds: [] };
  let text = input;
  let count = 0;
  const kinds: string[] = [];

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let hit = 0;
    text = text.replace(rule.re, (...args) => {
      hit++;
      return typeof rule.to === 'string'
        ? rule.to.replace(/\$(\d)/g, (_m, i) => String(args[Number(i)] ?? ''))
        : rule.to;
    });
    if (hit > 0) {
      count += hit;
      kinds.push(rule.name);
    }
  }

  return { text, count, kinds };
}

/** 给前端提示用的中文摘要（无命中返回空串） */
export function redactSummary(r: RedactResult): string {
  if (!r.count) return '';
  return `检测到 ${r.count} 处敏感信息（${r.kinds.join('、')}），入库前已自动掩码`;
}
