import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { messages, conversations, models } from '@/lib/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { cacheStats } from '@/lib/cache';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// 近 N 天 Token 消耗趋势（含估算花费）。管理员看全员，成员看自己。
export const GET = withApi(async ({ req, session }) => {
  const s = session;

  const days = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get('days')) || 30));
  const start = Date.now() - days * 24 * 60 * 60 * 1000;

  // 按「日 × 模型」在 SQL 里聚合：原实现把区间内所有消息行（管理员=全站消息）拉进内存再累加，
  // 90 天窗口下内存与网络开销随消息量线性增长。聚合成「日×模型」后行数被 days*模型数 封顶。
  // 日期口径沿用 UTC（与下方 buckets 的 toISOString().slice(0,10) 保持一致，避免跨时区错位）。
  const dayExpr = sql<string>`to_char(to_timestamp(${messages.createdAt} / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const rows = (await db
    .select({
      day: dayExpr,
      modelId: messages.modelId,
      tokens: sql<number>`coalesce(sum(${messages.tokens}), 0)`,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      s.role === 'admin'
        ? gte(messages.createdAt, start)
        : and(gte(messages.createdAt, start), eq(conversations.userId, s.userId)),
    )
    .groupBy(dayExpr, messages.modelId)) as any[];

  const priceMap = new Map<string, number>();
  (await db.select().from(models)).forEach((m) => priceMap.set(m.id, m.priceOut || 0));

  // 按天聚合
  const buckets = new Map<string, { tokens: number; cost: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    buckets.set(d.toISOString().slice(0, 10), { tokens: 0, cost: 0 });
  }
  for (const r of rows) {
    const b = buckets.get(String(r.day));
    if (!b) continue;
    const tokens = Number(r.tokens) || 0;
    b.tokens += tokens;
    b.cost += (tokens * (priceMap.get(r.modelId) || 0)) / 1000;
  }

  const series = Array.from(buckets.entries()).map(([date, v]) => ({
    date,
    tokens: v.tokens,
    cost: Number(v.cost.toFixed(2)),
  }));
  const total = series.reduce((a, b) => a + b.tokens, 0);
  const totalCost = Number(series.reduce((a, b) => a + b.cost, 0).toFixed(2));
  const cache = await cacheStats();

  return NextResponse.json({ days, series, total, totalCost, cache });
});
