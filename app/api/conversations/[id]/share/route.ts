import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { conversations, sessionShares } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { randomBytes } from 'crypto';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 创建/更新会话分享（交付）链接
export const POST = withApi(async ({ req, session, params }) => {
  // 用 routeId 而非 id：本函数后面有 `const id = newId('shr')`（分享记录自身的主键），
  // 直接解构为 id 会被遮蔽，导致 conversationId 误指向分享记录自己。
  const { id: routeId } = (await params) as { id: string };
  const s = session;
  if (s.role === 'guest') return NextResponse.json({ error: '访客无写入权限' }, { status: 403 });

  const conv = (await db.select().from(conversations).where(eq(conversations.id, routeId)).limit(1))[0];
  if (!conv || conv.userId !== s.userId) return NextResponse.json({ error: '无权分享' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const visibility = body?.visibility === 'user' ? 'user' : 'link';
  const sharedWith = visibility === 'user' ? String(body?.sharedWith || '').trim().toLowerCase() : null;
  if (visibility === 'user' && !sharedWith) return NextResponse.json({ error: '请填写接收者邮箱' }, { status: 400 });
  const expiresInDays = Number(body?.expiresInDays) || 0;

  const token = randomBytes(16).toString('hex');
  const id = newId('shr');
  await db.insert(sessionShares).values({
    id,
    conversationId: routeId,
    ownerId: s.userId,
    token,
    visibility,
    sharedWith,
    title: conv.title,
    revoked: false,
    expiresAt: expiresInDays > 0 ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000 : null,
    createdAt: Date.now(),
  });
  await logAction(s.userId, 'session_share', conv.title);
  return NextResponse.json({ id, token, url: `/share/${token}` });
});
