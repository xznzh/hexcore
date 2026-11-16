import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rowsOf } from '@/lib/sql';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const DAY_MS = 86400000;
// 指标按固定 +08 时区切天，避免服务器时区不同导致日期错位
const TZ_OFFSET_MS = 8 * 3600 * 1000;

/** drizzle 在 postgres-js / node-postgres 下返回结构不同，统一取行数组（实现见 lib/sql.ts） */

/**
 * 能力调用指标：最近 N 天调用量、成功率、平均耗时、Top 能力、待审批数、每日趋势。
 * 聚合下推到 SQL（GROUP BY），不再把明细拉回 Node 再算；非管理员只看自己的记录。
 */
export const GET = withApi(async ({ req, session }) => {
  const s = session;
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get('days') || 30)));
  // 以「今天」为终点对齐自然日，趋势图最后一天即今天
  const todayIdx = Math.floor((Date.now() + TZ_OFFSET_MS) / DAY_MS);
  const startIdx = todayIdx - days + 1;
  const since = startIdx * DAY_MS - TZ_OFFSET_MS;
  const userCond = s.role === 'admin' ? sql`` : sql` AND user_id = ${s.userId}`;

  const statusRows = rowsOf(
    await db.execute(sql`
      SELECT status,
             COUNT(*)::int AS count,
             SUM(duration_ms) FILTER (WHERE status IN ('succeeded','failed') AND duration_ms IS NOT NULL) AS dur_sum,
             COUNT(duration_ms) FILTER (WHERE status IN ('succeeded','failed'))::int AS dur_count
      FROM capability_operations
      WHERE created_at >= ${since}${userCond}
      GROUP BY status
    `),
  );

  // 每日趋势：day_idx = floor((created_at + 8h) / 1d)，固定偏移不受数据库时区影响
  const dailyRows = rowsOf(
    await db.execute(sql`
      SELECT floor((created_at + 28800000) / 86400000)::bigint AS day_idx,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM capability_operations
      WHERE created_at >= ${since}${userCond}
      GROUP BY 1
      ORDER BY 1
    `),
  );

  const topRows = rowsOf(
    await db.execute(sql`
      SELECT COALESCE(c.name, '未知能力') AS name,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE o.status = 'failed')::int AS failed,
             COALESCE(ROUND(AVG(o.duration_ms) FILTER (WHERE o.duration_ms IS NOT NULL)), 0)::int AS avg_ms
      FROM capability_operations o
      LEFT JOIN capabilities c ON c.id = o.capability_id
      WHERE o.created_at >= ${since}${s.role === 'admin' ? sql`` : sql` AND o.user_id = ${s.userId}`}
        AND o.status IN ('succeeded','failed')
      GROUP BY 1
      ORDER BY total DESC
      LIMIT 10
    `),
  );

  const byStatus: Record<string, number> = {};
  let total = 0;
  let durationSum = 0;
  let durationCount = 0;
  for (const r of statusRows) {
    const count = Number(r.count) || 0;
    byStatus[String(r.status)] = count;
    total += count;
    durationSum += Number(r.dur_sum) || 0;
    durationCount += Number(r.dur_count) || 0;
  }

  const dailyMap = new Map<number, { total: number; failed: number }>();
  for (const r of dailyRows) {
    dailyMap.set(Number(r.day_idx), { total: Number(r.total) || 0, failed: Number(r.failed) || 0 });
  }
  const daily: { date: string; total: number; failed: number }[] = [];
  for (let idx = startIdx; idx <= todayIdx; idx++) {
    const d = dailyMap.get(idx) || { total: 0, failed: 0 };
    daily.push({
      date: new Date(idx * DAY_MS).toISOString().slice(0, 10),
      total: d.total,
      failed: d.failed,
    });
  }

  const finished = (byStatus.succeeded || 0) + (byStatus.failed || 0);
  return NextResponse.json({
    days,
    total,
    byStatus,
    successRate: finished ? Math.round(((byStatus.succeeded || 0) / finished) * 1000) / 10 : null,
    avgDurationMs: durationCount ? Math.round(durationSum / durationCount) : null,
    pendingApprovals: byStatus.pending_approval || 0,
    daily,
    topCapabilities: topRows.map((r) => ({
      name: String(r.name),
      total: Number(r.total) || 0,
      failed: Number(r.failed) || 0,
      avgMs: Number(r.avg_ms) || 0,
    })),
  });
});
