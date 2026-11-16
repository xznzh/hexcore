import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { notifications } from '@/lib/schema';
import { and, eq, isNull, or, desc } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApi(async ({ session }) => {
  const rows = await db
    .select()
    .from(notifications)
    .where(or(eq(notifications.userId, session.userId), isNull(notifications.userId)))
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  return NextResponse.json({
    unread: rows.filter((r: any) => !r.read).length,
    items: rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      read: r.read,
      createdAt: r.createdAt,
    })),
  });
});

// 标记已读：{ id } 单条；无 id 则全部已读
export const PATCH = withApi(async ({ req, session }) => {
  const body = await req.json().catch(() => ({}));
  if (body?.id) {
    await db.update(notifications).set({ read: true }).where(eq(notifications.id, String(body.id)));
  } else {
    await db
      .update(notifications)
      .set({ read: true })
      .where(or(eq(notifications.userId, session.userId), isNull(notifications.userId)));
  }
  return NextResponse.json({ ok: true });
});

export const DELETE = withApi(async ({ req, session }) => {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    await db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, session.userId)));
  }
  return NextResponse.json({ ok: true });
});
