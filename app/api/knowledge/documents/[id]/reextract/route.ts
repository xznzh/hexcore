import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { db } from '@/lib/db';
import { documents, chunks } from '@/lib/schema';
import { eq, asc, sql } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { enqueueIndex } from '@/lib/queue';
import { splitText, joinChunks } from '@/lib/ai/rag';
import { extractTextFromBuffer } from '@/lib/ai/extract';
import { resolveSafe } from '@/lib/storage';
import { rowsOf } from '@/lib/sql';
import { canAccessKb } from '@/lib/kb-access';
import { withApi, apiError } from '@/lib/api/handler';
import { redactSensitive } from '@/lib/redact';

export const dynamic = 'force-dynamic';

/** 归一化：去掉扩展名与所有标点/分隔符，只留字母数字与汉字，用于「文档名 ↔ 存储文件名」匹配 */
function normName(s: string): string {
  return String(s || '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^\w一-龥]/g, '')
    .toLowerCase();
}

/**
 * 重新解析单个文档：**从原始文件重抽文本**，再重新切块、重建向量。
 *
 * 三个动作的区别（顺序是「粒度由粗到细」）：
 * - `/reindex`：切片不动，只重算向量；
 * - `/rechunk`：从现有切片反推原文再切，**救不了抽取阶段就丢的结构**（表格被摊平成一格一行）；
 * - `/reextract`：回原始文件重抽，解析规则升级后只有这条路能让存量文档享受到。
 *
 * 前提是原始文件还在 `data/files`。找不到时明确报错，让用户重新上传，不要静默跳过。
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

  // 找原始文件：存储文件名带 f_xxx_ 前缀且被净化过，按「去标点后包含」匹配
  const fileRows = rowsOf(
    await db.execute(sql`SELECT path, filename FROM files ORDER BY created_at DESC LIMIT 500`),
  );
  const target = normName(doc.filename);
  const hit = fileRows.find((f) => {
    const n = normName(String(f.filename));
    return n === target || n.includes(target) || (target.length > 6 && target.includes(normName(String(f.path).split('/').pop() || '')));
  });
  if (!hit) {
    apiError(400, 'INVALID_STATE', '找不到该文档的原始文件（可能来自早期上传或文件已清理），请删除后重新上传');
  }

  const abs = resolveSafe(String(hit.path));
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    apiError(400, 'INVALID_STATE', '原始文件在磁盘上已不存在，请删除后重新上传');
  }

  const extracted = await extractTextFromBuffer(doc.filename, buf);
  const text = (extracted?.text || '').trim();
  if (!text) {
    apiError(400, 'INVALID_STATE', `重新解析失败：${extracted?.error || '没有解析出文本'}`);
  }

  const oldRows = await db
    .select({ content: chunks.content })
    .from(chunks)
    .where(eq(chunks.docId, id))
    .orderBy(asc(chunks.idx));
  const beforeChars = oldRows.length ? joinChunks(oldRows.map((r) => r.content)).length : 0;

  const parts = splitText(redactSensitive(text).text);
  await db.delete(chunks).where(eq(chunks.docId, id));
  for (let i = 0; i < parts.length; i++) {
    await db
      .insert(chunks)
      .values({ id: newId('ck'), docId: id, kbId: doc.kbId, content: parts[i], idx: i, embedding: null });
  }
  await db.update(documents).set({ status: 'indexing', chunkCount: parts.length }).where(eq(documents.id, id));
  await logAction(s.userId, 'kb_reextract_doc', id);
  enqueueIndex(id).catch(() => {});

  return NextResponse.json({
    ok: true,
    engine: extracted.engine,
    before: { chunks: oldRows.length, chars: beforeChars },
    after: { chunks: parts.length, chars: text.length },
    message: `已按最新解析规则重抽：${beforeChars} 字 / ${oldRows.length} 片 → ${text.length} 字 / ${parts.length} 片（引擎 ${extracted.engine}），向量在后台重建`,
  });
});
