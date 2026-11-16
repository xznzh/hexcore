import { NextResponse } from 'next/server';
import { checkConnectorHealth } from '@/lib/connectors/service';
import { logAction } from '@/lib/util';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** 连接器健康检查：探测 specUrl / baseUrl，并写回 health_status */
export const POST = withApi(
  async ({ session, params }) => {
    const { id } = (await params) as { id: string };
    try {
      const r = await checkConnectorHealth(id);
      await logAction(session.userId, 'connector_health', id, {
        status: r.status === 'ok' ? 'ok' : 'error',
        durationMs: r.latencyMs,
        detail: r.detail,
      });
      return NextResponse.json(r);
    } catch (e: any) {
      // 探活失败是业务结果（连接器不存在/探测异常），保留原来的 404 与原始描述，
      // 否则前台只会看到笼统的「服务器内部错误」，排障信息全丢。
      apiError(404, 'NOT_FOUND', String(e?.message || e).slice(0, 300));
    }
  },
  { auth: 'admin' },
);
