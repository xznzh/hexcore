import { NextResponse } from 'next/server';
import { clearAuthCookie } from '@/lib/auth';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * auth: 'none' 是刻意的：退出登录必须幂等。若要求已登录，用户 token
 * 已经过期时点「退出」会拿到 401，前端拦截器跳转逻辑与真正退出混在一起，
 * 容易出现「退不出去」的死循环。没有会话也要能清掉一个可能已失效的 cookie。
 */
export const POST = withApi(
  async () => {
    await clearAuthCookie();
    return NextResponse.json({ ok: true });
  },
  { auth: 'none' },
);
