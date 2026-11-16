import { NextResponse } from 'next/server';
import { db, isVectorSupported } from '@/lib/db';
import { knowledgeBases, documents, chunks } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { splitText } from '@/lib/ai/rag';
import { extractTextFromBuffer, UNSUPPORTED_HINT } from '@/lib/ai/extract';
import { enqueueIndex } from '@/lib/queue';
import { accessibleProjectIds, canAccessProject } from '@/lib/projects';
import { normalizeEmbeddingRef, validateEmbeddingRef, AUTO_EMBEDDING } from '@/lib/ai/embed';
import { canAccessKb } from '@/lib/kb-access';
import { withApi, apiError } from '@/lib/api/handler';
import { redactSensitive, redactSummary } from '@/lib/redact';

export const dynamic = 'force-dynamic';

const TEXT_RE = /\.(txt|text|md|markdown|mdx|json|jsonl|csv|tsv|log|yml|yaml|xml|html?|env|sql|py|js|ts|java|go|c|cpp|cs|sh|bat|ps1|rst|tex)$/i;

/**
 * 清空该库所有切片的旧向量（含 pgvector 列），文档回到「索引中」，
 * 再以最多 3 并发在后台按新模型重建。不 await，接口立即返回。
 */
function rebuildKbVectors(kbId: string) {
  void (async () => {
    try {
      if (isVectorSupported()) {
        await db.execute(
          sql`UPDATE chunks SET embedding = NULL, embedding_vec = NULL, embedding_model = NULL WHERE kb_id = ${kbId}`,
        );
      } else {
        await db.execute(sql`UPDATE chunks SET embedding = NULL, embedding_model = NULL WHERE kb_id = ${kbId}`);
      }
      await db.update(documents).set({ status: 'indexing' }).where(eq(documents.kbId, kbId));
      const docs = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.kbId, kbId));
      const pending = docs.map((d) => d.id);
      const worker = async () => {
        while (pending.length) {
          const docId = pending.shift()!;
          await enqueueIndex(docId).catch(() => {});
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, docs.length) }, worker));
    } catch {
      /* 后台重建失败：文档停留在 indexing，用户可手动「重新索引」 */
    }
  })();
}

// 列出知识库（含文档数、切片数）。可见规则：团队库所有人可见；个人库仅属主可见。
export const GET = withApi(async ({ session }) => {
  const s = session;
  const kbs = await db.select().from(knowledgeBases).orderBy(knowledgeBases.createdAt);
  const projIds = await accessibleProjectIds(s.userId, s.role);
  const visible = kbs.filter(
    (k) =>
      k.scope === 'team' ||
      k.ownerId === s.userId ||
      s.role === 'admin' ||
      (k.projectId && projIds.has(k.projectId)),
  );

  const counts = (await db
    .select({ kbId: documents.kbId, docs: sql<number>`count(*)` })
    .from(documents)
    .groupBy(documents.kbId)) as any[];
  const chunkCounts = (await db
    .select({ kbId: chunks.kbId, cks: sql<number>`count(*)` })
    .from(chunks)
    .groupBy(chunks.kbId)) as any[];
  const docMap = new Map(counts.map((c) => [c.kbId, Number(c.docs || 0)]));
  const ckMap = new Map(chunkCounts.map((c) => [c.kbId, Number(c.cks || 0)]));

  return NextResponse.json(
    visible.map((k) => ({
      id: k.id,
      name: k.name,
      scope: k.scope,
      embeddingModel: normalizeEmbeddingRef(k.embeddingModel),
      ownerId: k.ownerId,
      projectId: k.projectId || null,
      createdAt: k.createdAt,
      docCount: docMap.get(k.id) || 0,
      chunkCount: ckMap.get(k.id) || 0,
      canManage: k.ownerId === s.userId || s.role === 'admin',
    })),
  );
});

