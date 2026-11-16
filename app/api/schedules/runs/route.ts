import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { scheduleRuns, schedules } from '@/lib/schema';
import { eq, desc } from 'drizzle-orm';
import { accessibleProjectIds } from '@/lib/projects';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 定时任务执行历史
export const GET = withApi(async ({ req, session }) => {
  const s = session;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

  // 归属/可见性校验：执行历史里含任务产出的完整正文（可能包含业务数据），
  // 此前只要登录就能凭任意 id 读取他人任务的全部运行结果。可见性口径与 GET /api/schedules 一致。
  const sch = (await db.select().from(schedules).where(eq(schedules.id, id)).limit(1))[0];
  if (!sch) apiError(404, 'NOT_FOUND', '任务不存在');
  let visible = sch.ownerId === s.userId || s.role === 'admin' || sch.scope === 'team';
  if (!visible && sch.projectId) {
    visible = (await accessibleProjectIds(s.userId, s.role)).has(sch.projectId);
  }
  if (!visible) apiError(403, 'FORBIDDEN', '无权访问');

  const rows = await db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, id))
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(30);

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      result: r.result,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    })),
  );
});
