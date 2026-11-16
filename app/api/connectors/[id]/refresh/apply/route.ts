import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { connectors } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { applyRefresh, loadSpec } from '@/lib/connectors/service';
import { logAction } from '@/lib/util';
import { decryptJson } from '@/lib/crypto';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 应用刷新：按 decisions 新增/更新/下架能力。
 */
export const POST = withApi(
  async ({ req, session, params }) => {
    if (session.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法应用连接器变更');
    const { id } = (await params) as { id: string };

    const conn = (await db.select().from(connectors).where(eq(connectors.id, id)).limit(1))[0];
    if (!conn) apiError(404, 'NOT_FOUND', '连接器不存在');

    const body = await req.json().catch(() => ({}));
    // config 落库时已加密，统一走 decryptJson（兼容历史明文行）
    const cfg: any = decryptJson(conn.config);

    if (!conn.specUrl && !cfg.spec) {
      apiError(400, 'INVALID_ARGUMENT', '该连接器没有 specUrl / 内联文档，无法刷新');
    }

    try {
      const { parsed } = await loadSpec({
        specUrl: conn.specUrl || undefined,
        spec: conn.specUrl ? undefined : cfg.spec,
        headers: cfg.headers || {},
        baseUrl: conn.baseUrl || cfg.baseUrl,
      });
      const r = await applyRefresh(id, parsed, session.userId, body?.decisions, {
        skippedKeys: cfg.skippedKeys || [],
      });
      await logAction(session.userId, 'connector_refresh', conn.name, {
        status: 'ok',
        detail: `新增 ${r.inserted}，更新 ${r.updated}，下架 ${r.disabled}`,
      });
      return NextResponse.json({
        inserted: r.inserted,
        updated: r.updated,
        disabled: r.disabled,
        added: r.diff.added.length,
        updatedCount: r.diff.updated.length,
        removed: r.diff.removed.length,
      });
    } catch (e: any) {
      apiError(400, 'BAD_REQUEST', String(e?.message || e).slice(0, 500));
    }
  },
  { auth: 'admin' },
);
