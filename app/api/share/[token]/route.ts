import { NextRequest, NextResponse } from 'next/server';
import { ensureInit, db } from '@/lib/db';
import { sessionShares, conversations, messages, users } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// 公开读取分享的会话（只读）。链接分享无需登录；指定用户分享需登录且邮箱匹配。
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await ensureInit();
  const share = (await db.select().from(sessionShares).where(eq(sessionShares.token, token)).limit(1))[0];
  if (!share || share.revoked) return NextResponse.json({ error: '分享链接无效或已撤销' }, { status: 404 });
  if (share.expiresAt && share.expiresAt < Date.now()) {
    return NextResponse.json({ error: '分享链接已过期' }, { status: 410 });
  }

  const s = await getSession();
  if (share.visibility === 'user') {
    if (!s) return NextResponse.json({ error: '该分享仅限指定用户访问，请先登录' }, { status: 401 });
    if (s.email.toLowerCase() !== (share.sharedWith || '').toLowerCase()) {
      return NextResponse.json({ error: '你无权查看该分享' }, { status: 403 });
    }
  }

  const conv = (await db.select().from(conversations).where(eq(conversations.id, share.conversationId)).limit(1))[0];
  if (!conv) return NextResponse.json({ error: '会话不存在' }, { status: 404 });
  const owner = (await db.select().from(users).where(eq(users.id, share.ownerId)).limit(1))[0];

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, share.conversationId))
    .orderBy(messages.createdAt);

  return NextResponse.json({
    title: conv.title,
    ownerName: owner?.name || '成员',
    visibility: share.visibility,
    createdAt: share.createdAt,
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sources: m.sources ? JSON.parse(m.sources) : [],
      trace: m.trace ? JSON.parse(m.trace) : [],
      createdAt: m.createdAt,
    })),
  });
}
