import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { renderMetrics, setGauge, clearMetric } from '@/lib/metrics';
import { circuitSnapshot } from '@/lib/resilience';
import { queueDepth } from '@/lib/queue';

export const dynamic = 'force-dynamic';
// 指标要用 node:crypto 与 process.memoryUsage()，不能跑在 Edge
export const runtime = 'nodejs';

/**
 * Prometheus 抓取端点。
 *
 * 存在的理由：在此之前「扩容」这件事只能按 CPU 猜。本系统的瓶颈是模型首字延迟与
 * token 吞吐，CPU 往往还没起来用户已经在骂了——没有 Rate/Error/Duration 的时间序列，
 * HPA 就只能是拍脑袋。数据一直是有的（`withApi`、`logLlm`、护栏、熔断），
 * 只是没有出口；这个路由只做「导出」，不新增采集。
 *
 * 鉴权：与 `/api/health` 同为运维端点，不使用登录态（Prometheus 拿不到 Cookie）。
 * 默认开放，设置 `METRICS_TOKEN` 后要求 `Authorization: Bearer <token>`。
 * 为什么默认开放：自托管单团队场景下，抓取端通常与实例同网；强制配令牌会让
 * 「第一次接入监控」多一道坎，而漏配的表现是「面板空白」而不是报错。
 * 因此文档里把它写成**部署时的动作**（见 docs/03-运维/监控与指标.md）。
 *
 * 刻意不暴露的东西：用户 id、邮箱、提示词、模型密钥、连接串。
 * 指标是给机器看的聚合值，任何能追溯到个人的字段都不该出现在这里。
 */

function sameToken(got: string, expected: string): boolean {
  // 先各自哈希再比较：长度不同时 timingSafeEqual 会抛错，哈希后长度恒定
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorized(req: Request): boolean {
  const expected = (process.env.METRICS_TOKEN || '').trim();
  if (!expected) return true;
  const header = req.headers.get('authorization') || '';
  const got = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  return got.length > 0 && sameToken(got, expected);
}

function plain(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      // 抓取端自己会带时间戳；中间缓存会让所有实例看起来是同一份数据
      'cache-control': 'no-store',
    },
  });
}

export async function GET(req: Request) {
  if (!authorized(req)) return plain('unauthorized\n', 401);

  // 熔断状态是「此刻」的量：每次抓取重算，先清掉上一轮，
  // 否则已恢复/已删除的连接器会留下一条永不消失的僵尸序列。
  clearMetric('hexcore_circuit_failures');
  clearMetric('hexcore_circuit_open');
  for (const c of circuitSnapshot()) {
    setGauge('hexcore_circuit_failures', '熔断器连续失败数（本进程视图）', c.failures, { breaker: c.key });
    setGauge('hexcore_circuit_open', '熔断是否打开（1=打开，本进程视图）', c.open ? 1 : 0, { breaker: c.key });
  }

  // 队列积压：null 表示「这次读不到」（Redis 不可用），此时不吐任何序列，
  // 而不是吐 0 —— 一条健康的零线会把故障装饰成正常。
  const depth = await queueDepth();
  clearMetric('hexcore_queue_jobs');
  if (depth) {
    for (const state of ['waiting', 'active', 'failed', 'delayed'] as const) {
      setGauge('hexcore_queue_jobs', '文档索引队列各状态的任务数', depth[state], { state });
    }
  }

  const mem = process.memoryUsage();
  setGauge('hexcore_process_resident_memory_bytes', '常驻内存（RSS）', mem.rss);
  setGauge('hexcore_process_heap_used_bytes', 'V8 堆已用', mem.heapUsed);
  setGauge('hexcore_process_uptime_seconds', '进程运行时长（秒）', Math.round(process.uptime()));
  setGauge('hexcore_build_info', '构建信息（值恒为 1，版本在标签里）', 1, {
    version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
  });

  return plain(renderMetrics());
}
