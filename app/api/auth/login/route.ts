import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { verifyPassword, signToken, setAuthCookie } from '@/lib/auth';
import { logAction } from '@/lib/util';
import { checkRateLimit } from '@/lib/redis';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** 登录失败统一文案：不区分「账号不存在」与「密码错误」，避免账号枚举 */
const LOGIN_FAILED = '邮箱或密码错误';

/** 账号不存在时用于消耗与真实校验相当的时间，消除响应时间侧信道 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

/**
 * 本接口是 auth: 'none'：调用方此刻必然没有有效会话，若走默认的 'user'
 * 会被包装器直接 401 掉，永远走不到校验密码这一步。
 *
 * 同时它故意不复用 UNAUTHORIZED 这个 code —— 这里的 401 含义是「凭据不对」，
 * 而 UNAUTHORIZED 的约定是「没登录」。若混用，前端拦截器会把一次输错密码
 * 当成会话过期，跳去登录页并清掉状态，用户看到的是「莫名其妙被踢出去」。
 */
export const POST = withApi(
  async ({ req }) => {
    // 登录爆破防护：此前登录接口没有任何限流，脚本可无限次尝试密码（OWASP A07）。
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
    const allowed = await checkRateLimit(`ratelimit:login:${ip}`, 10, 60);
    if (!allowed) apiError(429, 'RATE_LIMITED', '尝试过于频繁，请稍后再试');

    const body = await req.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');

    const { email, password } = parsed.data;
    const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    // 统一文案 + 等时校验：区分「账号不存在 / 密码错误」可枚举有效邮箱（OWASP A07），
    // 且账号不存在时若直接返回会少一次 bcrypt（约 60~80ms），响应时间同样可被用于枚举。
    if (!rows.length) {
      await verifyPassword(password, DUMMY_HASH);
      apiError(401, 'INVALID_CREDENTIALS', LOGIN_FAILED);
    }

    const u = rows[0];
    if (u.status === 'disabled') apiError(403, 'ACCOUNT_DISABLED', '账号已被禁用');
    const ok = await verifyPassword(password, u.passwordHash);
    if (!ok) apiError(401, 'INVALID_CREDENTIALS', LOGIN_FAILED);

    const token = signToken(
      { userId: u.id, email: u.email, name: u.name, role: u.role },
      u.tokenVersion ?? 0,
    );
    await setAuthCookie(token);
    await logAction(u.id, 'login', u.email);
    return NextResponse.json({ id: u.id, name: u.name, email: u.email, role: u.role });
  },
  { auth: 'none' },
);
