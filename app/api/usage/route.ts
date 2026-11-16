import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users, usage } from '@/lib/schema';
import { and, eq } from 'drizzle-orm';
import { periodNow } from '@/lib/util';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApi(async ({ session }) => {
  const s = session;

  // 管理员看全部，成员只看自己
  const period = periodNow();
  if (s.role === 'admin') {
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        monthlyLimit: users.monthlyLimit,
        tokensUsed: usage.tokensUsed,
        period: usage.period,
      })
      .from(users)
      // 必须带上 period：usage 表按 (user_id, period) 一户一月一行，
      // 只按 user_id 关联会让有几个月历史用量的用户返回多行（表格里同一个人重复出现）。
      .leftJoin(usage, and(eq(usage.userId, users.id), eq(usage.period, period)));
    const result = rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      monthlyLimit: r.monthlyLimit,
      tokensUsed: r.userId && r.tokensUsed ? r.tokensUsed : 0,
      period: r.period || period,
    }));
    return NextResponse.json(result);
  }

  // 成员视图：同样要带 period 过滤，并并行取用户信息。
  // 原实现是「按 userId 查 usage 后 limit(1)」，没有 period 也没有排序，
  // 有历史月份时可能把上月用量当成当月用量返回。
  const [mine, me] = await Promise.all([
    db
      .select()
      .from(usage)
      .where(and(eq(usage.userId, s.userId), eq(usage.period, period)))
      .limit(1),
    db.select().from(users).where(eq(users.id, s.userId)).limit(1),
  ]);
  return NextResponse.json([
    {
      userId: s.userId,
      email: me[0]?.email,
      name: me[0]?.name,
      monthlyLimit: me[0]?.monthlyLimit || 0,
      tokensUsed: mine[0]?.tokensUsed || 0,
      period,
    },
  ]);
});
