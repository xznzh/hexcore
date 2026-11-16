import { getRedis } from './redis';
import { db } from './db';
import { operationLogs } from './schema';
import { newId } from './util';
import { buildCacheKey } from './agent/cache-key';
import { and, eq } from 'drizzle-orm';

/** 记录语义缓存命中/未命中（用于命中率看板），best-effort。 */
export async function logCache(hit: boolean): Promise<void> {
  try {
    await db.insert(operationLogs).values({
      id: newId('log'),
      userId: null,
      action: 'llm_cache',
      target: hit ? 'hit' : 'miss',
      createdAt: Date.now(),
    });
  } catch {
    /* ignore */
  }
}

export async function cacheStats(): Promise<{ hit: number; miss: number; rate: number }> {
  // V6：改为 SQL 聚合 count，避免把整张 operation_logs 拉进内存再过滤（日志增长后全表扫描会显著变慢）。
  // 配合 db.ts 新增的 idx_operation_logs_action(action, created_at) 索引，命中率统计保持 O(1)。
  const hit = await db.$count(operationLogs, and(eq(operationLogs.action, 'llm_cache'), eq(operationLogs.target, 'hit')));
  const miss = await db.$count(operationLogs, and(eq(operationLogs.action, 'llm_cache'), eq(operationLogs.target, 'miss')));
  const total = hit + miss;
  return { hit, miss, rate: total ? Math.round((hit / total) * 100) : 0 };
}

/**
 * 语义缓存（Semantic Cache）：对相同 (model + system + 用户问题) 的回答做短 TTL 缓存，
 * 命中即直接返回，省 Token、降延迟。无 Redis 时自动跳过（不影响主流程）。
 *
 * V8 · C2：key 生成移到 lib/agent/cache-key.ts，并在哈希前对 system 做归一化
 * （去掉分钟级时间、实时 token/存储用量等每轮都变的片段），否则跨分钟即 miss。
 * variant 用于区分「同样入参但行为不同」的场景（如本轮是否强制调用能力）。
 */
export async function getCached(
  model: string,
  system: string,
  prompt: string,
  variant?: string,
): Promise<string | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const v = await r.get(buildCacheKey(model, system, prompt, variant));
    return v || null;
  } catch {
    return null;
  }
}

export async function setCached(
  model: string,
  system: string,
  prompt: string,
  answer: string,
  ttlSec = 600,
  variant?: string,
): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.set(buildCacheKey(model, system, prompt, variant), answer, 'EX', ttlSec);
  } catch {
    /* 忽略缓存写入失败 */
  }
}
