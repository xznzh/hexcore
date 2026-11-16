import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { hashPassword, invalidateUserState } from '@/lib/auth';
import { newId, logAction } from '@/lib/util';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['admin', 'member', 'guest']).default('member'),
  monthlyLimit: z.number().int().positive().default(1000000),
});

const patchSchema = z.object({
  id: z.string(),
  role: z.enum(['admin', 'member', 'guest']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  monthlyLimit: z.number().int().positive().optional(),
  password: z.string().min(6).optional(),
  overQuotaAction: z.enum(['block', 'downgrade', 'warn']).optional(),
  alertThreshold: z.number().int().min(0).max(100).optional(),
});

export const GET = withApi(
  async () => {
    const rows = await db.select().from(users);
    return NextResponse.json(
      rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        monthlyLimit: u.monthlyLimit,
        overQuotaAction: u.overQuotaAction,
        alertThreshold: u.alertThreshold,
      })),
    );
  },
  { auth: 'admin' },
);

export const POST = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });
    const { name, email, password, role, monthlyLimit } = parsed.data;
    const emailL = email.toLowerCase();

    const exists = await db.select().from(users).where(eq(users.email, emailL)).limit(1);
    if (exists.length) return NextResponse.json({ error: '邮箱已存在' }, { status: 409 });

    const id = newId('u');
    await db.insert(users).values({
      id,
      email: emailL,
      name,
      passwordHash: await hashPassword(password),
      role,
      status: 'active',
      monthlyLimit,
      createdAt: Date.now(),
    });
    await logAction(session.userId, 'admin_create_user', emailL);
    return NextResponse.json({ id, name, email: emailL, role });
  },
  { auth: 'admin' },
);

export const PATCH = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: '参数错误' }, { status: 400 });

    const { id, password, ...rest } = parsed.data;
    if (id === session.userId && rest.status === 'disabled') {
      return NextResponse.json({ error: '不能禁用自己' }, { status: 400 });
    }
    const patch: Record<string, unknown> = { ...rest };
    if (password) patch.passwordHash = await hashPassword(password);
    // 重置密码 / 禁用账号 → 会话版本 +1，使该用户已签发的 JWT 立即失效
    if (password || rest.status === 'disabled') {
      patch.tokenVersion = sql`${users.tokenVersion} + 1`;
    }
    await db.update(users).set(patch).where(eq(users.id, id));
    // 清缓存：角色变更/禁用要立刻生效，不能等 30s TTL 自然过期
    invalidateUserState(id);
    await logAction(session.userId, password ? 'admin_reset_password' : 'admin_update_user', id);
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);

export const DELETE = withApi(
  async ({ req, session }) => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
    if (id === session.userId) return NextResponse.json({ error: '不能删除自己' }, { status: 400 });

    await db.delete(users).where(eq(users.id, id));
    invalidateUserState(id);
    await logAction(session.userId, 'admin_delete_user', id);
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);
