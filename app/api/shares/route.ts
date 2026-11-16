import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sessionShares } from '@/lib/schema';
import { eq, desc } from 'drizzle-orm';
import { logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 我发起的分享列表
export const GET = withApi(async ({ session }) => {
  const s = session;
  const rows = await db
    .select()
    .from(sessionShares)
    .where(eq(sessionShares.ownerId, s.userId))
    .orderBy(desc(sessionShares.createdAt));
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      title: r.title,
      token: r.token,
      url: `/share/${r.token}`,
      visibility: r.visibility,
      sharedWith: r.sharedWith,
      revoked: r.revoked,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    })),
  );
});

// 撤销分享
export const DELETE = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法撤销分享');
  const id = req.nextUrl.searchParams.get('id');
  if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

  const row = (await db.select().from(sessionShares).where(eq(sessionShares.id, id)).limit(1))[0];
  if (!row || row.ownerId !== s.userId) apiError(403, 'FORBIDDEN', '无权操作');

  await db.update(sessionShares).set({ revoked: true }).where(eq(sessionShares.id, id));
  await logAction(s.userId, 'session_unshare', id);
  return NextResponse.json({ ok: true });
});
