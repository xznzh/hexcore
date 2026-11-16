import { embed, embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { db } from '../db';
import { models } from '../schema';
import { safeDecrypt } from '../crypto';
import { EMBED_DIM } from './embed-dim';

export { EMBED_DIM }; // 本地降级向量维度（随 EMBED_DIM 环境变量变化）

/** 解析模型 capabilities 是否包含某能力 */
export function hasCapability(capsJson: string | null, cap: string): boolean {
  try {
    return (JSON.parse(capsJson || '[]') as string[]).includes(cap);
  } catch {
    return false;
  }
}

export type EmbeddingCandidate = {
  id: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  apiKey: string; // 已解密
  isDefault: boolean;
  enabled: boolean;
};

/**
 * 排出 embedding 模型候选链：只保留「启用 + 有 Key」的模型，
 * 默认模型排最前，其余保持配置顺序，作为失败时依次尝试的备选。
 */
export function orderEmbeddingCandidates<T extends EmbeddingCandidate>(candidates: T[]): T[] {
  const usable = candidates.filter((c) => c.enabled && c.apiKey.trim().length > 0);
  const defaults = usable.filter((c) => c.isDefault);
  const rest = usable.filter((c) => !c.isDefault);
  return [...defaults, ...rest];
}

/**
 * 从候选中挑出实际使用的 embedding 模型（候选链的第一个）。
 * 规则：只要「已配置 Key 且启用」的模型；其中优先 isDefault；都没有 Key → 返回 null（走本地降级）。
 * 这样新增预置模型不会因为排序问题抢占已配置好的模型。
 */
export function pickEmbeddingModel<T extends EmbeddingCandidate>(
  candidates: T[],
): T | null {
  return orderEmbeddingCandidates(candidates)[0] ?? null;
}

/** 知识库 embedding 模型的两种特殊引用：跟随全局候选链 / 本地降级向量 */
export const AUTO_EMBEDDING = 'auto';
export const LOCAL_EMBEDDING = 'local';

/** 归一化知识库里的模型引用：空值、'lexical'（历史占位）都视作「自动」 */
export function normalizeEmbeddingRef(ref: string | null | undefined): string {
  const v = (ref || '').trim();
  if (!v || v.toLowerCase() === 'lexical' || v.toLowerCase() === AUTO_EMBEDDING) return AUTO_EMBEDDING;
  return v;
}

export function isAutoEmbeddingRef(ref: string | null | undefined): boolean {
  return normalizeEmbeddingRef(ref) === AUTO_EMBEDDING;
}

/** 在候选链里按 id（优先）或模型名找可用模型；找不到返回 null */
export function pickCandidateByRef<T extends EmbeddingCandidate>(candidates: T[], ref: string): T | null {
  const v = (ref || '').trim();
  if (!v || v === AUTO_EMBEDDING) return null;
  return candidates.find((c) => c.id === v) || candidates.find((c) => c.name === v) || null;
}

/**
 * 校验知识库要保存的 embedding 引用，并把历史自由文本（模型名）统一成模型 id。
 * 只接受「自动」或「启用 + 具备 embedding 能力 + 已配置 Key」的模型。
 */
export async function validateEmbeddingRef(
  ref: string | null | undefined,
): Promise<{ value: string | null; error: string | null }> {
  const norm = normalizeEmbeddingRef(ref);
  if (norm === AUTO_EMBEDDING) return { value: AUTO_EMBEDDING, error: null };
  if (norm === LOCAL_EMBEDDING) {
    return { value: null, error: '本地降级向量仅作为兜底，不支持手动指定' };
  }
  const picked = pickCandidateByRef(await getEmbeddingCandidates(), norm);
  if (!picked) {
    return { value: null, error: '所选向量模型不可用（需启用、具备 embedding 能力且已配置 Key）' };
  }
  return { value: picked.id, error: null };
}

/** 把知识库指定的模型提到候选链最前；找不到（未配置 Key/已停用）则保持原链 */
export function prioritizeCandidate<T extends EmbeddingCandidate>(candidates: T[], ref?: string | null): T[] {
  const picked = pickCandidateByRef(candidates, normalizeEmbeddingRef(ref));
  if (!picked) return candidates;
  return [picked, ...candidates.filter((c) => c.id !== picked.id)];
}

/** 同一进程内失败过的模型短暂跳过，避免每次请求都先撞一遍不可达的本地服务 */
const FAIL_COOLDOWN_MS = 5 * 60_000;
const failedUntil = new Map<string, number>();

/**
 * 查询向量缓存（V8.3 · W2）。
 *
 * 缺口背景：`rag.ts` 里已经有一个 `qCache`，但它只在**单次 retrieve 内**去重——
 * 同一个问题隔两分钟再问一遍，仍要重新走一次 embedding 网络调用（跨境链路 0.3~2s）。
 * 而语义缓存（答案级）的命中判断在检索**之后**，所以「命中缓存省了模型钱，
 * 但 embedding、检索 SQL、精排 HTTP 已经花完了」。
 *
 * 这里补的是最小可复用单元：**查询文本 → 向量**。它比答案级缓存安全得多——
 * 向量只取决于文本与模型，不掺时间、不掺用量，不存在「跨分钟命中旧数字」的问题
 * （`cache-key.ts` 当初修的正是那个 bug）。
 *
 * 边界：
 *  - key 含模型引用（不同模型的维度/语义空间不能混用）；
 *  - 超长文本不缓存（避免把长文档塞进常驻内存）；
 *  - TTL 默认 10 分钟、容量 512，`EMBED_QUERY_CACHE_TTL_MS=0` 可关闭。
 */
type QueryVecEntry = { at: number; vec: number[]; modelId: string };
const QUERY_VEC_MAX = 512;
const queryVecCache = new Map<string, QueryVecEntry>();

function queryCacheTtlMs(): number {
  const raw = process.env.EMBED_QUERY_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 10 * 60_000;
}

function queryCacheKey(ref: string, text: string): string {
  return `${ref}\u0000${text}`;
}

function readQueryCache(key: string): QueryVecEntry | null {
  const ttl = queryCacheTtlMs();
  if (ttl <= 0) return null;
  const hit = queryVecCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= ttl) {
    queryVecCache.delete(key);
    return null;
  }
  return hit;
}

