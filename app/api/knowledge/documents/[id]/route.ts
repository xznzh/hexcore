import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { documents, chunks } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { logAction } from '@/lib/util';
import { canAccessKb } from '@/lib/kb-access';
import { clearRetrieveCache } from '@/lib/ai/rag';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 删除单个文档及其切片（需对该文档所属知识库有可见权限；访客只读）
export const DELETE = withApi(async ({ session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const doc = (await db.select().from(documents).where(eq(documents.id, id)).limit(1))[0];
  if (!doc) apiError(404, 'NOT_FOUND', '文档不存在');

  // 可见性口径统一到 lib/kb-access：此前这里是第三份手写的同义判断，
  // 与团队库/项目库规则一旦各自演化就会重新出现越权缺口。
  if (!(await canAccessKb(doc.kbId, s.userId, s.role))) {
    apiError(403, 'FORBIDDEN', '无权操作该文档');
  }

  await db.delete(chunks).where(eq(chunks.docId, id));
  await db.delete(documents).where(eq(documents.id, id));
  // V8.3 · W2：检索结果有 60s 短缓存，删除后必须立刻失效——
  // 否则接下来一分钟内模型仍会引用「已经不存在的文档」，比慢更糟。
  clearRetrieveCache();
  await logAction(s.userId, 'kb_delete_doc', id);
  return NextResponse.json({ ok: true });
});
