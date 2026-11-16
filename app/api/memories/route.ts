import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { memories, users } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { embedText } from '@/lib/ai/embed';
import { accessibleProjectIds, canAccessProject } from '@/lib/projects';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  content: z.string().min(1),
  type: z.enum(['fact', 'episodic']).default('fact'),
  scope: z.enum(['personal', 'team']).default('personal'),
  projectId: z.string().nullable().optional(),
});

const patchSchema = z.object({
  id: z.string(),
  content: z.string().min(1).optional(),
  type: z.enum(['fact', 'episodic']).optional(),
  scope: z.enum(['personal', 'team']).optional(),
  projectId: z.string().nullable().optional(),
});

export const GET = withApi(async ({ session }) => {
  const s = session;
  const rows = await db.select().from(memories).orderBy(memories.createdAt);
  const projIds = await accessibleProjectIds(s.userId, s.role);
  const visible = rows.filter(
    (m) => m.scope === 'team' || m.userId === s.userId || (m.projectId && projIds.has(m.projectId)),
  );

  const userRows = await db.select().from(users);
  const nameMap = new Map(userRows.map((u) => [u.id, u.name]));
  return NextResponse.json(
    visible.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      scope: m.scope,
      projectId: m.projectId || null,
      userId: m.userId,
      ownerName: nameMap.get(m.userId) || '成员',
      canManage: m.userId === s.userId || (m.scope === 'team' && s.role === 'admin'),
      createdAt: m.createdAt,
    })),
  );
});

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  let embedding: string | null = null;
  try {
    embedding = JSON.stringify(await embedText(parsed.data.content));
  } catch {
    embedding = null;
  }
  let projectId = parsed.data.projectId || null;
  if (projectId) {
    const ok = await canAccessProject(projectId, s.userId, s.role);
    if (!ok) return NextResponse.json({ error: '无权归属该项目' }, { status: 403 });
  }
  const id = newId('mem');
  await db.insert(memories).values({
    id,
    userId: s.userId,
    scope: parsed.data.scope,
    projectId,
    type: parsed.data.type,
    content: parsed.data.content,
    embedding,
    createdAt: Date.now(),
  });
  await logAction(s.userId, 'memory_add', parsed.data.scope);
  return NextResponse.json({ id });
});

export const PATCH = withApi(async ({ req, session }) => {
  const s = session;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  const { id, ...rest } = parsed.data;
  const m = (await db.select().from(memories).where(eq(memories.id, id)).limit(1))[0];
  if (!m) return NextResponse.json({ error: '不存在' }, { status: 404 });
  const canManage = m.userId === s.userId || (m.scope === 'team' && s.role === 'admin');
  if (!canManage) return NextResponse.json({ error: '无权修改（团队记忆仅创建者或管理员可改）' }, { status: 403 });

  const patch: Record<string, unknown> = { ...rest };
  if ('projectId' in rest) {
    const pid = rest.projectId || null;
    if (pid) {
      const ok = await canAccessProject(pid, s.userId, s.role);
      if (!ok) return NextResponse.json({ error: '无权归属该项目' }, { status: 403 });
    }
    patch.projectId = pid;
  }
  if (rest.content) {
    try {
      patch.embedding = JSON.stringify(await embedText(rest.content));
    } catch {
      patch.embedding = null;
    }
  }
  await db.update(memories).set(patch).where(eq(memories.id, id));
  await logAction(s.userId, 'memory_update', id);
  return NextResponse.json({ ok: true });
});

export const DELETE = withApi(async ({ req, session }) => {
  const s = session;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  const m = (await db.select().from(memories).where(eq(memories.id, id)).limit(1))[0];
  if (!m) return NextResponse.json({ error: '不存在' }, { status: 404 });
  // 本人可删自己的记忆；管理员可删团队记忆
  const canManage = m.userId === s.userId || (m.scope === 'team' && s.role === 'admin');
  if (!canManage) {
    return NextResponse.json({ error: '无权删除（团队记忆仅创建者或管理员可删）' }, { status: 403 });
  }
  await db.delete(memories).where(eq(memories.id, id));
  await logAction(s.userId, 'memory_delete', id);
  return NextResponse.json({ ok: true });
});
