import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { connectors } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { loadSpec, upsertCapabilities } from '@/lib/connectors/service';
import { newId, logAction } from '@/lib/util';
import { encryptJson, decryptJson } from '@/lib/crypto';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * 确认安装：把发现的能力落地到连接器。
 * body: { connectorId? , name?, specUrl?, spec?, headers?, baseUrl?, selectedKeys?[] }
 */
export const POST = withApi(
  async ({ req, session }) => {
    const body = await req.json().catch(() => null);
    if (!body) apiError(400, 'INVALID_ARGUMENT', '参数错误');

    let connectorId = String(body.connectorId || '').trim();
    let connector: typeof connectors.$inferSelect | undefined = connectorId
      ? (await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1))[0]
      : undefined;

    try {
      const query: Record<string, any> =
        body.query && typeof body.query === 'object' && !Array.isArray(body.query) ? body.query : {};
      const headers: Record<string, any> =
        body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers) ? body.headers : {};
      const { parsed, raw, specUrl, baseUrl } = await loadSpec({
        specUrl: body.specUrl,
        spec: body.spec,
        headers: body.headers,
        baseUrl: body.baseUrl,
      });

      const selectedKeys: string[] | undefined = Array.isArray(body.selectedKeys)
        ? body.selectedKeys.map((x: any) => String(x))
        : undefined;
      const skippedKeys = selectedKeys?.length
        ? parsed.candidates.map((c) => c.key).filter((k) => !selectedKeys.includes(k))
        : [];

      if (!connector) {
        const name = String(body.name || parsed.title || '未命名连接器').trim().slice(0, 80);
        connectorId = newId('conn');
        await db.insert(connectors).values({
          id: connectorId,
          name,
          type: 'http',
          config: encryptJson({
            baseUrl,
            headers,
            query,
            specUrl: specUrl || undefined,
            // 无文档地址时缓存内联 spec，保证后续刷新仍可用
            spec: specUrl ? undefined : raw,
            skippedKeys,
          }),
          enabled: true,
          visibleRoles: JSON.stringify(body.visibleRoles || ['admin', 'member']),
          status: 'active',
          specUrl,
          baseUrl,
          discoveredAt: Date.now(),
          revision: 1,
          createdAt: Date.now(),
        });
        connector = (await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1))[0];
      } else {
        // 已有连接器：补齐发现信息（不覆盖管理员手填的 config 其它字段）
        // 存量 config 可能是密文（V6.5 之后）或明文（之前），decryptJson 两者都吃
        const cfg: any = decryptJson(connector.config);
        if (!specUrl && raw) cfg.spec = raw;
        if (!cfg.baseUrl && baseUrl) cfg.baseUrl = baseUrl;
        // 本次填写的请求头 / 固定查询参数合并进配置（用于补 appKey 等凭证）
        if (Object.keys(headers).length) cfg.headers = { ...(cfg.headers || {}), ...headers };
        if (Object.keys(query).length) cfg.query = { ...(cfg.query || {}), ...query };
        // 本次确认的勾选结果即最新基线：全选则清空历史跳过项
        cfg.skippedKeys = skippedKeys;
        await db
          .update(connectors)
          .set({
            specUrl: specUrl || connector.specUrl,
            baseUrl: baseUrl || connector.baseUrl,
            config: encryptJson(cfg),
            discoveredAt: Date.now(),
            status: 'active',
          })
          .where(eq(connectors.id, connectorId));
      }

      const r = await upsertCapabilities(connectorId, parsed.candidates, session.userId, { selectedKeys });
      await logAction(session.userId, 'connector_confirm', connector?.name || connectorId, {
        status: 'ok',
        detail: `新增 ${r.inserted}，更新 ${r.updated}`,
      });
      return NextResponse.json({
        connectorId,
        name: connector?.name,
        inserted: r.inserted,
        updated: r.updated,
        total: parsed.candidates.length,
        baseUrl,
        specUrl,
      });
    } catch (e: any) {
      apiError(400, 'BAD_REQUEST', String(e?.message || e).slice(0, 500));
    }
  },
  { auth: 'admin' },
);
