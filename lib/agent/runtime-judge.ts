import { resolveModelForTask } from '../llm';
import { callModel } from '../llm-gateway';
import { logAction } from '../util';
import { checkRateLimit } from '../redis';
import type { ChannelTraceNode } from './channel-verify';

/**
 * 运行时 V 层（V8 · R4-b）：独立 LLM-judge 抽查。
 *
 * 与 R4-a（`runtime-verify.ts`）的分工：
 *  - R4-a：确定性规则，零成本，**每次都跑**，只抓可枚举的硬伤；
 *  - R4-b：语义判断（回答是否真的回应了问题、工具结果与结论是否一致），有成本，**按需跑**。
 *
 * 三个必须守住的约束（否则这个 judge 形同虚设或反过来添乱）：
 *  1) **独立上下文**：只喂「问题 + 工具轨迹摘要 + 最终回答」，不喂对话历史、不喂模型推理（reasoning）。
 *     带着原推理去评审，模型会自我合理化——这正是 `engine.ts` critic 的短板。
 *  2) **不阻断**：判定结果只写日志，绝不改写用户已看到的回答，也不触发重试。
 *     评审本身也可能出错，用它的结论去改交付物是把风险放大。
 *  3) **默认关闭**：`RUNTIME_JUDGE=on` 才启用。每次抽查都是一次真实计费调用。
 *
 * ── V8.9：覆盖非对话通道，并给成本装一个闸 ──
 *
 * v8.6 把确定性 V 层接到了 skill / schedule 通道，但 judge 一直只挂在对话上。
 * 而那两条通道恰恰更需要它：产出直接进通知与 webhook，用户看到之前没有人复核。
 *
 * 但「顺手把 judge 也接上」会让成本从「每轮对话抽一次」变成「每次技能运行 +
 * 每次定时任务都抽一次」——定时任务可能每小时跑几十次，这是数量级的变化。
 * 所以接通道的同时必须定**成本边界**，三件事一起做：
 *
 *  - **采样**（`RUNTIME_JUDGE_SAMPLE`，默认 20%）：按「日期 + 通道 + 问题 + 回答」的
 *    确定性哈希取模，而不是 `Math.random()`。确定性有两个好处：同一份内容在多个
 *    副本上判定一致（不会出现「A 副本判了、B 副本没判」）；出问题时能复现
 *    「为什么这条没被抽到」。种子带日期，所以同一份内容第二天会重新洗牌，
 *    不会永远卡在未采样区间。
 *  - **日预算**（`RUNTIME_JUDGE_DAILY_MAX`，默认 200）：滚动 24 小时计数，超了直接
 *    跳过并留一行 `judge_skipped`。这是**防失控的闸，不是精确计费**：多副本时
 *    Redis 可用则共享计数，不可用则退化为各算各的，实际上限会略高于配置值。
 *  - **只判高风险轮次**：沿用 `HIGH_RISK_TOOLS`，纯检索、纯问答不判。
 *
 * ── 为什么日志不再用 `eval_runtime` ──
 *
 * 原来 judge 和确定性校验共用 `eval_runtime` 这个 action。但 `lib/agent/channel-health.ts`
 * 的解析器要求 detail 里出现 `block:rule(` / `warn:rule(` 结构，而 judge 的 detail 是
 * `judge(model,tier): score=1 reason=…`——解析必然失败。后果是**只要 judge 打开，
 * 健康度统计就会持续出现「日志无法解析」，进而每天误报一条平台自身告警**。
 * 换成独立的 `eval_judge` 后两件事都干净了：解析器不必猜，judge 的抽样数据也不会
 * 混进「确定性校验次数」的排名里（抽样分母不是全量，放一起比次数是错的）。
 */

/** 触发抽查的工具：有外部副作用或产物生成，答错代价最高 */
const HIGH_RISK_TOOLS = /^(call_connector|invoke_capability|run_skill|generate_ppt|read_file|sandbox)$/;

/** 通道标识：judge 现在要区分「谁的回答」 */
export type JudgeChannel = 'chat' | 'skill' | 'schedule';

/** 轨迹节点的最小交集：两种通道的形状不同，见 `normalizeJudgeTrace` */
export type JudgeTraceItem = {
  type: string;
  /** 对话通道用 name，技能通道用 tool */
  name?: string;
  tool?: string;
  result?: string;
  output?: string;
};

