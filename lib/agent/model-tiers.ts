/**
 * 模型分档决策（V8 · C1，缺口 G6）。
 *
 * 背景：此前 `resolveModelWithFallback()` 在每个入口都解析成**同一个主模型**——
 * 记忆抽取、会话摘要、收尾合成、judge 抽查全部用最贵的那个模型跑，
 * 这些步骤占调用次数的大头却几乎不需要强推理，属于典型的「大炮打蚊子」。
 *
 * 本模块只做**决策**（纯函数，可单测），不碰数据库、不发请求：
 * 输入「任务类型 + 主模型 + 候选模型清单 + 环境变量」，输出「用哪个模型、为什么」。
 * 真正的模型实例解析在 `lib/llm.ts: resolveModelForTask`，数据库查询也在那侧。
 *
 * 设计原则（与 V8 §5 回滚约定一致）：
 *  1) **只降可降的任务**（白名单），chat 主推理永远用主模型——不为了省钱牺牲主线质量。
 *  2) **没有价格数据就不猜**：模型表里 price_in/price_out 都为 0 时无法排序成本，
 *     直接返回主模型，而不是按名字/id 排序瞎挑一个。
 *  3) 一个环境变量 `MODEL_TIERING=off` 即可全量回退（不改变任何调用路径）。
 */

/** 任务类型：决定能否降档 */
export type TaskKind =
  | 'chat' // 主对话推理：永不降档
  | 'summary' // 长对话压缩摘要
  | 'memory-extract' // 从对话里抽取长期记忆
  | 'synthesize' // 工具跑完但模型没吐字时的收尾合成
  | 'judge' // 独立 LLM-judge 抽查（R4-b）
  | 'critic'; // 技能步骤的 critic 复核

/**
 * 可降档任务白名单。
 * 判据：失败可容忍（都有 try/catch 或降级路径）+ 输出结构化/短（对模型推理深度不敏感）。
 * `chat` 故意不在表内——它是用户唯一直接感知质量的地方。
 */
export const DEGRADABLE_TASKS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'summary',
  'memory-extract',
  'synthesize',
  'judge',
  'critic',
]);

export type ModelCandidate = {
  id: string;
  /** 输入单价（分/千 token），与 models.price_in 对应 */
  priceIn: number;
  /** 输出单价（分/千 token） */
  priceOut: number;
};

export type Assignment = {
  /** null 表示「不指定，沿用主模型」 */
  modelId: string | null;
  tier: 'primary' | 'cheap';
  /** 决策依据，写进日志用；不要给用户看 */
  reason: string;
};

export type TierEnv = {
  MODEL_TIERING?: string;
  MODEL_CHEAP_ID?: string;
  /** 形如 MODEL_TIER_JUDGE=xxx，按任务临时指定模型 */
  [k: string]: string | undefined;
};

/** 分档是否启用：只有显式 `off`/`0`/`false` 才关闭（默认启用，但仅作用于白名单任务） */
export function isTieringEnabled(env: TierEnv = process.env as TierEnv): boolean {
  const v = String(env.MODEL_TIERING ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/**
 * 在候选里挑最便宜的（**只考虑有价格数据的**）。
 * 排除主模型自身，否则「降档」会变成「原地不动却记一次降档」。
 * 同价时按 id 排序，保证结果稳定（否则同一输入两次决策可能挑到不同模型，排障困难）。
 */
export function pickCheapest(candidates: ModelCandidate[], primaryId: string | null): ModelCandidate | null {
  const usable = candidates
    .filter((c) => c.id !== primaryId)
    .filter((c) => Number.isFinite(c.priceIn) && Number.isFinite(c.priceOut))
    .filter((c) => c.priceIn + c.priceOut > 0);
  if (!usable.length) return null;
  const cost = (c: ModelCandidate) => c.priceIn * 3 + c.priceOut; // 输出更贵：按 3:1 的典型进出比加权
  return usable.sort((a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id))[0];
}

/**
 * 决定某个任务该用哪个模型。
 *
 * 优先级：任务级 env 覆盖 > 全局 CHEAP_ID > 按价格挑最便宜 > 主模型。
 * 每次「本可降档但没降」都给出 reason，方便在日志里判断是配置没生效还是真的没有便宜档。
 */
export function decideAssignment(
  task: TaskKind,
  primaryId: string | null,
  candidates: ModelCandidate[],
  env: TierEnv = process.env as TierEnv,
): Assignment {
  if (!DEGRADABLE_TASKS.has(task)) {
    return { modelId: null, tier: 'primary', reason: `task:${task} 不在可降档白名单` };
  }
  if (!isTieringEnabled(env)) {
    return { modelId: null, tier: 'primary', reason: 'MODEL_TIERING=off' };
  }

  const exists = (id?: string) => (id && candidates.some((c) => c.id === id) ? id : null);

  const taskKey = `MODEL_TIER_${task.toUpperCase().replace(/-/g, '_')}`;
  const taskOverride = exists(env[taskKey]);
  if (taskOverride) return { modelId: taskOverride, tier: 'cheap', reason: `env:${taskKey}` };

  const globalCheap = exists(env.MODEL_CHEAP_ID);
  if (globalCheap) return { modelId: globalCheap, tier: 'cheap', reason: 'env:MODEL_CHEAP_ID' };

  const cheap = pickCheapest(candidates, primaryId);
  if (cheap) return { modelId: cheap.id, tier: 'cheap', reason: 'price:cheapest' };

  return { modelId: null, tier: 'primary', reason: 'no-cheap-model（候选模型均无价格数据或不存在更便宜的档位）' };
}
