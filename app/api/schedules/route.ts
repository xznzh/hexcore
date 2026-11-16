import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { schedules } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { startScheduler } from '@/lib/scheduler';
import { isValidCron } from '@/lib/cron';
import { accessibleProjectIds, canAccessProject } from '@/lib/projects';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// V8.2 起调度器随进程启动（instrumentation.ts），不再依赖「有人访问本页」。
// 这里保留一次调用：startScheduler 是幂等的，可兜住 instrumentation 未生效的部署形态
// （例如以纯函数方式调用路由、或某些 serverless 环境不跑 instrumentation）。
startScheduler();

const CRON_HINT = 'cron 表达式非法（支持标准 cron，如 "0 9 * * *"；或 "interval:N"，N 为正整数）';

export const GET = withApi(async ({ session }) => {
  const s = session;
  const rows = await db.select().from(schedules).orderBy(schedules.createdAt);
  const projIds = await accessibleProjectIds(s.userId, s.role);
  const visible = rows.filter(
    (r) => r.ownerId === s.userId || r.scope === 'team' || (r.projectId && projIds.has(r.projectId)),
  );
  return NextResponse.json(
    visible.map((r) => ({
      id: r.id,
      name: r.name,
      cron: r.cron,
      target: r.target,
      skillId: r.skillId,
      prompt: r.prompt,
      modelId: r.modelId,
      scope: r.scope,
      projectId: r.projectId || null,
      notify: r.notify,
      webhookUrl: r.webhookUrl,
      enabled: r.enabled,
      lastRunAt: r.lastRunAt,
      lastStatus: r.lastStatus,
    })),
  );
});

const createSchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(1), // "interval:30" 或 cron 表达式
  target: z.enum(['prompt', 'skill']).default('prompt'),
  skillId: z.string().optional(),
  prompt: z.string().optional(),
  modelId: z.string().optional(),
  scope: z.enum(['personal', 'team']).default('personal'),
  projectId: z.string().nullable().optional(),
  notify: z.enum(['none', 'webhook']).default('none'),
  webhookUrl: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');
  const p = parsed.data;

  // BUG-024：非法 cron 若放行入库，调度器注册时抛错会被静默吞掉——任务显示「启用」却永不执行。
  // 在能报错的这里直接拒绝。
  if (!isValidCron(p.cron)) apiError(400, 'INVALID_CRON', CRON_HINT);

  let projectId: string | null = p.projectId || null;
  if (projectId) {
    const ok = await canAccessProject(projectId, s.userId, s.role);
    if (!ok) apiError(403, 'FORBIDDEN', '无权归属该项目');
  }

  const id = newId('sch');
  await db.insert(schedules).values({
    id,
    ownerId: s.userId,
    scope: p.scope,
    projectId,
    name: p.name,
    cron: p.cron,
    target: p.target,
    skillId: p.skillId || null,
    prompt: p.prompt || null,
    modelId: p.modelId || null,
    notify: p.notify,
    webhookUrl: p.webhookUrl || null,
    enabled: p.enabled,
    createdAt: Date.now(),
  });
  startScheduler(); // 立即纳入调度
  await logAction(s.userId, 'schedule_create', p.name);
  return NextResponse.json({ id, name: p.name });
});

const patchSchema = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  cron: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

export const PATCH = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');
  const { id, ...rest } = parsed.data;

  const row = (await db.select().from(schedules).where(eq(schedules.id, id)).limit(1))[0];
  if (!row) apiError(404, 'NOT_FOUND', '任务不存在');
  if (row.ownerId !== s.userId && s.role !== 'admin') apiError(403, 'FORBIDDEN', '无权操作');

  const patch: any = { ...rest };
  // 同 POST：改 cron 也要校验，否则「创建合法、改坏」同样会进入静默失效状态（BUG-024）。
  if (rest.cron !== undefined && !isValidCron(rest.cron)) {
    apiError(400, 'INVALID_CRON', CRON_HINT);
  }
  if ('projectId' in rest) {
    const pid = rest.projectId || null;
    if (pid) {
      const ok = await canAccessProject(pid, s.userId, s.role);
      if (!ok) apiError(403, 'FORBIDDEN', '无权归属该项目');
    }
    patch.projectId = pid;
  }
  await db.update(schedules).set(patch).where(eq(schedules.id, id));
  await logAction(s.userId, 'schedule_update', id);
  return NextResponse.json({ ok: true });
});

export const DELETE = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const id = req.nextUrl.searchParams.get('id');
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

  // 归属校验：此前 DELETE 未做任何校验，任意登录用户可凭 id 删除他人的定时任务（越权删除）。口径与 PATCH 一致。
  const row = (await db.select().from(schedules).where(eq(schedules.id, id)).limit(1))[0];
  if (!row) apiError(404, 'NOT_FOUND', '任务不存在');
  if (row.ownerId !== s.userId && s.role !== 'admin') apiError(403, 'FORBIDDEN', '无权操作');

  await db.delete(schedules).where(eq(schedules.id, id));
  await logAction(s.userId, 'schedule_delete', id);
  return NextResponse.json({ ok: true });
});