export type JudgeVerdict = {
  /** true/false = 明确判定；null = 模型没给出可解析的判定（不猜） */
  pass: boolean | null;
  score: number | null;
  reason: string;
};

/** 是否启用（默认关） */
export function judgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.RUNTIME_JUDGE ?? '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

function envInt(
  env: Record<string, string | undefined>,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}

export type JudgePolicy = {
  enabled: boolean;
  /** 采样百分比 0~100 */
  samplePercent: number;
  /** 滚动 24 小时的最多判定次数；0 = 不限 */
  dailyMax: number;
};

/**
 * 成本边界默认值的依据：
 *  - 20% 采样：一个每天跑 100 次的定时任务，约 20 次抽查/天，成本可估且能发现问题；
 *  - 200 次/天上限：按 judge 单次约 400 token 估算，峰值在十万 token 量级，
 *    对小团队可接受，同时挡住「某个循环任务把额度烧穿」。
 */
export function readJudgePolicy(env: Record<string, string | undefined> = process.env): JudgePolicy {
  return {
    enabled: judgeEnabled(env),
    samplePercent: envInt(env, 'RUNTIME_JUDGE_SAMPLE', 20, 0, 100),
    dailyMax: envInt(env, 'RUNTIME_JUDGE_DAILY_MAX', 200, 0, 100000),
  };
}

/**
 * 确定性采样。同一个 `seed` 必然得到同一个结论。
 *
 * 不用 `Math.random()`：多副本各判一次会得出不同结论，事后也无法回答
 * 「为什么这条没被抽到」——抽样本身必须可复现，否则调阈值就是盲调。
 */
export function sampleHit(seed: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const s = String(seed ?? '');
  let h = 0x811c9dc5; // FNV-1a 32bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) % 100 < percent;
}

