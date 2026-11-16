import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { feedback } from '@/lib/schema';
import { and, eq } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 用户对某条 AI 回答的反馈（点赞/点踩 + 可选评论）
export const POST = withApi(async ({ req, session }) => {
  const s = session;

  const body = await req.json().catch(() => null);
  const messageId: string | undefined = body?.messageId;
  const rating: string | undefined = body?.rating; // 'up' | 'down'
  if (!messageId || (rating !== 'up' && rating !== 'down')) {
    apiError(400, 'INVALID_ARGUMENT', '参数错误');
  }

  // 同一用户对同一消息仅保留最新一条反馈（按 消息+用户 去重）。
  // 此前只按 messageId 删除：共享会话里 A 的反馈会被 B 的点踩直接覆盖（跨用户数据互删）。
  await db
    .delete(feedback)
    .where(and(eq(feedback.messageId, messageId), eq(feedback.userId, s.userId)))
    .catch(() => {});
  await db.insert(feedback).values({
    id: newId('fb'),
    messageId,
    userId: s.userId,
    rating,
    comment: body?.comment ? String(body.comment).slice(0, 500) : null,
    createdAt: Date.now(),
  });
  await logAction(s.userId, 'feedback', `${rating}:${messageId}`);
  return NextResponse.json({ ok: true });
});
