import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  conversations,
  files as F,
  schedules,
  scheduleRuns,
  todos,
  usage,
  users as U,
  artifacts,
  notifications,
} from '@/lib/schema';
import { and, desc, eq, gt, inArray, or, isNull, sql } from 'drizzle-orm';
import { periodNow } from '@/lib/util';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 工作台聚合接口：一次请求拿全首屏数据，避免前端串行发 6~7 个请求。
 * 全部为轻查询（带 limit / userId 过滤），并行执行。
 */
export const GET = withApi(async ({ session }) => {
  const t0 = Date.now();
  const s = session;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const periods = lastNPeriods(6); // 近 6 个月，升序，如 ['2026-05' ... '2026-10']

  const [
    recentConvs,
    recentFiles,
    openTodos,
    mySchedules,
    unreadRows,
    recentArtifacts,
    userRows,
    usageRows,
    recentRuns,
    usageHist,
  ] = await Promise.all([
    db
      .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt, pinned: conversations.pinned })
      .from(conversations)
      .where(and(eq(conversations.userId, s.userId), eq(conversations.archived, false)))
      .orderBy(desc(conversations.createdAt))
      .limit(5),
    db
      .select({ id: F.id, filename: F.filename, mime: F.mime, size: F.size, createdAt: F.createdAt })
      .from(F)
      .where(eq(F.ownerId, s.userId))
      .orderBy(desc(F.createdAt))
      .limit(5),
    db
      .select({ id: todos.id, title: todos.title, source: todos.source, createdAt: todos.createdAt })
      .from(todos)
      .where(and(eq(todos.userId, s.userId), eq(todos.status, 'open')))
      .orderBy(desc(todos.createdAt))
      .limit(5),
    db
      .select({
        id: schedules.id,
        name: schedules.name,
        cron: schedules.cron,
        enabled: schedules.enabled,
        lastRunAt: schedules.lastRunAt,
        lastStatus: schedules.lastStatus,
      })
      .from(schedules)
      .where(or(eq(schedules.ownerId, s.userId), eq(schedules.scope, 'team')))
      .orderBy(desc(schedules.createdAt))
      .limit(5),
    db
      .select({ c: sql<number>`count(*)` })
      .from(notifications)
      .where(and(or(eq(notifications.userId, s.userId), isNull(notifications.userId)), eq(notifications.read, false))),
    db
      .select({ id: artifacts.id, type: artifacts.type, title: artifacts.title, filename: artifacts.filename, createdAt: artifacts.createdAt })
      .from(artifacts)
      .where(eq(artifacts.ownerId, s.userId))
      .orderBy(desc(artifacts.createdAt))
      .limit(5),
    db.select().from(U).where(eq(U.id, s.userId)).limit(1),
    db.select().from(usage).where(and(eq(usage.userId, s.userId), eq(usage.period, periodNow()))).limit(1),
    db
      .select({ id: scheduleRuns.id, scheduleId: scheduleRuns.scheduleId, status: scheduleRuns.status, startedAt: scheduleRuns.startedAt })
      .from(scheduleRuns)
      .where(gt(scheduleRuns.startedAt, dayAgo))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(5),
    db
      .select({ period: usage.period, tokens: usage.tokensUsed })
      .from(usage)
      .where(and(eq(usage.userId, s.userId), inArray(usage.period, periods))),
  ]);

  const dbMs = Date.now() - t0;
  const userRow = userRows[0];
  const used = usageRows[0]?.tokensUsed || 0;
  const limit = userRow?.monthlyLimit || 1000000;
  const histMap = new Map(usageHist.map((r) => [r.period, r.tokens]));
  const quotaTrend = periods.map((p) => histMap.get(p) || 0);
  const scheduleNames = new Set(mySchedules.map((x) => x.id));
  const visibleRuns = recentRuns.filter((r) => scheduleNames.has(r.scheduleId));

  const res = NextResponse.json({
    greeting: greetHour(),
    date: todayStr(),
    conversations: recentConvs,
    files: recentFiles,
    todos: openTodos,
    schedules: mySchedules,
    schedulesRecentRuns: visibleRuns,
    notifications: { unread: Number(unreadRows[0]?.c || 0) },
    artifacts: recentArtifacts,
    quota: {
      used,
      limit,
      percent: Math.min(100, Math.round((used / limit) * 100)),
      period: periodNow(),
      trend: quotaTrend,
      trendLabels: periods,
    },
    name: s.name,
  });
  // 保留 Server-Timing：这是前端/DevTools 判断「首屏慢在 DB 还是别处」的唯一入口，
  // 换成包装器统一响应时容易被丢掉。
  res.headers.set('Server-Timing', `db;dur=${dbMs}, total;dur=${Date.now() - t0}`);
  return res;
});

function greetHour(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 近 n 个月周期字符串（yyyy-mm），升序，含当月。用于额度趋势图。 */
function lastNPeriods(n: number): string[] {
  const out: string[] = [];
  const base = new Date();
  base.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