/** 与 channel-health 一致：固定 +08 时区切天，避免服务器时区差异 */
function dayKey(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 轨迹归一：把两种通道的形状翻译成 judge 认识的 `tool_call` + `tool_result`。
 *
 * 这是接非对话通道时最容易漏、且**漏了不报错**的一步：
 *  对话通道：`{type:'tool_call',name}` + `{type:'tool_result',name,result}`
 *  技能通道：`{type:'tool',tool,output}`（一个节点同时含调用与产出）
 *
 * 如果直接把技能轨迹交给 `digestTrace`（只认 `tool_result`），摘要会是空字符串，
 * judge 看到的是「本轮无工具结果」——于是任何具体数字、来源都会被判成「凭空捏造」，
 * 误报率 100%，而日志里看起来像是模型真的有问题。V8.4 的空 context 事故是同一类。
 */
export function normalizeJudgeTrace(trace: readonly JudgeTraceItem[]): JudgeTraceItem[] {
  const out: JudgeTraceItem[] = [];
  for (const t of trace) {
    if (!t || !t.type) continue;
    if (t.type === 'tool') {
      // 技能节点：一次展开成「调用 + 结果」两条，顺序与对话通道一致
      const name = String(t.tool || t.name || '');
      out.push({ type: 'tool_call', name });
      if (typeof t.output === 'string' && t.output) out.push({ type: 'tool_result', name, result: t.output });
      continue;
    }
    if (t.type === 'tool_call') {
      out.push({ type: 'tool_call', name: String(t.name || t.tool || '') });
      continue;
    }
    if (t.type === 'tool_result') {
      out.push({ type: 'tool_result', name: String(t.name || t.tool || ''), result: t.result });
      continue;
    }
    // 其它类型（reasoning / llm / loop）：**不转发**，见约束 1）
  }
  return out;
}

/**
 * 本轮是否值得花一次调用去评审。
 * 只挑「用过高风险工具 + 确实产出了回答」的轮次：
 * 纯闲聊、纯知识库问答的答错代价低，不值得常态计费。
 */
export function shouldJudge(trace: readonly JudgeTraceItem[], answer: string): boolean {
  if (!String(answer || '').trim()) return false;
  return trace.some(
    (t) =>
      (t.type === 'tool_call' || t.type === 'tool') &&
      HIGH_RISK_TOOLS.test(String(t.name || t.tool || '')),
  );
}

export type JudgeDecisionReason = 'ok' | 'disabled' | 'empty_answer' | 'no_high_risk' | 'sampled_out';

export type JudgeDecision = { judge: boolean; reason: JudgeDecisionReason };

/**
 * 纯函数判定：该不该判、不该判是因为什么。
 *
 * 把「原因」返回出来是本模块最重要的一处设计：否则「judge 没跑」和
 * 「judge 跑了但没查出问题」在日志里完全一样——这正是 v8.7 处理
 * 「0 的三种含义」时确立的规矩，在抽样场景下同样成立。
 *
 * 日预算不在这里判断：它需要 I/O（Redis/计数器），放进纯函数会让它不可测。
 */
export function decideJudge(p: {
  trace: readonly JudgeTraceItem[];
  answer: string;
  question: string;
  channel: JudgeChannel;
  policy: JudgePolicy;
  /** 用于采样种子的日期键（测试可注入） */
  dateKey?: string;
}): JudgeDecision {
  if (!p.policy.enabled) return { judge: false, reason: 'disabled' };
  if (!String(p.answer || '').trim()) return { judge: false, reason: 'empty_answer' };
  // 先做便宜的判断（高风险工具），再采样：避免为不可能被判的轮次消耗采样与预算
  if (!shouldJudge(p.trace, p.answer)) return { judge: false, reason: 'no_high_risk' };
  const seed = `${p.dateKey ?? dayKey(Date.now())}|${p.channel}|${p.question}|${p.answer}`;
  if (!sampleHit(seed, p.policy.samplePercent)) return { judge: false, reason: 'sampled_out' };
  return { judge: true, reason: 'ok' };
}

/** 把工具轨迹压成「做了什么 + 拿到什么」，不含模型思考过程 */
export function digestTrace(trace: readonly JudgeTraceItem[], maxChars = 3000): string {
  const lines = trace
    .filter((t) => t.type === 'tool_result' && (t.result || t.output))
    .map((t) => `- 工具 ${t.name || t.tool || '未命名'}: ${String(t.result || t.output).slice(0, 600)}`);
  return lines.join('\n').slice(0, maxChars);
}

export function buildJudgePrompt(p: { question: string; answer: string; traceDigest: string }): string {
  return [
    `【用户问题】\n${String(p.question).slice(0, 2000)}`,
    `【工具执行记录（客观结果，可能为空）】\n${p.traceDigest || '（本轮无工具结果）'}`,
    `【最终回答】\n${String(p.answer).slice(0, 4000)}`,
  ].join('\n\n');
}

export const JUDGE_SYSTEM = [
  '你是独立的交付质检员。你只能看到用户问题、工具执行记录、最终回答，看不到任何推理过程。',
  '请判断最终回答是否存在下列问题之一：',
  '1) 与工具执行记录矛盾（例如记录是失败/空结果，回答却说成功或给出具体数值）；',
  '2) 凭空给出记录里没有的具体数据、链接、文件路径或来源；',
  '3) 没有回答用户的实际问题（答非所问、只复述过程）。',
  '只输出一个 JSON 对象：{"verdict":"pass"|"fail","score":1-5 的整数,"reason":"一句话理由"}。',
  '不要输出 JSON 以外的任何内容。没有明显问题时判 pass，不要为了挑刺而挑刺。',
].join('\n');

/** 严格解析：明确 verdict 才认；解析不出就返回 null（不猜、也不当成 fail） */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { pass: null, score: null, reason: raw.slice(0, 200) };
  try {
    const j = JSON.parse(m[0]);
    const v = String(j?.verdict ?? '').trim().toLowerCase();
    const pass = v === 'pass' ? true : v === 'fail' ? false : null;
    const score = typeof j?.score === 'number' && j.score >= 1 && j.score <= 5 ? j.score : null;
    return { pass, score, reason: String(j?.reason ?? '').slice(0, 300) || raw.slice(0, 200) };
  } catch {
    return { pass: null, score: null, reason: raw.slice(0, 200) };
  }
}

/** 日预算 key：滚动 24 小时（Redis TTL 语义），不是自然日清零 */
function budgetKey(ts: number): string {
  return `judge:budget:${dayKey(ts)}`;
}

export type JudgeRunInput = {
  userId: string;
  channel: JudgeChannel;
  /** 技能名 / 定时任务名；对话通道为空 */
  label?: string;
  question: string;
  answer: string;
  trace: readonly JudgeTraceItem[];
  signal?: AbortSignal;
  /** 测试注入：固定判定时刻（影响采样种子与预算 key） */
  now?: number;
};

/**
 * 跑一次抽查。**不抛异常**——质检失败不能影响用户已经拿到的回答。
 *
 * 返回 `true` 表示真的调了一次模型（便于测试与观测），`false` 表示被闸掉了。
 */
