import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users as U, usage } from '@/lib/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 用量看板数据：近 6 个周期的消耗趋势 + 本月额度 + 环比。
 * 管理员看全团队（含成员明细），成员只看自己。
 */
export const GET = withApi(async ({ session }) => {
  const s = session;
  const isAdmin = s.role === 'admin';
  const periods = lastNPeriods(6);
  const cur = periods[periods.length - 1];

  const trendWhere = isAdmin
    ? inArray(usage.period, periods)
    : and(eq(usage.userId, s.userId), inArray(usage.period, periods));

  const [trendRows, meRows, memberRows] = await Promise.all([
    db
      .select({ period: usage.period, tokens: sql<number>`coalesce(sum(${usage.tokensUsed}), 0)` })
      .from(usage)
      .where(trendWhere)
      .groupBy(usage.period),
    db.select().from(U).where(eq(U.id, s.userId)).limit(1),
    // 成员明细只对管理员有意义；leftJoin + period 过滤，避免历史月份重复行
    isAdmin
      ? db
          .select({
            userId: U.id,
            name: U.name,
            email: U.email,
            monthlyLimit: U.monthlyLimit,
            tokensUsed: usage.tokensUsed,
          })
          .from(U)
          .leftJoin(usage, and(eq(usage.userId, U.id), eq(usage.period, cur)))
      : Promise.resolve([] as { userId: string; name: string | null; email: string; monthlyLimit: number | null; tokensUsed: number | null }[]),
  ]);

  const trendMap = new Map<string, number>(
    trendRows.map((r) => [r.period, Number(r.tokens) || 0] as const),
  );
  const trend: number[] = periods.map((p) => trendMap.get(p) || 0);

  const members = memberRows
    .map((r) => ({
      userId: r.userId,
      name: r.name || r.email,
      email: r.email,
      used: r.tokensUsed || 0,
      limit: r.monthlyLimit || 0,
    }))
    .sort((a, b) => b.used - a.used);

  const used = isAdmin ? members.reduce((sum, m) => sum + m.used, 0) : trendMap.get(cur) || 0;
  const limit = isAdmin ? members.reduce((sum, m) => sum + m.limit, 0) : meRows[0]?.monthlyLimit || 0;
  const prev = trend.length > 1 ? trend[trend.length - 2] : 0;
  // 环比：上月为 0 时无法计算百分比，返回 null 让前端显示「—」
  const mom = prev > 0 ? Math.round(((used - prev) / prev) * 100) : null;

  return NextResponse.json({
    scope: isAdmin ? 'team' : 'self',
    period: cur,
    periods,
    trend,
    used,
    limit,
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    mom,
    prev,
    members: isAdmin ? members : [],
  });
});

/** 近 n 个月周期字符串（yyyy-mm），升序，含当月 */
function lastNPeriods(n: number): string[] {
  const base = new Date();
  base.setDate(1);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
