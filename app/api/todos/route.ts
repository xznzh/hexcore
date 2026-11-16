import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { todos } from '@/lib/schema';
import { and, desc, eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 待办清单：GET ?status=open|done|all&projectId=
export const GET = withApi(async ({ req, session }) => {
  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || 'open';
  const projectId = sp.get('projectId');
  const conds = [eq(todos.userId, session.userId)];
  if (status === 'open') conds.push(eq(todos.status, 'open'));
  else if (status === 'done') conds.push(eq(todos.status, 'done'));
  if (projectId) conds.push(eq(todos.projectId, projectId));
  const rows = await db
    .select()
    .from(todos)
    .where(and(...conds))
    .orderBy(desc(todos.createdAt))
    .limit(50);
  return NextResponse.json(
    rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      detail: r.detail,
      status: r.status,
      source: r.source,
      sourceRef: r.sourceRef ? JSON.parse(r.sourceRef) : null,
      projectId: r.projectId,
      dueDate: r.dueDate,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    })),
  );
});

// 新建待办：{ title, detail?, projectId?, source?, sourceRef?, dueDate? }
export const POST = withApi(async ({ req, session }) => {
  if (session.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读模式');
  const body = await req.json().catch(() => null);
  const title = String(body?.title || '').trim().slice(0, 120);
  if (!title) apiError(400, 'BAD_REQUEST', '待办标题不能为空');
  const id = newId('todo');
  await db.insert(todos).values({
    id,
    userId: session.userId,
    scope: 'personal',
    projectId: body?.projectId || null,
    title,
    detail: body?.detail ? String(body.detail).slice(0, 2000) : null,
    source: ['manual', 'chat', 'skill', 'schedule'].includes(body?.source) ? body.source : 'manual',
    sourceRef: body?.sourceRef ? JSON.stringify(body.sourceRef) : null,
    dueDate: body?.dueDate ? Number(body.dueDate) : null,
    createdAt: Date.now(),
  });
  await logAction(session.userId, 'todo_create', title.slice(0, 60));
  return NextResponse.json({ id, title });
});

// 更新待办：{ id, status? | title? | detail? }
export const PATCH = withApi(async ({ req, session }) => {
  const body = await req.json().catch(() => null);
  const id = body?.id ? String(body.id) : '';
  if (!id) apiError(400, 'BAD_REQUEST', '缺少 id');
  const row = (
    await db
      .select()
      .from(todos)
      .where(and(eq(todos.id, id), eq(todos.userId, session.userId)))
      .limit(1)
  )[0];
  if (!row) apiError(404, 'NOT_FOUND', '待办不存在');
  const patch: Record<string, any> = {};
  if (body.status && ['open', 'done', 'dismissed'].includes(body.status)) {
    patch.status = body.status;
    patch.completedAt = body.status === 'done' ? Date.now() : null;
  }
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 120);
  if (typeof body.detail === 'string') patch.detail = body.detail.slice(0, 2000);
  if (Object.keys(patch).length) await db.update(todos).set(patch).where(eq(todos.id, id));
  return NextResponse.json({ ok: true });
});

// 删除待办：?id=
export const DELETE = withApi(async ({ req, session }) => {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) apiError(400, 'BAD_REQUEST', '缺少 id');
  await db.delete(todos).where(and(eq(todos.id, id), eq(todos.userId, session.userId)));
  return NextResponse.json({ ok: true });
});
