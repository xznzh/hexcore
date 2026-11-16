import { db } from './db';
import { operationLogs } from './schema';
import { newId } from './util';
import { traceTag, getTraceId } from './trace';
import { generateText } from 'ai';
import { resolveModelWithFallback } from './llm';
import { incCounter, observeMs } from './metrics';

/** 可选 Langfuse 上报（配置 LANGFUSE_PUBLIC_KEY/SECRET_KEY 后启用），best-effort。 */
export async function langfuseTrace(p: { model: string; label: string; ms: number; ok: boolean; error?: string; tokens?: number }) {
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (!pub || !sec) return;
  const host = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
  try {
    await fetch(`${host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64'),
      },
      body: JSON.stringify({
        batch: [
          {
            type: 'trace-create',
            id: newId('tr'),
            timestamp: new Date().toISOString(),
            body: { name: p.label, metadata: { model: p.model, ms: p.ms, ok: p.ok, error: p.error, tokens: p.tokens } },
          },
        ],
      }),
    });
  } catch {
    /* ignore */
  }
}

/**
 * 轻量 LLM 调用埋点：写入 operation_logs（action='llm_call'）。
 * 用于后续做可观测性（调用次数、延迟、失败率），无需引入额外依赖。
 * 失败不影响主流程。
 */
export async function logLlm(p: {
  model: string;
  label: string;
  ms: number;
  ok: boolean;
  error?: string;
  tokens?: number;
  /** 输入 / 输出分别记账：两者单价不同，只有一个总 token 时金额只能拍脑袋 */
  promptTokens?: number;
  completionTokens?: number;
  /** 调用方用户 id；落库到 operation_logs.userId，用于按用户维度归因成本。不传则写 null（保持兼容） */
  userId?: string;
}): Promise<void> {
  // 指标（V8.22）：与上面的落库**同一时刻、同一份数据**，两条出口各有用途——
  // 库里的行用于逐个调用复盘（谁、花了多少、为什么失败），指标用于看趋势与告警。
  // 只记 `label` 不记模型名：模型名由用户自填，基数不可控，也不该出现在抓取端口上。
  incCounter('hexcore_llm_calls_total', '模型调用次数（按用途 / 成败）', {
    label: p.label,
    ok: p.ok ? 'true' : 'false',
  });
  observeMs('hexcore_llm_duration_ms', '模型调用耗时（毫秒）', p.ms, { label: p.label });
  if (typeof p.tokens === 'number') incCounter('hexcore_llm_tokens_total', '模型 token 用量', { kind: 'total' }, p.tokens);
  if (typeof p.promptTokens === 'number') {
    incCounter('hexcore_llm_tokens_total', '模型 token 用量', { kind: 'prompt' }, p.promptTokens);
  }
  if (typeof p.completionTokens === 'number') {
    incCounter('hexcore_llm_tokens_total', '模型 token 用量', { kind: 'completion' }, p.completionTokens);
  }
  // 埋点写库改为 fire-and-forget：每次对话 / 智能体步骤都经过这里，若 await 会直接叠加在
  // LLM 调用的返回路径上，抬高首字延迟。改为不阻塞——丢失一条 best-effort 观测记录不影响主流程。
  db.insert(operationLogs)
    .values({
      id: newId('log'),
      userId: p.userId ?? null,
      action: 'llm_call',
      // target 保留原格式：它同时是「人类一眼能读懂的摘要」，也是 v8.10 之前所有行的唯一来源。
      // 结构化字段另存真列，读侧不再反解它（见 schema.ts 里 target 的注释）。
      target: `${p.model} | ${p.label} | ${p.ok ? 'OK' : 'FAIL'} | ${p.ms}ms${p.error ? ' | ' + p.error.slice(0, 200) : ''}`,
      model: p.model,
      label: p.label,
      ok: p.ok,
      tokens: typeof p.tokens === 'number' ? p.tokens : null,
      promptTokens: typeof p.promptTokens === 'number' ? p.promptTokens : null,
      completionTokens: typeof p.completionTokens === 'number' ? p.completionTokens : null,
      // traceId 落真列（v8.10）；detail 里仍写一份 `[trace:xxx]` 前缀，
      // 因为按前缀 grep 是看日志最顺手的姿势，两处都写才不必二选一。
      traceId: getTraceId() || null,
      detail: (traceTag() || null) as any,
      createdAt: Date.now(),
    })
    .catch(() => {});
  // 可选上报 Langfuse（未配置则内部直接返回）
  langfuseTrace(p).catch(() => {});
}

/**
 * 简单的 RAG 效果评估（recall@k）。
 * 给定若干 (问题, 期望命中关键词) 用例，对 retrieve() 结果检查是否命中，返回通过率。
 * 用法：/api/admin/eval 或脚本调用。无依赖、可离线运行。
 */
export type EvalCase = { query: string; expect: string };
export async function runRagEval(cases: EvalCase[], k = 4): Promise<{ pass: number; total: number; hits: number[] }> {
  const { retrieve } = await import('./ai/rag');
  const hits: number[] = [];
  let pass = 0;
  for (const c of cases) {
    const r = await retrieve(c.query, k);
    const blob = r.map((x) => x.content).join('\n').toLowerCase();
    const ok = blob.includes(c.expect.toLowerCase());
    if (ok) pass++;
    hits.push(r.length);
  }
  return { pass, total: cases.length, hits };
}

/**
 * LLM-as-judge：用模型对一段「输入/回答」按标准打分（1–5）并给出理由。
 * 仅输出 JSON，稳健解析。用于提示词/技能质量调优。
 */
export async function runJudge(
  input: string,
  output: string,
  criteria = '准确性、有用性、清晰度',
): Promise<{ score: number | null; reason: string; raw: string }> {
  const resolved = await resolveModelWithFallback();
  if (!resolved) throw new Error('无可用模型');
  const { text } = await generateText({
    model: resolved.instance,
    system:
      '你是严格的评审员。请依据给定标准评估回答质量。只输出一个 JSON 对象：{"score": 1-5 的整数, "reason": "简要理由"}，不要输出其他内容。',
    prompt: `评估标准：${criteria}\n\n【输入】\n${input}\n\n【回答】\n${output}`,
  });
  let score: number | null = null;
  let reason = text.slice(0, 300);
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (typeof j.score === 'number') score = j.score;
      if (j.reason) reason = String(j.reason);
    }
  } catch {
    /* ignore */
  }
  return { score, reason, raw: text };
}