// 创建知识库（json）或上传文档（multipart）
export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无权写入');

  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) apiError(400, 'INVALID_ARGUMENT', '请填写知识库名称');
    const scope = body?.scope === 'personal' ? 'personal' : 'team';
    let projectId: string | null = body?.projectId || null;
    if (projectId) {
      const ok = await canAccessProject(projectId, s.userId, s.role);
      if (!ok) apiError(403, 'FORBIDDEN', '无权归属该项目的知识库');
    }
    const ref = await validateEmbeddingRef(body?.embeddingModel);
    if (ref.error) apiError(400, 'INVALID_ARGUMENT', ref.error);
    const id = newId('kb');
    await db.insert(knowledgeBases).values({
      id,
      name,
      scope,
      ownerId: s.userId,
      projectId,
      embeddingModel: ref.value || AUTO_EMBEDDING,
      createdAt: Date.now(),
    });
    await logAction(s.userId, 'kb_create', name);
    return NextResponse.json({ id, name, scope, projectId, embeddingModel: ref.value || AUTO_EMBEDDING });
  }

  // —— 上传文档 ——
  // formData 解析可能因请求体超限/中断而抛错，兜底成 413 而非 500。
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    apiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大或格式不正确');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') apiError(400, 'INVALID_ARGUMENT', '未找到文件');

  const f = file as File;
  const name = f.name || 'untitled';
  const buf = Buffer.from(await f.arrayBuffer());
  let isText = TEXT_RE.test(name);
  if (!isText) {
    const sample = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8');
    const printable = (sample.match(/[\x09\x0a\x0d\x20-\x7e一-鿿　-〿＀-￯]/g) || []).length;
    isText = sample.length > 0 && printable / sample.length > 0.9;
  }

  let text = '';
  let extractError = '';
  if (isText) text = buf.toString('utf8');
  else {
    const res = await extractTextFromBuffer(name, buf);
    text = res?.text || '';
    extractError = res?.error || '';
  }
  const hasContent = text.trim().length > 0;

  // 目标知识库：指定 kbId 优先；否则取团队库；都没有则新建默认团队库
  let kbId = String(form.get('kbId') || '');
  if (kbId) {
    // 越权防护：此前只判「库存在」，任何登录用户都能把文件塞进别人的个人库。
    if (!(await canAccessKb(kbId, s.userId, s.role))) {
      apiError(403, 'FORBIDDEN', '知识库不存在或无权写入');
    }
  } else {
    const kbRows = await db.select().from(knowledgeBases).where(eq(knowledgeBases.scope, 'team')).limit(1);
    if (kbRows.length) kbId = kbRows[0].id;
    else {
      kbId = newId('kb');
      await db.insert(knowledgeBases).values({
        id: kbId,
        name: '团队知识库',
        scope: 'team',
        ownerId: null,
        embeddingModel: AUTO_EMBEDDING,
        createdAt: Date.now(),
      });
    }
  }

  const docId = newId('doc');
  if (!hasContent) {
    await db.insert(documents).values({ id: docId, kbId, filename: name, status: 'failed', chunkCount: 0, createdAt: Date.now() });
    await logAction(s.userId, 'kb_upload', name);
    return NextResponse.json({ ok: true, docId, filename: name, chunks: 0, warning: `未能从该文件解析出文本内容。${extractError ? `原因：${extractError}。` : ''}${UNSUPPORTED_HINT}` });
  }

  await db.insert(documents).values({ id: docId, kbId, filename: name, status: 'indexing', createdAt: Date.now() });
  // 入库前脱敏：凭证 / 身份证 / 手机号不写进向量库，否则检索命中会原样回显给其他成员
  const redacted = redactSensitive(text);
  const parts = splitText(redacted.text);
  for (let i = 0; i < parts.length; i++) {
    await db.insert(chunks).values({ id: newId('ck'), docId, kbId, content: parts[i], idx: i, embedding: null });
  }
  await db.update(documents).set({ status: 'indexing', chunkCount: parts.length }).where(eq(documents.id, docId));
  await logAction(s.userId, 'kb_upload', name);
  // 向量化：无 Redis 时走同步兜底，保证切片真的写入向量；
  // 最多等待 3s，超时则后台继续完成（避免大文档把上传请求拖死）
  await Promise.race([
    enqueueIndex(docId).catch(() => {}),
    new Promise((r) => setTimeout(r, 3000)),
  ]);

  const redactTip = redactSummary(redacted);
  return NextResponse.json({
    ok: true,
    docId,
    kbId,
    filename: name,
    chunks: parts.length,
    redacted: redacted.count,
    warning: `切片已入库，向量化在后台进行，稍候即可命中${redactTip ? `；${redactTip}` : ''}`,
  });
});

// 修改知识库：改名 / 切换 embedding 模型（切换模型会清空并后台重建该库向量）
export const PATCH = withApi(async ({ req, session }) => {
  const s = session;
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || '');
  if (!id) apiError(400, 'INVALID_ARGUMENT', '参数错误');
  const hasName = typeof body?.name === 'string';
  const hasModel = typeof body?.embeddingModel === 'string';
  if (!hasName && !hasModel) apiError(400, 'INVALID_ARGUMENT', '没有需要修改的字段');

  const kb = (await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).limit(1))[0];
  if (!kb) apiError(404, 'NOT_FOUND', '知识库不存在');
  if (kb.ownerId !== s.userId && s.role !== 'admin') apiError(403, 'FORBIDDEN', '无权修改');

  const patch: { name?: string; embeddingModel?: string } = {};
  if (hasName) {
    const name = String(body.name).trim();
    if (!name) apiError(400, 'INVALID_ARGUMENT', '名称不能为空');
    patch.name = name;
  }
  let modelChanged = false;
  if (hasModel) {
    const incoming = normalizeEmbeddingRef(body.embeddingModel);
    if (incoming !== normalizeEmbeddingRef(kb.embeddingModel)) {
      const ref = await validateEmbeddingRef(incoming);
      if (ref.error) apiError(400, 'INVALID_ARGUMENT', ref.error);
      patch.embeddingModel = ref.value || AUTO_EMBEDDING;
      modelChanged = true;
    }
  }
  if (!patch.name && !modelChanged) return NextResponse.json({ ok: true, embeddingModel: kb.embeddingModel });

  await db.update(knowledgeBases).set(patch).where(eq(knowledgeBases.id, id));
  await logAction(s.userId, modelChanged ? 'kb_set_embedding' : 'kb_rename', patch.name || patch.embeddingModel || id);

  if (modelChanged) {
    const docs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.kbId, id));
    rebuildKbVectors(id);
    return NextResponse.json({
      ok: true,
      embeddingModel: patch.embeddingModel,
      reindexing: docs.length,
      message: '向量模型已切换，正在后台清空并重建该库向量',
    });
  }
  return NextResponse.json({ ok: true, embeddingModel: kb.embeddingModel });
});

// 删除知识库及其文档/切片
export const DELETE = withApi(async ({ req, session }) => {
  const s = session;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');
  const kb = (await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).limit(1))[0];
  if (!kb) apiError(404, 'NOT_FOUND', '知识库不存在');
  if (kb.ownerId !== s.userId && s.role !== 'admin') apiError(403, 'FORBIDDEN', '无权删除');
  await db.delete(chunks).where(eq(chunks.kbId, id));
  await db.delete(documents).where(eq(documents.kbId, id));
  await db.delete(knowledgeBases).where(eq(knowledgeBases.id, id));
  await logAction(s.userId, 'kb_delete', id);
  return NextResponse.json({ ok: true });
});