function writeQueryCache(key: string, vec: number[], modelId: string, textLen: number): void {
  const ttl = queryCacheTtlMs();
  // 长文本不进缓存：命中率低、内存占用高，且这类查询本身就慢在模型端而不是 embedding
  if (ttl <= 0 || textLen > 3000 || !vec?.length) return;
  queryVecCache.set(key, { at: Date.now(), vec, modelId });
  if (queryVecCache.size > QUERY_VEC_MAX) {
    // Map 的插入序即淘汰序：删最旧的一条，不做 LRU 链表（收益不值得复杂度）
    const oldest = queryVecCache.keys().next();
    if (!oldest.done) queryVecCache.delete(oldest.value);
  }
}

/** 清空查询向量缓存（模型/维度变更后调用） */
export function clearQueryVectorCache(): void {
  queryVecCache.clear();
}

function isCoolingDown(id: string, now = Date.now()): boolean {
  const until = failedUntil.get(id);
  if (!until) return false;
  if (until <= now) {
    failedUntil.delete(id);
    return false;
  }
  return true;
}

function markFailed(id: string) {
  failedUntil.set(id, Date.now() + FAIL_COOLDOWN_MS);
}

/** 取可用的 embedding 模型链：默认模型优先，其余按配置顺序，失败时依次尝试 */
export async function getEmbeddingCandidates(): Promise<EmbeddingCandidate[]> {
  const rows = await db.select().from(models);
  const candidates: EmbeddingCandidate[] = rows
    .filter((m) => hasCapability(m.capabilities, 'embedding'))
    .map((m) => ({
      id: m.id,
      provider: m.provider,
      name: m.name,
      baseUrl: m.baseUrl,
      apiKey: safeDecrypt(m.apiKey),
      isDefault: !!m.isDefault,
      enabled: m.enabled !== false,
    }));
  return orderEmbeddingCandidates(candidates);
}

