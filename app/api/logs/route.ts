import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { operationLogs, users } from '@/lib/schema';
import { asc, desc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 操作日志。
 *
 * 两种模式：
 *  1. 分页浏览 —— `?page=&pageSize=`，服务端分页，避免把整张 operation_logs
 *     （V6 上限 20 万行）拉进内存再灌给浏览器；按时间倒序。
 *  2. 按链路还原 —— `?trace=trXXXX`，返回该次请求产生的全部日志，**按时间正序**
 *     （链路要顺着读），不分页（一次请求的日志量有天然上界，500 条足够兜底）。
 *
 * 为什么需要第二种：一次对话会产生「检索 + 多次工具调用 + 审批 + 落库」多条日志，
 * 分散在 20 万行里按时间戳猜是不可能的。trace_id 在 v8.2 就有了，但只作为
 * `[trace:xxx] ` 前缀存在 detail 里，只能 `LIKE '%...%'` 全表扫；v8.10 落成真列 + 索引后，
 * 这里才能用等值查询直接还原链路。
 */
export const GET = withApi(async ({ req }) => {
  const { searchParams } = req.nextUrl;

  const trace = (searchParams.get('trace') || '').trim();
  if (trace) {
    // 格式校验：traceId 是 `tr` + 16 位十六进制。不合法就直接返回空，
    // 而不是把用户输入丢进 SQL——虽然 drizzle 会参数化，但「查不到」比「查全表」更诚实。
    if (!/^[\w-]{4,64}$/.test(trace)) {
      return NextResponse.json({ rows: [], total: 0, trace, invalid: true });
    }
    const rows = await db
      .select({
        id: operationLogs.id,
        action: operationLogs.action,
        target: operationLogs.target,
        status: operationLogs.status,
        detail: operationLogs.detail,
        durationMs: operationLogs.durationMs,
        tokens: operationLogs.tokens,
        model: operationLogs.model,
        label: operationLogs.label,
        ok: operationLogs.ok,
        createdAt: operationLogs.createdAt,
        email: users.email,
      })
      .from(operationLogs)
      .leftJoin(users, eq(operationLogs.userId, users.id))
      .where(eq(operationLogs.traceId, trace))
      .orderBy(asc(operationLogs.createdAt))
      .limit(500);

    return NextResponse.json({
      rows: rows.map((r) => ({ ...r, email: r.email || null })),
      total: rows.length,
      trace,
      order: 'asc',
    });
  }

  const pageSize = Math.min(200, Math.max(1, Number(searchParams.get('pageSize')) || 50));
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const offset = (page - 1) * pageSize;

  const total = await db.$count(operationLogs);
  const rows = await db
    .select({
      id: operationLogs.id,
      action: operationLogs.action,
      target: operationLogs.target,
      status: operationLogs.status,
      durationMs: operationLogs.durationMs,
      traceId: operationLogs.traceId,
      createdAt: operationLogs.createdAt,
      email: users.email,
    })
    .from(operationLogs)
    .leftJoin(users, eq(operationLogs.userId, users.id))
    .orderBy(desc(operationLogs.createdAt))
    .limit(pageSize)
    .offset(offset);

  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, email: r.email || null })),
    total,
    page,
    pageSize,
  });
}, { auth: 'admin' });
