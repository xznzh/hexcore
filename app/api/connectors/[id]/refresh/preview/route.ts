import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { connectors } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { loadSpec, previewRefresh } from '@/lib/connectors/service';
import { decryptJson } from '@/lib/crypto';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 刷新预览：重新解析 spec，返回新增/变更/未变/下架清单（不写库）。
 */
export const POST = withApi(
  async ({ params }) => {
    const { id } = (await params) as { id: string };

    const conn = (await db.select().from(connectors).where(eq(connectors.id, id)).limit(1))[0];
    if (!conn) apiError(404, 'NOT_FOUND', '连接器不存在');

    // config 落库时已加密，统一走 decryptJson（兼容历史明文行）
    const cfg: any = decryptJson(conn.config);

    if (!conn.specUrl && !cfg.spec) {
      apiError(400, 'INVALID_ARGUMENT', '该连接器没有 specUrl / 内联文档，无法刷新');
    }

    try {
      const { parsed, baseUrl } = await loadSpec({
        specUrl: conn.specUrl || undefined,
        spec: conn.specUrl ? undefined : cfg.spec,
        headers: cfg.headers || {},
        baseUrl: conn.baseUrl || cfg.baseUrl,
      });
      const diff = await previewRefresh(id, parsed, { skippedKeys: cfg.skippedKeys || [] });
      return NextResponse.json({
        title: parsed.title,
        version: parsed.version,
        baseUrl,
        added: diff.added.map((x) => ({ key: x.key, name: x.name, method: x.method, path: x.path })),
        updated: diff.updated.map((x) => ({ key: x.key, name: x.name, method: x.method, path: x.path })),
        unchanged: diff.unchanged.length,
        removed: diff.removed.map((x) => ({ key: x.key, name: x.name })),
      });
    } catch (e: any) {
      apiError(400, 'BAD_REQUEST', String(e?.message || e).slice(0, 500));
    }
  },
  { auth: 'admin' },
);
