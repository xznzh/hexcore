import { resolveModel, resolveDefaultModel, canChat } from './ai/providers';
import { models } from './schema';
import { db } from './db';
import { eq } from 'drizzle-orm';
import { logLlm } from './observability';
import { decideAssignment, type ModelCandidate, type TaskKind } from './agent/model-tiers';
import { readTokenUsage } from './agent/token-usage';

export type ResolvedModel = Awaited<ReturnType<typeof resolveModel>>;

/**
 * 带指数退避的重试包装。遇到 429/5xx/网络抖动会自动重试，避免一次瞬时错误就断流。
 * 最多 retries 次，基础延迟 baseMs，按 2^n 增长。
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, baseMs = 400): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      const transient = /429|rate.?limit|5\d\d|ECONN|ETIMEDOUT|socket|timeout/i.test(msg);
      if (!transient || i === retries) break;
      const wait = baseMs * Math.pow(2, i) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * 解析模型，带降级链：指定模型 → 默认模型 → 任一可用 chat 模型。
 * 保证在「指定模型失效」时仍能服务（failover）。
 */
// 模型解析结果缓存：模型配置是管理员低频变更（增删/启停/改默认），缓存 30s 可显著减少
// 每请求对 models 表的往返（对话 / 调度都会走到这里）。配置变更最多 30s 后生效，对小团队可接受。
let fallbackCache: { at: number; value: ResolvedModel | null } | null = null;
const FALLBACK_TTL_MS = 30_000;

export async function resolveModelWithFallback(modelId?: string): Promise<ResolvedModel | null> {
  const compute = async (): Promise<ResolvedModel | null> => {
    if (modelId) {
      const r = await resolveModel(modelId);
      if (r) return r;
    }
    const def = await resolveDefaultModel();
    if (def) return def;
    const any = (await db.select().from(models).limit(10)).find((m) => {
      try {
        return (JSON.parse(m.capabilities || '[]') as string[]).includes('chat');
      } catch {
        return false;
      }
    });
    if (any) {
      const r = await resolveModel(any.id);
      if (r) return r;
    }
    return null;
  };

  // 仅对「未指定模型」的高频路径做缓存（指定模型时需即时校验可见性/启停，不缓存）
  if (!modelId) {
    const now = Date.now();
    if (fallbackCache && now - fallbackCache.at < FALLBACK_TTL_MS) return fallbackCache.value;
    const v = await compute();
    fallbackCache = { at: now, value: v };
    return v;
  }
  return compute();
}

/**
 * 模型配置变更后主动清缓存，使后台改动即时生效（替代 30s TTL 轮询陈旧）。
 * 在「新增/删除/启停/改默认/换 Key」等操作成功后调用即可。
 */
export function invalidateModelCache(): void {
  fallbackCache = null;
  candidateCache = null;
}

/**
 * 候选模型清单缓存（V8 · C1 用）。
 * 只需要 id 与价格两列，管理员低频变更，60s TTL 足够；与 fallbackCache 一起被
 * `invalidateModelCache()` 清掉，后台改配置后立即生效。
 */
let candidateCache: { at: number; value: ModelCandidate[] } | null = null;
const CANDIDATE_TTL_MS = 60_000;
/** 只告警一次：开关装了没合闸这件事，说一遍就够，不必每 60s 刷一行 */
let warnedNoPrice = false;

async function listChatCandidates(): Promise<ModelCandidate[]> {
  const now = Date.now();
  if (candidateCache && now - candidateCache.at < CANDIDATE_TTL_MS) return candidateCache.value;
  try {
    const rows = await db.select().from(models);
    const value = rows
      .filter((m) => m.enabled !== false && canChat(m.capabilities))
      .map((m) => ({ id: m.id, priceIn: m.priceIn, priceOut: m.priceOut }));
    /**
     * V8.3 · W4：让「装了没合闸」这件事自己喊出来。
     *
     * `pickCheapest` 只考虑有单价的候选（见 model-tiers.ts 的注释：没价格数据就不猜），
     * 而预置模型的单价默认全是 0 —— 于是「按价格自动降档」这条路径**一直是 no-op**，
     * 且完全静默：日志里看不到任何异常，只有账单上「怎么全用最贵的模型」。
     * 这里补一条一次性告警，把补救方式直接写进日志。
     */
    if (!warnedNoPrice && value.length > 1 && value.every((c) => c.priceIn + c.priceOut <= 0)) {
      warnedNoPrice = true;
      console.warn(
        '[tier] 模型分档的「按价格挑档」当前是 no-op：候选模型单价全为 0。' +
          '降档仍可通过 MODEL_CHEAP_ID（或 MODEL_TIER_SUMMARY / MODEL_TIER_JUDGE 等任务级变量）生效；' +
          '要启用自动挑选，请在管理后台为模型填写 price_in / price_out。',
      );
    }
    candidateCache = { at: now, value };
    return value;
  } catch {
    return []; // 读不到模型表时不降档，主模型照常服务
  }
}

/**
 * 按任务解析模型（V8 · C1 形态 B）。
 *
 * 与 `resolveModelWithFallback` 的区别：这个函数回答的是「**这个任务**该用哪一档」。
 * 决定权交给 `decideAssignment`（纯函数），这里只负责查库 + 解析实例 + 失败回退。
 * 任何环节出问题都退回主模型——分档是省钱手段，不该成为可用性风险。
 */
export async function resolveModelForTask(
  task: TaskKind,
  primaryModelId?: string,
): Promise<{ model: ResolvedModel | null; tier: 'primary' | 'cheap'; reason: string }> {
  const primary = await resolveModelWithFallback(primaryModelId);
  const candidates = await listChatCandidates();
  const assignment = decideAssignment(task, primary?.id ?? null, candidates);
  if (!assignment.modelId) return { model: primary, tier: 'primary', reason: assignment.reason };

  const cheap = await resolveModel(assignment.modelId);
  if (cheap) return { model: cheap, tier: 'cheap', reason: assignment.reason };

  // 降档目标被停用/删除：回退主模型，并记一条「升级」，这就是升级率的分母之一
  logLlm({
    model: assignment.modelId,
    label: `tier-escalate:${task}`,
    ms: 0,
    ok: false,
    error: '降档模型不可用，已回退主模型',
  }).catch(() => {});
  return { model: primary, tier: 'primary', reason: `${assignment.reason} → 目标不可用已回退` };
}

/** 统一封装一次 LLM 文本生成的耗时/Token/成败埋点（与 withRetry 组合使用）。 */
/** token 累加槽：executor 每次 LLM 调用后把用量喂进来，供 engine 做预算控制 */
export type UsageSink = { add(n: number): void; total(): number };

export async function withObservability<T>(
  modelName: string,
  label: string,
  fn: () => Promise<T>,
  opts?: { userId?: string; sink?: UsageSink },
): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    // best-effort 提取真实 token 数：generateText 同步返回 usage.totalTokens；
    // streamText 的 usage 是 Promise，这里只读同步属性，不为埋点 await 流完成。
    // 输入/输出分开记（v8.10）：两者单价不同，只记总量算不出金额。
    const { total: tokens, prompt: promptTokens, completion: completionTokens } = readTokenUsage((r as any)?.usage);
    if (typeof tokens === 'number' && opts?.sink) opts.sink.add(tokens);
    await logLlm({ model: modelName, label, ms: Date.now() - t0, ok: true, tokens, promptTokens, completionTokens, userId: opts?.userId });
    return r;
  } catch (e: any) {
    await logLlm({ model: modelName, label, ms: Date.now() - t0, ok: false, error: String(e?.message || e), userId: opts?.userId });
    throw e;
  }
}
