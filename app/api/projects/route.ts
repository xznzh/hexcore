import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { projects, projectMembers } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  visibility: z.enum(['personal', 'members', 'team']).default('team'),
  memberIds: z.array(z.string()).default([]),
});

const patchSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  visibility: z.enum(['personal', 'members', 'team']).optional(),
});

export const GET = withApi(async ({ session }) => {
  const s = session;
  const rows = await db.select().from(projects).orderBy(projects.createdAt);
  // 我作为成员加入的项目
  const mine = await db.select().from(projectMembers).where(eq(projectMembers.userId, s.userId));
  const memberIds = new Set(mine.map((m) => m.projectId));

  // 可见性：我给 owner 的 / 团队库 / 我作为成员的「指定成员」项目
  const visible = rows.filter(
    (p) => p.ownerId === s.userId || p.visibility === 'team' || (p.visibility === 'members' && memberIds.has(p.id)),
  );
  return NextResponse.json(
    visible.map((p) => ({ ...p, isMember: p.ownerId === s.userId || memberIds.has(p.id) })),
  );
});

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  const p = parsed.data;
  const id = newId('proj');
  await db.insert(projects).values({
    id,
    name: p.name,
    description: p.description || null,
    ownerId: s.userId,
    visibility: p.visibility,
    createdAt: Date.now(),
  });
  // 添加成员：个人项目为私有，仅 owner（加成员对其无意义）
  const members = p.visibility === 'personal' ? [s.userId] : Array.from(new Set([s.userId, ...p.memberIds]));
  for (const uid of members) {
    await db.insert(projectMembers).values({ id: newId('pm'), projectId: id, userId: uid });
  }
  await logAction(s.userId, 'project_create', p.name);
  return NextResponse.json({ id, name: p.name });
});

export const PATCH = withApi(async ({ req, session }) => {
  const s = session;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  const { id, ...rest } = parsed.data;
  const own = (await db.select().from(projects).where(eq(projects.id, id)).limit(1))[0];
  if (!own || (own.ownerId !== s.userId && s.role !== 'admin')) return NextResponse.json({ error: '无权操作' }, { status: 403 });
  await db.update(projects).set({ ...rest }).where(eq(projects.id, id));
  return NextResponse.json({ ok: true });
});

export const DELETE = withApi(async ({ req, session }) => {
  const s = session;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  const own = (await db.select().from(projects).where(eq(projects.id, id)).limit(1))[0];
  if (!own || (own.ownerId !== s.userId && s.role !== 'admin')) return NextResponse.json({ error: '无权操作' }, { status: 403 });
  await db.delete(projectMembers).where(eq(projectMembers.projectId, id));
  await db.delete(projects).where(eq(projects.id, id));
  await logAction(s.userId, 'project_delete', id);
  return NextResponse.json({ ok: true });
});
