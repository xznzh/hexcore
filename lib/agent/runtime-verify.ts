import { checkOutput } from '../guardrails';

/**
 * 运行时 V 层（V8 · R4-a）：确定性后校验。
 *
 * 定位：这是「Agent 说做完了」之外的**独立一票**——在回答落库前，用纯规则核对产物，
 * 不依赖模型自评、零额外 LLM 成本。与离线 evals（golden/adversarial）互补：
 * evals 是回归测试，这里跑在请求路径上，负责发现「这一次」的明显劣化。
 *
 * 只做确定性判断（可枚举、可断言），不做语义裁量——语义判断留给可选的独立 LLM-judge（R4-b）。
 * 本模块全纯函数，除 guardrails（同样纯函数）外无外部依赖，可直接单测。
 */

export type VerifySeverity = 'block' | 'warn';

export type VerifyIssue = {
  /** 规则标识，用于日志聚合 */
  rule: string;
  severity: VerifySeverity;
  detail: string;
};

export type VerifyTraceItem = { type: string; name?: string; result?: string };

export type VerifyInput = {
  /** 最终要交付给用户的回答正文 */
  answer: string;
  /** 本轮注入的知识库来源（用于识别伪造来源） */
  sources?: string[];
  /** 本轮工具轨迹（tool_call / tool_result），用于核对「声称使用能力」是否有据 */
  trace?: VerifyTraceItem[];
};

export type VerifyResult = {
  /** 无 block 级问题即为通过（warn 不阻断） */
  ok: boolean;
  issues: VerifyIssue[];
  /** 0..1：block 每条 -0.4，warn 每条 -0.1，下限 0 */
  score: number;
};

/** 引擎模板变量残留（{{input}} / {{prev}}），正常交付文本里绝不该出现 */
const TEMPLATE_VAR = /\{\{\s*(input|prev)\s*\}\}/;

/** 参考来源区块标记（chat/route.ts 追加来源时的固定写法） */
const SOURCE_MARK = '📚 **参考来源**';

/** 可直接复制执行的破坏性命令 / SQL（与系统提示「拒绝要彻底」一致） */
const DESTRUCTIVE =
  /\b(DROP\s+TABLE|TRUNCATE\s+(TABLE\s+)?\w+|rm\s+-rf\s+\/|DELETE\s+FROM\s+\w+\s*(WHERE\s+1\s*=\s*1)?\s*;|cat\s+\/etc\/passwd|:\(\)\s*\{\s*:\|:&\s*\};:)\b/i;

/** 模型明确的空答话术 */
const EMPTY_NOTE = /（模型未返回内容|模型未返回有效内容/;

/**
 * 对最终回答做确定性体检。
 * 规则清单：
 *  1) empty_answer          —— 回答为空（block）
 *  2) model_empty_note      —— 命中「模型未返回内容」话术（block）
 *  3) template_placeholder  —— 残留 {{input}}/{{prev}} 模板变量（warn）
 *  4) fabricated_source     —— 出现了来源区块但本轮没有任何来源（block）
 *  5) ungrounded_capability —— 声称「已使用能力：X」但轨迹里没有对应工具调用（warn）
 *  6) dangerous_copyable    —— 含可直接复制执行的破坏性命令/SQL（block）
 *  7) output_*              —— 复用 guardrails.checkOutput（复读/密钥泄露/复述系统提示）
 */
export function verifyAnswer(input: VerifyInput): VerifyResult {
  const answer = String(input.answer || '');
  const trimmed = answer.trim();
  const sources = Array.isArray(input.sources) ? input.sources.filter(Boolean) : [];
  const trace = Array.isArray(input.trace) ? input.trace : [];
  const issues: VerifyIssue[] = [];

  if (!trimmed) {
    issues.push({ rule: 'empty_answer', severity: 'block', detail: '最终回答为空' });
  } else if (EMPTY_NOTE.test(trimmed)) {
    issues.push({ rule: 'model_empty_note', severity: 'block', detail: '模型未返回有效内容' });
  }

  if (TEMPLATE_VAR.test(trimmed)) {
    issues.push({ rule: 'template_placeholder', severity: 'warn', detail: '回答残留未替换的模板变量（{{input}}/{{prev}}）' });
  }

  if (trimmed.includes(SOURCE_MARK) && sources.length === 0) {
    issues.push({ rule: 'fabricated_source', severity: 'block', detail: '回答列出了参考来源，但本轮没有任何检索来源' });
  }

  const capClaim = /已使用能力[:：]\s*([^\n]+)/.exec(trimmed);
  if (capClaim) {
    const used = trace.some(
      (t) => t.type === 'tool_call' && /invoke_capability|call_connector/i.test(String(t.name || '')),
    );
    if (!used) {
      issues.push({
        rule: 'ungrounded_capability',
        severity: 'warn',
        detail: `回答声称使用能力「${capClaim[1].slice(0, 40)}」，但轨迹中无对应工具调用`,
      });
    }
  }

  if (DESTRUCTIVE.test(trimmed)) {
    issues.push({ rule: 'dangerous_copyable', severity: 'block', detail: '回答包含可直接复制执行的破坏性命令/SQL' });
  }

  for (const h of checkOutput(trimmed)) {
    issues.push({ rule: `output_${h.rule}`, severity: h.severity, detail: h.detail });
  }

  const blockCount = issues.filter((i) => i.severity === 'block').length;
  const warnCount = issues.length - blockCount;
  const score = Math.max(0, Math.min(1, 1 - blockCount * 0.4 - warnCount * 0.1));

  return { ok: blockCount === 0, issues, score };
}

/** 把校验结果压成一行日志摘要（供 logAction 的 detail 使用） */
export function summarizeVerify(result: VerifyResult): string {
  if (!result.issues.length) return 'pass';
  return result.issues
    .map((i) => `${i.severity}:${i.rule}(${i.detail.slice(0, 120)})`)
    .join(' | ')
    .slice(0, 1500);
}