/**
 * MiniMax 的向量接口不是 OpenAI 兼容格式：
 *   POST {baseUrl}/embeddings  { model: 'embo-01', texts: [...], type: 'db' | 'query' }
 *   返回 { vectors: number[][], base_resp: { status_code, status_msg } }
 * 且失败时 HTTP 仍是 200，必须看 base_resp.status_code。这里单独适配，其余模型仍走 AI SDK。
 */
export function isMinimaxEmbedding(m: Pick<EmbeddingCandidate, 'provider' | 'baseUrl'>): boolean {
  if ((m.provider || '').toLowerCase() === 'minimax') return true;
  return /(^|\.)minimax\.(cn|chat|io)\b/i.test(m.baseUrl || '');
}

/** 用某个具体模型算向量（indexing 用 'db'，检索查询用 'query'） */
export async function embedWithModel(
  m: EmbeddingCandidate,
  texts: string[],
  type: 'db' | 'query' = 'db',
): Promise<number[][]> {
  if (!texts.length) return [];
  if (isMinimaxEmbedding(m)) return embedMinimax(m, texts, type);
  const baseURL = m.baseUrl || 'https://api.openai.com/v1';
  const client = createOpenAI({ apiKey: m.apiKey, baseURL });
  if (texts.length === 1) {
    const { embedding } = await embed({ model: client.embedding(m.name), value: texts[0] });
    return [embedding as number[]];
  }
  const { embeddings } = await embedMany({ model: client.embedding(m.name), values: texts });
  return (embeddings as number[][]) || [];
}

async function embedMinimax(
  m: EmbeddingCandidate,
  texts: string[],
  type: 'db' | 'query',
): Promise<number[][]> {
  const base = (m.baseUrl || 'https://api.minimax.cn/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${m.apiKey}` },
    body: JSON.stringify({ model: m.name, texts, type }),
    // 30s 在跨境/高峰链路上容易把正常响应判成超时（2026-11-09 实测查询向量因此为 null，
    // pgvector 快路径被跳过）。放宽到 45s；真正的不可达仍由上层候选链冷却 + 内存降级兜住。
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`MiniMax HTTP ${res.status}`);
  const j = (await res.json()) as {
    vectors?: number[][];
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const code = j?.base_resp?.status_code;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`MiniMax ${code}: ${j.base_resp?.status_msg || '接口返回错误'}`);
  }
  const vectors = j?.vectors;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error('MiniMax 返回的向量数量与入参不符');
  }
  return vectors;
}

/** 取当前生效的 embedding 模型；无（未配置 Key）则返回 null → 走本地降级 */
export async function getEmbeddingModel(): Promise<{
  baseUrl: string;
  apiKey: string;
  name: string;
} | null> {
  const picked = (await getEmbeddingCandidates())[0];
  if (!picked) return null;
  return {
    baseUrl: picked.baseUrl || 'https://api.openai.com/v1',
    apiKey: picked.apiKey,
    name: picked.name,
  };
}

/**
 * 本地确定性向量（无 embedding 模型时的降级方案）。
 * 词频哈希 + L2 归一化，保证相同文本向量一致、相似文本余弦有区分度。
 */
