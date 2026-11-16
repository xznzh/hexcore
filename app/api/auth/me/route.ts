import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 这里直接用默认的 auth: 'user'，不自判会话：本接口的 401 语义恰好就是
 * 「未登录」，与包装器的契约完全一致，无需特殊处理。
 */
export const GET = withApi(async ({ session }) =>
  NextResponse.json({
    userId: session.userId,
    email: session.email,
    name: session.name,
    role: session.role,
  }),
);
