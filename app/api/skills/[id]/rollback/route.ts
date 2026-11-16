import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { skills, skillVersions } from '@/lib/schema';
import { eq, and } from 'drizzle-orm';
import { newId } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 技能版本回滚：把指定历史版本的 steps 写回技能，并自增版本号。
 * 回滚前先把「当前 steps」再快照一次，保证回滚动作本身也可被回滚。
 * 权限：仅技能 owner 可回滚。
 */
export const POST = withApi(async ({ req, session, params }) => {
  const { id } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客无写入权限');

  const body = await req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1) {
    apiError(400, 'INVALID_ARGUMENT', '缺少有效的 version');
  }

  const own = (await db.select().from(skills).where(eq(skills.id, id)).limit(1))[0];
  if (!own || own.ownerId !== s.userId) apiError(403, 'FORBIDDEN', '无权操作');

  const sv = (
    await db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, id), eq(skillVersions.version, version)))
      .limit(1)
  )[0];
  if (!sv) apiError(404, 'NOT_FOUND', '该版本不存在');

  // 回滚前快照当前版本，使「回滚」这一动作本身也可被撤销
  await db.insert(skillVersions).values({
    id: newId('sv'),
    skillId: id,
    version: own.version || 1,
    steps: own.steps || '[]',
    createdAt: Date.now(),
    createdBy: s.userId,
  });
  await db.update(skills).set({ steps: sv.steps, version: (own.version || 1) + 1 }).where(eq(skills.id, id));
  return NextResponse.json({ ok: true, version: (own.version || 1) + 1 });
});
