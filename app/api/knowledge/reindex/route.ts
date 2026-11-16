import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { documents } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { logAction } from '@/lib/util';
import { enqueueIndex } from '@/lib/queue';
import { rowsOf } from '@/lib/sql';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 全局回填：找出仍有切片缺向量的文档，逐篇重新入队索引。
 * 管理员维护入口（用户日常用文档行内的「重新索引」）。
 * 无 Redis 时 enqueueIndex 会在进程内异步完成，接口立即返回，状态随后自动更新。
 */
export const POST = withApi(
  async ({ session }) => {
    const rows = rowsOf(
      await db.execute(sql`
        SELECT d.id AS id, d.filename AS filename
          FROM documents d
         WHERE EXISTS (
           SELECT 1 FROM chunks c WHERE c.doc_id = d.id AND c.embedding IS NULL
         )
         ORDER BY d.created_at
      `),
    ) as { id: string; filename: string }[];

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, docs: 0, message: '所有文档都已生成向量，无需回填' });
    }

    for (const r of rows) {
      await db.update(documents).set({ status: 'indexing' }).where(eq(documents.id, r.id));
    }
    await logAction(session.userId, 'kb_reindex_all', `${rows.length} docs`);

    // 最多 3 篇并发，避免云端 embedding 瞬间被刷爆；不 await，接口先返回
    const queueIds = rows.map((r) => r.id);
    const run = async () => {
      let cursor = 0;
      const worker = async () => {
        while (cursor < queueIds.length) {
          const id = queueIds[cursor++];
          await enqueueIndex(id).catch(() => {});
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, queueIds.length) }, worker));
    };
    run().catch(() => {});

    return NextResponse.json({
      ok: true,
      docs: rows.length,
      message: `已开始回填 ${rows.length} 篇文档的向量，完成后状态会自动更新`,
    });
  },
  { auth: 'admin' },
);
