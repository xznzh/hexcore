import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { projects, projectMembers } from '@/lib/schema';
import { and, eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

async function canManage(projectId: string, userId: string, role: string) {
  const p = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  return !!p && (p.ownerId === userId || role === 'admin');
}

// 添加成员
export const POST = withApi(async ({ req, session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  if (!(await canManage(id, s.userId, s.role))) return NextResponse.json({ error: '无权操作' }, { status: 403 });

  const proj = (await db.select().from(projects).where(eq(projects.id, id)).limit(1))[0];
  if (proj?.visibility === 'personal') {
    return NextResponse.json({ error: '个人项目为私有，不能添加成员。请改用「指定成员」或「团队」可见性。' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const userId = String(body?.userId || '');
  if (!userId) return NextResponse.json({ error: '缺少用户' }, { status: 400 });

  const exists = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!exists.length) {
    await db.insert(projectMembers).values({ id: newId('pm'), projectId: id, userId });
  }
  await logAction(s.userId, 'project_add_member', `${id}:${userId}`);
  return NextResponse.json({ ok: true });
});

// 移除成员
export const DELETE = withApi(async ({ req, session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  if (!(await canManage(id, s.userId, s.role))) return NextResponse.json({ error: '无权操作' }, { status: 403 });

  const userId = req.nextUrl.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: '缺少用户' }, { status: 400 });
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));
  await logAction(s.userId, 'project_remove_member', `${id}:${userId}`);
  return NextResponse.json({ ok: true });
});
