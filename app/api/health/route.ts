import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, getDbSelfCheck } from '@/lib/db';
import { pingRedis } from '@/lib/redis';
import { classifyDbError, type DbErrorKind } from '@/lib/health';

export const dynamic = 'force-dynamic';

/**
 * 健康检查（未鉴权：只暴露状态，不暴露配置、连接串、模型名）。
 *
 *   GET /api/health            存活探针：进程能响应即 200
 *   GET /api/health?full=1     就绪探针：DB 必须通；Redis 缺失只降级，不算失败
 *
 * 为什么不复用 `/api/health/retrieval`：那个要登录（`getSession()` 判空直接 401），
 * K8s / 负载均衡的探针拿到 401，无法据此判断容器是否可用。
 *
 * 为什么这里不调 `ensureInit()`：它会执行建表与 ALTER 等 DDL。探针每 10s 触发一次，
 * 把 DDL 挂在探针上是给数据库制造无谓压力，也可能与迁移流程互相卡锁。
 *
 * 为什么错误只回 `errorKind` 不回原文：这个接口匿名可访问，而 pg 的错误文本里带
 * 内网主机、端口、用户名。分类逻辑在 `lib/health.ts`（route 文件不允许额外导出，
 * Next 的类型检查会报 TS2344）。
 */

export async function GET(req: Request) {
  const full = new URL(req.url).searchParams.get('full') === '1';

  if (!full) {
    return NextResponse.json({ ok: true, mode: 'live' }, { status: 200 });
  }

  const started = Date.now();
  let dbOk = false;
  let dbErrorKind: DbErrorKind | null = null;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch (e: unknown) {
    dbErrorKind = classifyDbError(e);
    // 原文只进服务端日志，绝不进 HTTP 响应
    console.error('[health] db check failed', {
      kind: dbErrorKind,
      code: (e as { code?: unknown } | null)?.code,
      message: String((e as { message?: unknown } | null)?.message ?? e),
    });
  }

  // Redis 是可选项：缺了系统照样跑（限流退回进程内、队列退回同步索引），
  // 不能让它把 Pod 判死。这里只上报状态，不参与 ok 的判定。
  const redisOk = await pingRedis(1200).catch(() => false);
  const self = getDbSelfCheck();

  return NextResponse.json(
    {
      ok: dbOk,
      mode: 'ready',
      version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
      checks: {
        db: { ok: dbOk, ms: Date.now() - started, errorKind: dbErrorKind },
        redis: { ok: redisOk, optional: true },
        vector: { supported: self.vectorSupported, schemaIssues: self.schemaIssues.length },
      },
    },
    { status: dbOk ? 200 : 503 },
  );
}
