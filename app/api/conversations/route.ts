import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { conversations, messages, users, projects, projectMembers } from '@/lib/schema';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApi(async ({ session }) => {
  const s = session;
  // 三条查询互不依赖，并行发出。
  // 这段在对话页**挂载时**就跑（首屏六请求之一），串行三次往返直接体现在「打开就转圈」上。
  // 我自己的会话 / 我可访问的项目 / 我的项目成员关系
  const [mine, allProjects, memberships] = await Promise.all([
    db
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, s.userId), eq(conversations.archived, false))),
    db.select().from(projects),
    db.select().from(projectMembers).where(eq(projectMembers.userId, s.userId)),
  ]);
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));
  const accessIds = new Set<string>(
    allProjects
      .filter((p) => p.ownerId === s.userId || p.visibility === 'team' || (p.visibility === 'members' && memberProjectIds.has(p.id)))
      .map((p) => p.id),
  );

  // 项目内其他人的会话（对成员只读可见）：过滤条件下推到 SQL（配合 idx_conversations_project 索引），
  // 替代原「全表拉回内存过滤」，随会话数据增长不再劣化
  const accessIdList = Array.from(accessIds);
  const others = accessIdList.length
    ? await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.archived, false),
            ne(conversations.userId, s.userId),
            inArray(conversations.projectId, accessIdList),
          ),
        )
        .limit(300)
    : [];

  const allUsers = others.length ? await db.select().from(users) : [];
  const nameMap = new Map(allUsers.map((u) => [u.id, u.name]));

  const rows = [
    ...mine.map((c) => ({ ...c, isOwner: true, ownerName: null as string | null })),
    ...others.map((c) => ({ ...c, isOwner: false, ownerName: nameMap.get(c.userId) || '成员' })),
  ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);

  return NextResponse.json(
    rows.map((c) => ({
      id: c.id,
      title: c.title,
      pinned: c.pinned,
      createdAt: c.createdAt,
      projectId: c.projectId || null,
      isOwner: c.isOwner,
      ownerName: c.ownerName,
    })),
  );
});

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  const body = await req.json().catch(() => ({}));
  const id = newId('conv');
  await db.insert(conversations).values({
    id,
    userId: s.userId,
    title: body?.title || '新对话',
    pinned: false,
    archived: false,
    projectId: body?.projectId || null,
    createdAt: Date.now(),
  });
  return NextResponse.json({ id, title: '新对话', projectId: body?.projectId || null });
});

export const PATCH = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id: string | undefined = body?.id;
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  const own = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!own.length || own[0].userId !== s.userId) {
    return NextResponse.json({ error: '无权操作' }, { status: 403 });
  }
  const patch: any = {};
  if (typeof body.title === 'string') patch.title = body.title.slice(0, 100);
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
  if (typeof body.archived === 'boolean') patch.archived = body.archived;
  if ('projectId' in body) patch.projectId = body.projectId || null;
  await db.update(conversations).set(patch).where(eq(conversations.id, id));
  return NextResponse.json({ ok: true });
});

export const DELETE = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  const own = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!own.length || own[0].userId !== s.userId) {
    return NextResponse.json({ error: '无权操作' }, { status: 403 });
  }
  await db.delete(messages).where(eq(messages.conversationId, id));
  await db.delete(conversations).where(eq(conversations.id, id));
  await logAction(s.userId, 'delete_conversation', id);
  return NextResponse.json({ ok: true });
});
