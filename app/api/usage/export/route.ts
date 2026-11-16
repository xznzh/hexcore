import { NextResponse } from 'next/server';
import { ensureInit, db } from '@/lib/db';
import { users, usage } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { periodNow } from '@/lib/util';
import { failResponse } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 用量明细导出（CSV）。管理员导出全员，成员导出自己。
export async function GET() {
  await ensureInit();
  const s = await getSession();
  if (!s) return failResponse(undefined, 401, 'UNAUTHORIZED', '未登录');

  const period = periodNow();
  let rows: { email: string; name: string; period: string; tokensUsed: number; monthlyLimit: number }[] = [];

  if (s.role === 'admin') {
    const r = await db
      .select({
        email: users.email,
        name: users.name,
        monthlyLimit: users.monthlyLimit,
        period: usage.period,
        tokensUsed: usage.tokensUsed,
      })
      .from(users)
      .leftJoin(usage, eq(usage.userId, users.id));
    rows = r.map((x) => ({
      email: x.email,
      name: x.name,
      period: x.period || period,
      tokensUsed: x.tokensUsed || 0,
      monthlyLimit: x.monthlyLimit,
    }));
  } else {
    const me = (await db.select().from(users).where(eq(users.id, s.userId)).limit(1))[0];
    const u = (await db.select().from(usage).where(eq(usage.userId, s.userId)).limit(1))[0];
    rows = [
      {
        email: me?.email || '',
        name: me?.name || '',
        period: u?.period || period,
        tokensUsed: u?.tokensUsed || 0,
        monthlyLimit: me?.monthlyLimit || 0,
      },
    ];
  }

  const header = '邮箱,昵称,周期,已用Token,额度,使用率';
  const lines = rows.map((r) => {
    const pct = r.monthlyLimit ? Math.round((r.tokensUsed / r.monthlyLimit) * 100) + '%' : '—';
    return [r.email, r.name, r.period, r.tokensUsed, r.monthlyLimit, pct].join(',');
  });
  const csv = '\uFEFF' + [header, ...lines].join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="usage-${period}.csv"`,
    },
  });
}
