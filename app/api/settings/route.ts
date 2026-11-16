import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users, usage as USG, files as F } from '@/lib/schema';
import { eq, and, sql } from 'drizzle-orm';
import { hashPassword, verifyPassword, signToken, setAuthCookie, invalidateUserState } from '@/lib/auth';
import { periodNow } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 读取当前用户自身资料 + 用量概览
export const GET = withApi(async ({ session }) => {
  const s = session;

  const u = (await db.select().from(users).where(eq(users.id, s.userId)).limit(1))[0];
  if (!u) apiError(404, 'NOT_FOUND', '用户不存在');

  const period = periodNow();
  const usedRow = (
    await db.select().from(USG).where(and(eq(USG.userId, u.id), eq(USG.period, period))).limit(1)
  )[0];
  const usedTokens = usedRow?.tokensUsed || 0;

  const storageRow = (
    await db.select({ sum: sql<number>`coalesce(sum(${F.size}),0)` }).from(F).where(eq(F.ownerId, u.id))
  )[0];
  const usedStorage = Number(storageRow?.sum || 0);

  return NextResponse.json({
    email: u.email,
    name: u.name,
    role: u.role,
    monthlyLimit: u.monthlyLimit,
    usedTokens,
    storageQuota: u.storageQuota,
    usedStorage,
    overQuotaAction: u.overQuotaAction,
    alertThreshold: u.alertThreshold,
  });
});

// 自我服务更新：昵称、月度额度、修改密码
export const PATCH = withApi(async ({ req, session }) => {
  const s = session;

  const u = (await db.select().from(users).where(eq(users.id, s.userId)).limit(1))[0];
  if (!u) apiError(404, 'NOT_FOUND', '用户不存在');

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};

  if (typeof body.name === 'string' && body.name.trim()) {
    patch.name = body.name.trim().slice(0, 50);
  }

  // 访客为只读角色：不允许自调额度与超限策略（昵称/密码仍可自改）
  if (s.role !== 'guest') {
    if (typeof body.monthlyLimit === 'number') {
      const v = Math.max(0, Math.min(100_000_000, Math.floor(body.monthlyLimit)));
      patch.monthlyLimit = v;
    }

    if (['block', 'downgrade', 'warn'].includes(body.overQuotaAction)) {
      patch.overQuotaAction = body.overQuotaAction;
    }
    if (typeof body.alertThreshold === 'number') {
      patch.alertThreshold = Math.max(0, Math.min(100, Math.floor(body.alertThreshold)));
    }
  }

  if (body.newPassword) {
    if (!body.currentPassword) apiError(400, 'INVALID_ARGUMENT', '请先输入当前密码');
    const ok = await verifyPassword(body.currentPassword, u.passwordHash);
    // 这里是「当前密码不对」，不是「无权操作」——用独立 code，
    // 前端才能区分「重新输一次」和「你没有这个权限」。
    if (!ok) apiError(403, 'WRONG_PASSWORD', '当前密码不正确');
    if (String(body.newPassword).length < 6) apiError(400, 'INVALID_ARGUMENT', '新密码至少 6 位');
    patch.passwordHash = await hashPassword(body.newPassword);
    // 改密后使其它端已签发的 token 全部失效（本端在下面重新签发，不会掉线）
    patch.tokenVersion = sql`${users.tokenVersion} + 1`;
  }

  if (Object.keys(patch).length === 0) apiError(400, 'INVALID_ARGUMENT', '没有可更新的字段');

  await db.update(users).set(patch).where(eq(users.id, u.id));

  if (body.newPassword) {
    // 清掉状态缓存并重签当前会话，让操作者本人保持登录、其它设备被踢下线
    invalidateUserState(u.id);
    const fresh = (
      await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, u.id)).limit(1)
    )[0];
    await setAuthCookie(
      signToken(
        { userId: s.userId, email: s.email, name: s.name, role: s.role },
        fresh?.tokenVersion ?? 0,
      ),
    );
  }

  return NextResponse.json({ ok: true });
});
