/**
 * 交叉编码器重排（rerank）——把「向量召回」的粗排结果交给专门的 rerank 模型精排。
 *
 * 为什么需要：向量检索本质是「双塔」，query 与文档各自独立编码，只能比整体语义距离；
 * 无法判断「这句话到底有没有回答这个问题」。cross-encoder（rerank 模型）把 query 与
 * 文档拼在一起过一次模型，精度明显更高——代价是贵且慢，所以只能对 top-N 候选做，
 * 不能对全库做。
 *
 * 设计上的三个约束（都不是可选项）：
 *  1. **未配置就完全不走网络**：models 表里没有「启用 + 有 Key + capabilities 含 rerank」
 *     的模型时直接返回 null，检索走原来的加权融合排序。不能因为「支持了 rerank」就让
 *     没配 rerank 的部署多一次必然失败的请求。
 *  2. **失败必须降级**：rerank 是增强项，它挂了不能让整个检索失败。超时 3s、异常吞掉
 *     并打印 warn，返回调用方的本地排序。
 *  3. **只改顺序，不改 score**：`filterRelevantHits` 的闸门（score >= 0.62）是按
 *     0.75×向量 + 0.25×词法 的分布定的。若把 rerank 分直接写回 score，不同模型的
 *     分数尺度差异极大（有的给 0~1，有的给 logits，有的对无关文档也给 0.6），
 *     闸门会立刻失真——要么放进一堆噪声，要么把正确答案全滤掉。
 *     因此这里的返回只用于「决定取哪 k 篇、以什么顺序」，score 仍由本地融合分给出。
 */
import { db } from '../db';
import { models } from '../schema';
import { safeDecrypt } from '../crypto';
import { hasCapability } from './embed';

export type RerankModel = {
  id: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  apiKey: string;
  isDefault: boolean;
};

/** 默认 baseUrl：按厂商给一个合理值，避免用户在后台只改了 Key 却忘了填 baseUrl */
function defaultBaseUrl(provider: string): string {
  const p = (provider || '').toLowerCase();
  if (p === 'jina') return 'https://api.jina.ai/v1';
  if (p === 'cohere') return 'https://api.cohere.com/v2';
  if (p === 'siliconflow') return 'https://api.siliconflow.cn/v1';
  return 'https://api.jina.ai/v1';
}

/** 超时可覆盖：rerank 在检索主链路上，宁可放弃精排也不能拖慢首字 */
function rerankTimeoutMs(): number {
  const n = Number(process.env.RERANK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

/**
 * 取当前可用的 rerank 模型。
 * 与 embedding 不同，rerank **不做失败冷却**：它在检索链路上是可选增强，
 * 失败一次就冷却 5 分钟会让「配置改好了但一直不生效」变成难查的问题；
 * 单次失败已经降级，代价可控。
 */
export async function getRerankModel(): Promise<RerankModel | null> {
  try {
    const rows = await db.select().from(models);
    const usable = rows
      .filter((m) => hasCapability(m.capabilities, 'rerank') && m.enabled !== false)
      .map((m) => ({
        id: m.id,
        provider: m.provider || '',
        name: m.name,
        baseUrl: m.baseUrl,
        apiKey: safeDecrypt(m.apiKey),
        isDefault: !!m.isDefault,
      }))
      .filter((m) => m.apiKey.trim().length > 0);
    return usable.find((m) => m.isDefault) ?? usable[0] ?? null;
  } catch (e) {
    // 表还没建好 / DB 抖动时不应让检索整体失败
    console.warn(`[rerank] 读取模型配置失败，跳过精排：${(e as Error)?.message || e}`);
    return null;
  }
}

/**
 * 解析 rerank 接口返回。按 Jina / Cohere v2 / SiliconFlow 共用的格式：
 *   { results: [ { index, relevance_score } ] }
 * 校验放在这里而不是调用方，是因为「越界 index」会静默取到 undefined 或错位文档——
 * 这类错误不会抛异常，只会让排序莫名其妙地错，最难查。
 */
export function parseRerankResponse(
  json: unknown,
  docCount: number,
): { index: number; score: number }[] {
  const raw = (json as any)?.results;
  if (!Array.isArray(raw)) return [];
  const out: { index: number; score: number }[] = [];
  for (const r of raw) {
    const idx = Number(r?.index);
    // relevance_score 是标准字段；部分网关返回 score，一并兼容
    const s = Number(r?.relevance_score ?? r?.score);
    if (!Number.isInteger(idx) || idx < 0 || idx >= docCount) continue;
    if (!Number.isFinite(s)) continue;
    out.push({ index: idx, score: s });
  }
  return out;
}

/**
 * 调用 rerank 模型。返回已按相关度降序、且 index 去重后的结果。
 * 抛错交给调用方降级——这里不做 try/catch，避免「静默返回空数组」被误当成
 * 「模型认为没有相关文档」。
 */
export async function rerankDocuments(
  m: RerankModel,
  query: string,
  documents: string[],
  topN: number,
): Promise<{ index: number; score: number }[]> {
  if (!documents.length) return [];
  const base = (m.baseUrl || defaultBaseUrl(m.provider)).replace(/\/+$/, '');
  const res = await fetch(`${base}/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${m.apiKey}` },
    body: JSON.stringify({ model: m.name, query, documents, top_n: Math.min(topN, documents.length) }),
    signal: AbortSignal.timeout(rerankTimeoutMs()),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`rerank HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`);
  }
  const parsed = parseRerankResponse(await res.json(), documents.length);
  // 去重（保留首次出现的更高分顺序），并按分数降序
  const seen = new Set<number>();
  return parsed
    .filter((r) => (seen.has(r.index) ? false : (seen.add(r.index), true)))
    .sort((a, b) => b.score - a.score);
}
