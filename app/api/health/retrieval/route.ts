import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, ensureInit, isVectorSupported, getDbSelfCheck } from '@/lib/db';
import { EMBED_DIM } from '@/lib/ai/embed-dim';
import { decideRetrievalPath } from '@/lib/ai/retrieval-path';
import { getSession } from '@/lib/auth';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 检索路径自检：一次请求回答「现在到底走 pgvector 还是内存余弦，为什么」。
 *
 * 加它的原因不是运维洁癖，而是修一个「看不出来」的问题：
 * 本机没装 pgvector，`rag.ts` 的 `<=>` 快路径一次都没执行过，但代码里它好好地在那儿，
 * 页面也看不出任何异常。这类「看起来支持」的状态最容易骗过自己——
 * 等到换到装了扩展的环境，那条路径第一次执行即首次上生产。
 *
 * 返回里的 `pgvectorVerified` 由探测结果实时计算（2026-11-09 修正）：
 * 只有「扩展可用 + 列维度匹配 + 无 JSON-only 切片 + 有切片 + HNSW 索引已建」全部成立才算已验证。
 * 早期版本把它硬编码成 false，装好扩展后诊断页仍宣称「未验证」，属于会误导排障的假阴性。
 *
 * 查询一律经 `db.execute`：`await sql\`...\`` 只会拿回 SQL 片段对象、不会执行，
 * 这正是快路径此前变成死代码的原因（详见 lib/ai/rag.ts 同位置注释）。
 */
export async function GET() {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(undefined, 401, 'UNAUTHORIZED', '未登录');

  const supported = isVectorSupported();
  const problems: string[] = [];

  let indexedChunks = 0;
  let distinctModels = 0;
  let jsonOnlyChunks = 0;
  let columnDim: number | null = null;
  let hnswReady = false;

  // 1) 有向量列的切片总量与模型分布（不依赖 embedding_vec，任何环境都能查）
  try {
    const stat = (await db.execute(sql`
      SELECT count(*) AS total, count(DISTINCT embedding_model) AS models
      FROM chunks WHERE embedding IS NOT NULL
    `)) as unknown as { total: number | string; models: number | string }[];
    indexedChunks = Number(stat[0]?.total || 0);
    distinctModels = Number(stat[0]?.models || 0);
  } catch (e: any) {
    problems.push(`统计切片失败：${String(e?.message || e).slice(0, 160)}`);
  }

  // 2) 向量列的实际维度（列不存在时返回 null，不报错）
  try {
    const col = (await db.execute(sql`
      SELECT format_type(atttypid, atttypmod) AS t
      FROM pg_attribute
      WHERE attrelid = 'chunks'::regclass AND attname = 'embedding_vec' AND NOT attisdropped
    `)) as unknown as { t: string }[];
    const m = String(col[0]?.t || '').match(/vector\((\d+)\)/);
    columnDim = m ? Number(m[1]) : null;
  } catch (e: any) {
    problems.push(`读取向量列维度失败：${String(e?.message || e).slice(0, 160)}`);
  }

  // 3) 只有 JSON 向量的切片数。列不存在时直接置为全部，不去查一个不存在的列
  if (columnDim === null) {
    jsonOnlyChunks = indexedChunks;
  } else {
    try {
      const j = (await db.execute(sql`
        SELECT count(*) AS c FROM chunks WHERE embedding IS NOT NULL AND embedding_vec IS NULL
      `)) as unknown as { c: number | string }[];
      jsonOnlyChunks = Number(j[0]?.c || 0);
    } catch (e: any) {
      problems.push(`统计 JSON-only 切片失败：${String(e?.message || e).slice(0, 160)}`);
      jsonOnlyChunks = indexedChunks;
    }
  }

  // 2b) HNSW 索引是否真的建成。没有索引时 `<=>` 仍是全表扫描，
  //     能返回正确结果但不该被标成「已验证的索引检索」。
  try {
    const idx = (await db.execute(sql`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'chunks' AND indexname = 'idx_chunks_vec'
    `)) as unknown as { indexname: string }[];
    hnswReady = idx.length > 0;
  } catch (e: any) {
    problems.push(`读取向量索引失败：${String(e?.message || e).slice(0, 160)}`);
  }

  const verdict = decideRetrievalPath({
    vectorSupported: supported,
    indexedChunks,
    jsonOnlyChunks,
    distinctModels,
    vectorDimOk: columnDim === EMBED_DIM,
  });

  const selfCheck = getDbSelfCheck();

  return NextResponse.json({
    path: verdict.path,
    reason: verdict.reason,
    pgvectorVerified:
      verdict.path === 'pgvector' && hnswReady && columnDim === EMBED_DIM && indexedChunks > 0 && jsonOnlyChunks === 0,
    facts: {
      extensionReady: supported,
      columnDim,
      embedDim: EMBED_DIM,
      hnswIndex: hnswReady,
      indexedChunks,
      jsonOnlyChunks,
      distinctModels,
    },
    // 启动时没建成的字段/索引也要露出来：少了它们系统照跑，只是某些功能会莫名不对
    vectorError: selfCheck.vectorError,
    schemaIssues: selfCheck.schemaIssues,
    // 本次查询失败要如实报出来，不能因为「返回 200」就让人以为一切正常
    ...(problems.length ? { problems } : {}),
    hint:
      verdict.path === 'pgvector'
        ? '当前已走向量索引。首次启用后请对同一问题对比召回结果，确认排序与内存路径一致。'
        : '内存余弦在切片量小（数百级）时完全够用，不是故障；上方 reason 给出了未走快路径的具体原因（缺列 / 待回填 / 维度不符 / 多模型混用）。',
  });
}
