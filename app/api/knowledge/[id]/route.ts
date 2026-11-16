import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { documents, chunks } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { LOCAL_EMBEDDING } from '@/lib/ai/embed';
import { canAccessKb } from '@/lib/kb-access';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 列出某知识库下的文档
export const GET = withApi(async ({ session, params }) => {
  const { id } = (await params) as { id: string };

  // 越权防护：此前只校验登录，拿到任意 kbId 即可列出他人个人库文档。按列表接口同一口径校验可见性。
  if (!(await canAccessKb(id, session.userId, session.role))) {
    apiError(404, 'NOT_FOUND', '知识库不存在或无权访问');
  }

  const rows = await db.select().from(documents).where(eq(documents.kbId, id)).orderBy(documents.createdAt);

  // 哪些文档的向量退化成了本地哈希：状态看着是「已索引」，但检索质量会明显下降，
  // 用户无从得知。这里直接标出来，并提示重新索引可重试。
  const local = await db
    .select({ docId: chunks.docId, n: sql<number>`count(*)` })
    .from(chunks)
    .where(eq(chunks.embeddingModel, LOCAL_EMBEDDING))
    .groupBy(chunks.docId);
  const degraded = new Set(local.filter((r) => Number(r.n) > 0).map((r) => r.docId));

  return NextResponse.json(
    rows.map((d) => ({
      id: d.id,
      filename: d.filename,
      status: d.status,
      chunks: d.chunkCount || 0,
      createdAt: d.createdAt,
      degraded: degraded.has(d.id),
    })),
  );
});
