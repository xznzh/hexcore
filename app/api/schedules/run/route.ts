import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { schedules } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { runSchedule, startScheduler } from '@/lib/scheduler';
import { logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const body = await req.json().catch(() => null);
  const id: string | undefined = body?.id;
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

  const row = (await db.select().from(schedules).where(eq(schedules.id, id)).limit(1))[0];
  if (!row) apiError(404, 'NOT_FOUND', '任务不存在');
  // 归属校验：手动触发会真实消耗 owner 的模型额度，并按任务配置向 owner 的 webhook 推送结果，
  // 若不校验归属，任意登录用户即可凭 id 触发他人的定时任务（越权 + 盗刷额度）。口径与 PATCH 一致。
  if (row.ownerId !== s.userId && s.role !== 'admin') apiError(403, 'FORBIDDEN', '无权操作');

  startScheduler();
  const result = await runSchedule(row);
  await logAction(s.userId, 'schedule_run', row.name);
  return NextResponse.json({ ok: true, result });
});
