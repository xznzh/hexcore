import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users, invites } from '@/lib/schema';
import { and, eq, sql } from 'drizzle-orm';
import { hashPassword, signToken, setAuthCookie } from '@/lib/auth';
import { getRegisterMode } from '@/lib/settings';
import { newId, logAction } from '@/lib/util';
import { withApi, apiError, ApiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  inviteCode: z.string().optional(),
});

/**
 * 注册流程中的可预期拒绝，与真正的异常区分开。
 * code 必须显式给出：注册有四种 403/409 场景（关闭注册、缺邀请码、
 * 邀请码失效、邮箱已占用），前端文案与引导动作各不相同，
 * 只靠 HTTP 状态码区分不了。
 */
class RegisterError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

export const POST = withApi(
  async ({ req }) => {
    const body = await req.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');

    const { name, email, password, inviteCode } = parsed.data;
    const emailL = email.toLowerCase();

    // 注册模式在事务外读取：只影响本请求的分支选择，不参与一致性判断
    const mode = await getRegisterMode();
    // bcrypt 较慢（~60ms），放在事务外，避免长时间持锁
    const passwordHash = await hashPassword(password);
    const id = newId('u');

    let role = 'member';
    try {
      role = await db.transaction(async (tx: any) => {
        // 串行化并发注册（事务结束自动释放）。不加锁时存在两个竞态：
        //   1) 两个并发请求都读到 users 为 0，都被判为首用户并设为 admin（BUG-008）；
        //   2) 同一邀请码被两次判定为 used=false 而重复使用（BUG-009）。
        await tx.execute(sql`select pg_advisory_xact_lock(74001)`);

        const cntRows = await tx.execute(sql`select count(*)::int as c from users`);
        const cnt = Number(cntRows?.[0]?.c ?? 0);
        const first = cnt === 0;
        let finalRole = first ? 'admin' : 'member';

        if (!first) {
          if (mode === 'admin_only') {
            throw new RegisterError('当前仅允许管理员添加账号，请联系管理员', 403, 'REGISTRATION_CLOSED');
          }
          if (mode === 'invite') {
            const code = (inviteCode || '').trim();
            if (!code) throw new RegisterError('需要邀请码', 400, 'INVITE_REQUIRED');
            const inv = (await tx.select().from(invites).where(eq(invites.code, code)).limit(1))[0];
            if (!inv || inv.used) {
              throw new RegisterError('邀请码无效或已使用', 403, 'INVITE_INVALID');
            }
            finalRole = inv.role;
            // 条件更新占位：只有 used=false 才能抢到；建号失败则随事务一起回滚，邀请码不被白白消耗
            const claimed = await tx
              .update(invites)
              .set({ used: true, usedBy: id })
              .where(and(eq(invites.id, inv.id), eq(invites.used, false)))
              .returning({ id: invites.id });
            if (!claimed.length) throw new RegisterError('邀请码无效或已使用', 403, 'INVITE_INVALID');
          }
        }

        const taken = await tx.select({ id: users.id }).from(users).where(eq(users.email, emailL)).limit(1);
        if (taken.length) throw new RegisterError('邮箱已注册', 409, 'EMAIL_TAKEN');

        await tx.insert(users).values({
          id,
          email: emailL,
          name,
          passwordHash,
          role: finalRole,
          status: 'active',
          monthlyLimit: 1000000,
          storageQuota: 1073741824,
          createdAt: Date.now(),
        });

        return finalRole;
      });
    } catch (e) {
      // ApiError 来自上面的 schema 校验失败等场景，已带完整语义，原样上抛
      if (e instanceof ApiError) throw e;
      if (e instanceof RegisterError) apiError(e.status, e.code, e.message);
      // 唯一约束兜底：极端并发下仍可能两个事务同时通过上面的存在性检查，由 DB 唯一索引裁决
      if (/duplicate key|unique constraint/i.test(String((e as any)?.message || ''))) {
        apiError(409, 'EMAIL_TAKEN', '邮箱已注册');
      }
      throw e;
    }

    await logAction(id, 'register', emailL);

    const token = signToken({ userId: id, email: emailL, name, role });
    await setAuthCookie(token);
    return NextResponse.json({ id, email: emailL, name, role });
  },
  { auth: 'none' },
);
