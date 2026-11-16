import { z } from 'zod';

/**
 * Critic（校验 Agent）输出解析。
 *
 * 为什么单独成文件：原来的实现先 JSON.parse，失败后用 `/pass|通过/` 这类正则去猜自然语言，
 * 于是模型输出「这个方案不能通过，因为缺少数据」时会被判成 pass（文本里含「通过」），
 * 校验形同虚设。Critic 是「决定要不要返工」的开关，必须 fail-closed。
 *
 * 规则（严格）：
 *  1) 允许整段被 ```json 围栏包住（模型最常见的多余包装），剥掉后必须是**纯 JSON**；
 *  2) 不允许从散文里用正则抠 `{...}`——那依然是在解析自然语言；
 *  3) 字段必须是 verdict ∈ {pass, fail}，reason 可选；不合法即判定失败并给出可回灌模型的错误说明；
 *  4) 解析失败由调用方决定是否「带着错误原因让模型重出一次」，仍失败则按 fail 处理。
 */

export const VerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  reason: z.string().max(2000).optional().default(''),
  /** 可选置信度，便于统计与阈值调优 */
  score: z.number().min(0).max(1).optional(),
  /** 可选问题清单，返工时可直接拼进重试提示 */
  issues: z.array(z.string().max(500)).max(20).optional(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export type VerdictParse = { ok: boolean; value?: Verdict; error?: string; raw: string };

/** 剥掉整段包裹的 markdown 代码围栏（```json ... ``` / ``` ... ```） */
export function stripCodeFence(text: string): string {
  const t = String(text || '').trim();
  const m = t.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : t;
}

/**
 * 严格解析 Critic 输出。
 * 注意：故意**不**做「提取第一个 {...}」——散文里夹 JSON 视为不合格，交给重试机制修。
 */
export function parseVerdictStrict(text: string): VerdictParse {
  const raw = String(text || '');
  const body = stripCodeFence(raw);
  if (!body) return { ok: false, error: '输出为空', raw };
  if (!body.startsWith('{') || !body.endsWith('}')) {
    return { ok: false, error: '输出不是纯 JSON 对象（可能夹带了说明文字）', raw };
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e: any) {
    return { ok: false, error: `JSON 解析失败：${String(e?.message || e).slice(0, 120)}`, raw };
  }
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.join('.') || '(根)';
    return { ok: false, error: `字段不合法：${where} — ${issue?.message || '格式错误'}`, raw };
  }
  return { ok: true, value: parsed.data, raw };
}

/**
 * 给「重出一次」用的修正确认提示：把上一次输出与具体错误回灌，要求只输出 JSON。
 * 比泛泛地说「请输出 JSON」有效得多——模型知道错在哪个字段。
 */
export function verdictRepairPrompt(prev: string, error: string): string {
  return [
    '你上一条输出不符合要求，无法被程序解析。',
    `错误：${error}`,
    '上一条输出：',
    String(prev || '').slice(0, 1200),
    '',
    '请重新输出，且只输出一个 JSON 对象，不要有任何解释、前后缀或代码围栏以外的内容：',
    '{"verdict":"pass"|"fail","reason":"简要理由"}',
  ].join('\n');
}
