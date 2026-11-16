import { NextResponse } from 'next/server';
import { db, isVectorSupported } from '@/lib/db';
import { documents } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { logAction } from '@/lib/util';
import { enqueueIndex } from '@/lib/queue';
import { canAccessKb } from '@/lib/kb-access';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 重新索引单个文档：清空该文档切片的旧向量 → 文档回到「索引中」→ 后台重新向量化。
 * 典型用途：历史文档卡在 indexing、切换 embedding 模型/维度后需要重算。
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

  // 清空旧向量，indexDocument 只处理 embedding 为空的切片
  if (isVectorSupported()) {
    await db.execute(sql`UPDATE chunks SET embedding = NULL, embedding_vec = NULL WHERE doc_id = ${id}`);
  } else {
    await db.execute(sql`UPDATE chunks SET embedding = NULL WHERE doc_id = ${id}`);
  }
  await db.update(documents).set({ status: 'indexing' }).where(eq(documents.id, id));
  await logAction(s.userId, 'kb_reindex_doc', id);

  // 不 await：无 Redis 时在进程内跑批次 embedding，完成后状态自动变 indexed
  enqueueIndex(id).catch(() => {});

  return NextResponse.json({ ok: true, message: '已开始重建该文档的向量，完成后状态会自动更新' });
});
