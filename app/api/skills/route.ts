import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { skills, skillVersions } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { accessibleProjectIds, canAccessProject } from '@/lib/projects';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApi(async ({ session }) => {
  const s = session;
  const rows = await db.select().from(skills).orderBy(skills.createdAt);
  const projIds = await accessibleProjectIds(s.userId, s.role);
  const visible = rows.filter(
    (r) => r.ownerId === s.userId || r.scope === 'team' || r.scope === 'builtin' || (r.projectId && projIds.has(r.projectId)),
  );
  return NextResponse.json(
    visible.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      steps: JSON.parse(r.steps || '[]'),
      scope: r.scope,
      builtin: r.scope === 'builtin',
      editable: r.ownerId === s.userId,
      projectId: r.projectId || null,
      modelId: r.modelId,
      version: r.version,
      createdAt: r.createdAt,
    })),
  );
});

const stepSchema = z.object({
  role: z.enum(['supervisor', 'planner', 'worker', 'critic']),
  type: z.enum(['llm', 'tool', 'condition', 'loop', 'human']).optional(),
  prompt: z.string().default(''),
  tool: z.string().optional(),
  contains: z.string().optional(),
  times: z.number().int().optional(),
  requireConfirm: z.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(stepSchema).default([]),
  scope: z.enum(['personal', 'team']).default('personal'),
  projectId: z.string().nullable().optional(),
  modelId: z.string().optional(),
});

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');
  const p = parsed.data;

  let projectId: string | null = p.projectId || null;
  if (projectId) {
    const ok = await canAccessProject(projectId, s.userId, s.role);
    if (!ok) apiError(403, 'FORBIDDEN', '无权归属该项目');
  }

  const id = newId('skill');
  await db.insert(skills).values({
    id,
    ownerId: s.userId,
    scope: p.scope,
    projectId,
    name: p.name,
    description: p.description || null,
    steps: JSON.stringify(p.steps),
    modelId: p.modelId || null,
    createdAt: Date.now(),
  });
  await logAction(s.userId, 'skill_create', p.name);
  return NextResponse.json({ id, name: p.name });
});

const patchSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(stepSchema).optional(),
  projectId: z.string().nullable().optional(),
  modelId: z.string().optional(),
});

export const PATCH = withApi(async ({ req, session }) => {
  const s = session;
  // 与 POST / DELETE / rollback 保持一致：访客只读。
  // 原先只有 POST 挡了访客，PATCH/DELETE 没挡 —— 同一文件内三种写法并存，
  // 靠调用方「记得加」是守不住的。
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');
  const { id, ...rest } = parsed.data;

  const own = (await db.select().from(skills).where(eq(skills.id, id)).limit(1))[0];
  if (!own || own.ownerId !== s.userId) apiError(403, 'FORBIDDEN', '无权操作');

  const patch: any = { ...rest };
  if ('projectId' in rest) {
    const pid = rest.projectId || null;
    if (pid) {
      const ok = await canAccessProject(pid, s.userId, s.role);
      if (!ok) apiError(403, 'FORBIDDEN', '无权归属该项目');
    }
    patch.projectId = pid;
  }
  if (rest.steps) {
    // 更新步骤前先把当前版本快照落库，便于一键回滚（version 自增，旧版本号保留在 skill_versions）
    patch.steps = JSON.stringify(rest.steps);
    patch.version = (own.version || 1) + 1;
    await db.insert(skillVersions).values({
      id: newId('sv'),
      skillId: id,
      version: own.version || 1,
      steps: own.steps || '[]',
      createdAt: Date.now(),
      createdBy: s.userId,
    });
  }
  await db.update(skills).set(patch).where(eq(skills.id, id));
  return NextResponse.json({ ok: true });
});

export const DELETE = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const id = req.nextUrl.searchParams.get('id');
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

  const own = (await db.select().from(skills).where(eq(skills.id, id)).limit(1))[0];
  if (!own || own.ownerId !== s.userId) apiError(403, 'FORBIDDEN', '无权操作');

  await db.delete(skills).where(eq(skills.id, id));
  await logAction(s.userId, 'skill_delete', id);
  return NextResponse.json({ ok: true });
});
