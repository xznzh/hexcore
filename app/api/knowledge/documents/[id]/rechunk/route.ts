import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { documents, chunks } from '@/lib/schema';
import { eq, asc } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { enqueueIndex } from '@/lib/queue';
import { splitText, joinChunks } from '@/lib/ai/rag';
import { canAccessKb } from '@/lib/kb-access';
import { withApi, apiError } from '@/lib/api/handler';
import { redactSensitive } from '@/lib/redact';

export const dynamic = 'force-dynamic';

/**
 * 重建单个文档的**切片**（不是只重算向量）。
 *
 * 与 `/reindex` 的区别：reindex 只把已有切片的 `embedding` 清空重算，
 * 切片边界不动。改了 `splitText` 的分块策略后，reindex 是无效的 ——
 * 必须重新切。原文没有单独落库（`documents` 只存元信息），
 * 所以先用 `joinChunks` 从现有切片还原，再按新策略重切。
 *
 * 典型用途：修复「一片 15 字」的碎片化历史数据；上传时解析引擎升级后重新切块。
 */
export const POST = withApi(async ({ session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const doc = (await db.select().from(documents).where(eq(documents.id, id)).limit(1))[0] as any;
  if (!doc) apiError(404, 'NOT_FOUND', '文档不存在');

  // 可见性口径统一到 lib/kb-access（原先是各路由手写的同义判断）
  if (!(await canAccessKb(doc.kbId, s.userId, s.role))) {
    apiError(403, 'FORBIDDEN', '无权操作该文档');
  }

  const rows = await db
    .select({ content: chunks.content })
    .from(chunks)
    .where(eq(chunks.docId, id))
    .orderBy(asc(chunks.idx));
  if (!rows.length) apiError(400, 'INVALID_STATE', '该文档没有切片可重建，请删除后重新上传');

  const text = joinChunks(rows.map((r) => r.content));
  if (!text.trim()) apiError(400, 'INVALID_STATE', '切片内容为空，无法重建');

  const parts = splitText(redactSensitive(text).text);
  await db.delete(chunks).where(eq(chunks.docId, id));
  for (let i = 0; i < parts.length; i++) {
    await db
      .insert(chunks)
      .values({ id: newId('ck'), docId: id, kbId: doc.kbId, content: parts[i], idx: i, embedding: null });
  }
  await db.update(documents).set({ status: 'indexing', chunkCount: parts.length }).where(eq(documents.id, id));
  await logAction(s.userId, 'kb_rechunk_doc', id);

  // 不 await：无 Redis 时在进程内跑批次 embedding，完成后状态自动变 indexed
  enqueueIndex(id).catch(() => {});

  return NextResponse.json({
    ok: true,
    before: rows.length,
    after: parts.length,
    message: `已重建切片：${rows.length} 片 → ${parts.length} 片，向量在后台重建`,
  });
});
