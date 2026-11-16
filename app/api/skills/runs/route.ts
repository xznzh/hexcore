import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skillRuns } from '@/lib/schema';
import { eq, and, desc } from 'drizzle-orm';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 某技能的执行历史（仅本人：skillRuns 记录里含完整输入输出）
export const GET = withApi(async ({ req, session }) => {
  const s = session;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

  const rows = await db
    .select()
    .from(skillRuns)
    .where(and(eq(skillRuns.skillId, id), eq(skillRuns.ownerId, s.userId)))
    .orderBy(desc(skillRuns.createdAt))
    .limit(20);

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      input: r.input,
      result: r.result,
      status: r.status,
      trajectory: JSON.parse(r.trajectory || '[]'),
      createdAt: r.createdAt,
    })),
  );
});
