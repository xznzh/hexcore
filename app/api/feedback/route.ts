import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 用户意见反馈：写入操作日志（管理员后台可查） */
export const POST = withApi(async ({ req, session }) => {
  const s = session;

  const body = await req.json().catch(() => null);
  const text: string = (body?.text || '').trim();
  if (!text) apiError(400, 'INVALID_ARGUMENT', '反馈内容为空');

  await logAction(s.userId, 'feedback', text.slice(0, 500));
  return NextResponse.json({ ok: true });
});