export async function runChannelJudge(p: JudgeRunInput): Promise<boolean> {
  const policy = readJudgePolicy();
  const now = p.now ?? Date.now();
  const normalized = normalizeJudgeTrace(p.trace);

  const decision = decideJudge({
    trace: normalized,
    answer: p.answer,
    question: p.question,
    channel: p.channel,
    policy,
    dateKey: dayKey(now),
  });
  if (!decision.judge) return false;

  // 预算闸放在采样之后：避免为本来就不会判的轮次消耗计数
  if (policy.dailyMax > 0) {
    const allowed = await checkRateLimit(budgetKey(now), policy.dailyMax, 86400);
    if (!allowed) {
      // 必须留一行：否则「judge 这半天没动静」会被误读成「模型没问题」
      await logAction(p.userId, 'eval_judge', 'judge_skipped', {
        status: 'info',
        detail: `judge · ${p.channel}${p.label ? `/${p.label}` : ''} · 日预算已用尽（RUNTIME_JUDGE_DAILY_MAX=${policy.dailyMax}），本轮不再抽查`,
      }).catch(() => {});
      return false;
    }
  }

  if (p.signal?.aborted) return false;

  const traceDigest = digestTrace(normalized);
  const { model, tier, reason } = await resolveModelForTask('judge');
  if (!model) return false;

  const where = `judge · ${p.channel}${p.label ? `/${p.label}` : ''}`;
  try {
    const { text } = await callModel({
      model,
      label: 'judge',
      system: JUDGE_SYSTEM,
      prompt: buildJudgePrompt({ question: p.question, answer: p.answer, traceDigest }),
      // 判定只需一句话，限死输出上限，避免这条旁路悄悄变贵
      maxTokens: 200,
      userId: p.userId,
      signal: p.signal,
      // judge 是旁路：宁可早失败也不要把收尾拖住
      timeoutMs: 45_000,
    });
    const v = parseJudgeVerdict(text);
    await logAction(p.userId, 'eval_judge', v.pass === false ? 'judge_fail' : 'judge_pass', {
      status: v.pass === false ? 'warn' : 'info',
      detail: `${where} · judge(${model.name},${tier};${reason}): score=${v.score ?? 'n/a'} ${v.reason}`.slice(0, 1500),
    });
    return true;
  } catch (e: any) {
    // judge 自身失败单独记一条，否则会被误读成「回答有问题」
    await logAction(p.userId, 'eval_judge', 'judge_error', {
      status: 'warn',
      detail: `${where} · judge 调用失败：${String(e?.message || e).slice(0, 300)}`,
    }).catch(() => {});
    return false;
  }
}

/**
 * 对话通道入口（保持 V8.3 的调用签名不变）。
 *
 * `chat/route.ts` 用的是 fire-and-forget，所以这里也不做额外的生命周期管理。
 */
export async function runRuntimeJudge(p: {
  userId: string;
  question: string;
  answer: string;
  trace: JudgeTraceItem[];
  signal?: AbortSignal;
}): Promise<void> {
  if (!judgeEnabled()) return;
  if (p.signal?.aborted) return;
  await runChannelJudge({
    userId: p.userId,
    channel: 'chat',
    question: p.question,
    answer: p.answer,
    trace: p.trace,
    signal: p.signal,
  });
}

/**
 * 非对话通道入口（V8.9）。技能与定时任务共用。
 *
 * 轨迹用 `ChannelTraceNode`（`{type:'tool',tool,output}`）：那是这两条通道的真实形状，
 * 由调用方原样传入，归一化交给 `normalizeJudgeTrace`——不要在调用点各写一遍，
 * 写两遍就一定会有一处忘掉（见 `channel-verify.ts` 文件头的同类教训）。
 */
export async function judgeChannelAnswer(p: {
  userId: string;
  channel: 'skill' | 'schedule';
  label?: string;
  question: string;
  answer: string;
  trace: readonly ChannelTraceNode[];
  signal?: AbortSignal;
}): Promise<void> {
  if (!judgeEnabled()) return;
  if (p.signal?.aborted) return;
  await runChannelJudge({
    userId: p.userId,
    channel: p.channel,
    label: p.label,
    question: p.question,
    answer: p.answer,
    trace: p.trace as JudgeTraceItem[],
    signal: p.signal,
  });
}