export function localVector(text: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  const cleaned = text.toLowerCase();
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    v[code % EMBED_DIM] += 1;
    v[(code * 31) % EMBED_DIM] += 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export type EmbeddingBatchResult = {
  vectors: number[][];
  /** 实际产出向量的模型 id；'local' 表示全部模型不可用、走了本地降级 */
  modelId: string;
};

/**
 * 按候选链算向量：知识库指定的模型排最前，失败后依次尝试其余模型。
 * 返回实际使用的模型 id，供切片记录来源（不同模型/维度的向量不能混算）。
 * indexing 用 'db'，检索查询用 'query'（MiniMax 要求两者配对）。
 */
async function embedWithChain(
  texts: string[],
  type: 'db' | 'query',
  preferredRef?: string | null,
): Promise<EmbeddingBatchResult> {
  if (!texts.length) return { vectors: [], modelId: LOCAL_EMBEDDING };
  const chain = prioritizeCandidate(await getEmbeddingCandidates(), preferredRef);
  for (const m of chain) {
    if (isCoolingDown(m.id)) continue;
    try {
      const arr = await embedWithModel(m, texts, type);
      if (arr.length === texts.length && arr.every((v) => v && v.length)) {
        return { vectors: arr, modelId: m.id };
      }
      throw new Error('返回向量数量或维度异常');
    } catch (e) {
      markFailed(m.id);
      console.warn(`[embed] ${m.id} 批量调用失败，尝试下一个模型：${(e as Error)?.message || e}`);
    }
  }
  return { vectors: texts.map((t) => localVector(t)), modelId: LOCAL_EMBEDDING };
}

/**
 * 将文本转为向量（检索查询 → MiniMax 的 type='query'），并返回实际模型 id。
 * preferredRef 用于知识库指定了某个 embedding 模型时优先使用它。
 */
export async function embedTextDetailed(
  text: string,
  preferredRef?: string | null,
): Promise<{ vec: number[]; modelId: string }> {
  const refTag = normalizeEmbeddingRef(preferredRef);
  // 本地哈希向量便宜到不值得进缓存；云端模型才是要省的那一段
  const cacheable = refTag !== LOCAL_EMBEDDING;
  const key = queryCacheKey(`auto:${refTag}`, text);
  if (cacheable) {
    const hit = readQueryCache(key);
    if (hit) return { vec: hit.vec, modelId: hit.modelId };
  }
  const r = await embedWithChain([text], 'query', preferredRef);
  const out = { vec: r.vectors[0] || localVector(text), modelId: r.modelId };
  if (cacheable) writeQueryCache(key, out.vec, out.modelId, text.length);
  return out;
}

/** 单条查询向量（兼容旧调用：只返回向量） */
export async function embedText(text: string): Promise<number[]> {
  return (await embedTextDetailed(text)).vec;
}

/**
 * 批量向量化（切片入库 → MiniMax 的 type='db'），并返回实际使用的模型 id。
 * 批量能显著降低云端请求数与耗时；全部模型失败才整批降级为本地向量。
 */
export async function embedTextsDetailed(
  texts: string[],
  preferredRef?: string | null,
): Promise<EmbeddingBatchResult> {
  return embedWithChain(texts, 'db', preferredRef);
}

/** 批量向量（兼容旧调用：只返回向量） */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  return (await embedTextsDetailed(texts)).vectors;
}

/**
 * 为「已知向量来源」的切片生成查询向量：
 *  - 'local' → 本地哈希向量
 *  - 'auto'  → 全局候选链（旧数据 / 未指定模型的知识库）
 *  - 具体模型 → 只调用该模型，失败返回 null（不跨模型混算，避免维度/语义错配）
 * 同一个 retrieve 里由调用方按模型缓存结果。
 */
export async function embedQueryForModel(
  ref: string | null | undefined,
  text: string,
): Promise<{ vec: number[]; modelId: string } | null> {
  const norm = normalizeEmbeddingRef(ref);
  if (norm === LOCAL_EMBEDDING) return { vec: localVector(text), modelId: LOCAL_EMBEDDING };
  if (norm === AUTO_EMBEDDING) return embedTextDetailed(text);

  const key = queryCacheKey(norm, text);
  const hit = readQueryCache(key);
  if (hit) return { vec: hit.vec, modelId: hit.modelId };

  const m = pickCandidateByRef(await getEmbeddingCandidates(), norm);
  if (!m || isCoolingDown(m.id)) return null;
  try {
    const [vec] = await embedWithModel(m, [text], 'query');
    if (!vec || !vec.length) return null;
    writeQueryCache(key, vec, m.id, text.length);
    return { vec, modelId: m.id };
  } catch (e) {
    markFailed(m.id);
    console.warn(`[embed] ${m.id} 查询向量失败：${(e as Error)?.message || e}`);
    return null;
  }
}

/** 余弦相似度（任一为 null/空返回 0） */
export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
