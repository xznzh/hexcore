import { NextResponse } from 'next/server';
import { getRegisterMode } from '@/lib/settings';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 公开：供注册页判断是否需要邀请码
export const GET = withApi(
  async () => NextResponse.json({ mode: await getRegisterMode() }),
  { auth: 'none' },
);
