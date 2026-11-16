import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { projects, projectMembers, files, users, conversations, artifacts } from '@/lib/schema';
import { eq, desc, and } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 项目详情 + 成员 + 关联文件 + 关联会话（聚合视图）
export const GET = withApi(async ({ session, params }) => {
  const s = session;
  const { id } = (await params) as { id: string };

  const proj = (await db.select().from(projects).where(eq(projects.id, id)).limit(1))[0];
  if (!proj) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  // 访问校验：owner / 团队成员（team）/ 该项目成员（members）/ 管理员
  const isOwner = proj.ownerId === s.userId;
  const isMemberRow = (
    await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, proj.id), eq(projectMembers.userId, s.userId)))
      .limit(1)
  )[0];
  const allowed = isOwner || proj.visibility === 'team' || (proj.visibility === 'members' && !!isMemberRow) || s.role === 'admin';
  if (!allowed) return NextResponse.json({ error: '无权访问该项目' }, { status: 403 });

  const members = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(projectMembers)
    .leftJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, id));

  const filesIn = await db.select().from(files).where(eq(files.projectId, id));

  const convs = await db
    .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.projectId, id))
    .orderBy(desc(conversations.createdAt));

  const arts = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.projectId, id))
    .orderBy(desc(artifacts.createdAt));

  return NextResponse.json({
    ...proj,
    members,
    files: filesIn.map((f) => ({ id: f.id, filename: f.filename, size: f.size })),
    conversations: convs,
    artifacts: arts.map((a) => ({ id: a.id, type: a.type, title: a.title, filename: a.filename, createdAt: a.createdAt })),
  });
});
