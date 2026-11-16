import { Queue, Worker } from 'bullmq';
import { getBullConnection, pingRedis } from './redis';
import { db } from './db';
import { documents, chunks, knowledgeBases } from './schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { embedTextsDetailed, isAutoEmbeddingRef, normalizeEmbeddingRef } from './ai/embed';
import { clearRetrieveCache } from './ai/rag';
import { saveChunkEmbedding } from './db';

// 基于 Redis 的轻量任务队列（BullMQ）。无 Redis 时自动降级为进程内异步执行
// （见下方 enqueueIndex），上传/重建接口先返回，向量化在后台继续完成。
let queue: Queue | null = null;
let worker: Worker | null = null;
let workerStarted = false;
let bullConn: ReturnType<typeof getBullConnection> = null;

/** Redis 连通性探测结果与探测时间（Redis 未启动时不做无谓的队列连接，避免任务被静默吞掉） */
let redisUsable: boolean | null = null;
let redisCheckedAt = 0;
const REDIS_RECHECK_MS = 60_000;

/** 探测 Redis 是否真的可用（配置了 REDIS_URL 但服务没起是常见情况） */
async function isQueueUsable(): Promise<boolean> {
  const now = Date.now();
  if (redisUsable !== null && now - redisCheckedAt < REDIS_RECHECK_MS) return redisUsable;
  redisUsable = await pingRedis(1500);
  redisCheckedAt = now;
  return redisUsable;
}

/**
 * 读取文档所属知识库指定的 embedding 模型；「自动」返回 null（走全局候选链）。
 * 返回 null 时 embedTextsDetailed 会从候选链首个模型开始。
 */
async function kbEmbeddingRef(docId: string): Promise<string | null> {
  const doc = (
    await db.select({ kbId: documents.kbId }).from(documents).where(eq(documents.id, docId)).limit(1)
  )[0];
  if (!doc) return null;
  const kb = (
    await db
      .select({ embeddingModel: knowledgeBases.embeddingModel })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, doc.kbId))
      .limit(1)
  )[0];
  const ref = normalizeEmbeddingRef(kb?.embeddingModel);
  return isAutoEmbeddingRef(ref) ? null : ref;
}

/**
 * 取出该文档尚未向量化的切片，分批 embedding 写入（支持 pgvector 双写）。
 * 分批（默认 8 条/批）可显著减少云端 embedding 的请求次数与耗时。
 * 若所属知识库指定了 embedding 模型，则优先用它；失败后依次尝试全局候选链，
 * 并把「实际使用的模型」记录到每个切片，检索时按模型分组算查询向量。
 */
export async function indexDocument(docId: string) {
  const preferred = await kbEmbeddingRef(docId);
  const rows = await db
    .select({ id: chunks.id, content: chunks.content, embedding: chunks.embedding })
    .from(chunks)
    .where(and(eq(chunks.docId, docId), isNull(chunks.embedding)));
  const BATCH = 8;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let result: { vectors: number[][]; modelId: string } = { vectors: [], modelId: '' };
    try {
      result = await embedTextsDetailed(batch.map((r) => r.content), preferred);
    } catch {
      result = { vectors: [], modelId: '' }; // 交给下方逐条兜底
    }
    for (let k = 0; k < batch.length; k++) {
      const vec = result.vectors[k];
      if (!vec || !vec.length) continue;
      try {
        await saveChunkEmbedding(batch[k].id, vec, result.modelId);
      } catch {
        /* 单条失败不影响整体 */
      }
    }
  }
  // 即使全部失败（如完全无 embedding 模型可用），也标记为已索引（走词法召回）
  // chunkCount 取文档实际切片总数，不能用「本次待回填数」（局部回填时会把总数改小）
  const total = await db
    .select({ c: sql<number>`count(*)` })
    .from(chunks)
    .where(eq(chunks.docId, docId));
  await db
    .update(documents)
    .set({ status: 'indexed', chunkCount: Number(total[0]?.c ?? 0) })
    .where(eq(documents.id, docId));
  // V8.3 · W2：索引完成后立刻让检索短缓存失效，否则新入库的内容最多 60s 检索不到
  clearRetrieveCache();
}

function setup(): Queue | null {
  if (!bullConn) bullConn = getBullConnection();
  const conn = bullConn;
  if (!conn) return null;
  // 不能每次调用都 new Queue：每个 Queue 实例各持一条 Redis 连接，
  // 而 enqueueIndex 每次上传都会走到这里 —— 传几次就把连接数堆上去了。
  if (!queue) queue = new Queue('document-index', { connection: conn as any });
  if (!workerStarted) {
    workerStarted = true;
    worker = new Worker(
      'document-index',
      async (job) => {
        const { docId } = job.data as { docId: string };
        await indexDocument(docId);
      },
      { connection: conn as any },
    );
  }
  return queue;
}

/**
 * 文档上传后投递异步索引任务。
 * 有 Redis：交给 BullMQ Worker（后台并发索引）。
 * 无 Redis / Redis 不可用 / 入队失败：**同步兜底**在当前进程完成向量化，
 * 保证文档状态能从 indexing → indexed、切片能真正写入向量（否则向量永远缺失）。
 */
export async function enqueueIndex(docId: string): Promise<void> {
  try {
    if (await isQueueUsable()) {
      const q = setup();
      if (q) {
        await q.add('index', { docId }, { removeOnComplete: true, removeOnFail: true, attempts: 3 });
        return;
      }
    }
  } catch {
    /* 队列不可用 → 同步兜底 */
  }
  try {
    await indexDocument(docId);
  } catch {
    /* 兜底也失败：文档仍会被标记，检索走词法召回 */
  }
}

/**
 * 优雅关闭：先停 Worker（等手上这一条索引跑完），再断 Queue 与专用连接。
 *
 * 顺序不能反：先断连接会让正在跑的 job 直接抛错，BullMQ 会把它标记为 stalled，
 * 重启后可能被重复消费 —— 索引是幂等的，代价只是白跑一遍 embedding（要花钱）。
 */
export async function closeQueue(): Promise<void> {
  const w = worker;
  const q = queue;
  const conn = bullConn;
  worker = null;
  queue = null;
  bullConn = null;
  workerStarted = false;

  if (w) {
    // close() 默认等待当前 job 处理完；给 5s 上限，避免卡死整个退出流程
    await Promise.race([
      w.close().catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 5000)),
    ]);
  }
  if (q) await q.close().catch(() => {});
  if (conn) {
    try {
      await conn.quit();
    } catch {
      try {
        conn.disconnect();
      } catch {
        /* 已断开 */
      }
    }
  }
}
