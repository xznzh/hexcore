import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { connectors, capabilities, capabilityGrants } from '@/lib/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { newId, logAction } from '@/lib/util';
import { encryptJson } from '@/lib/crypto';
import { parseConnectorConfig } from '@/lib/tools';
import { resetCircuit } from '@/lib/resilience';
import { withApi, apiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApi(async ({ session }) => {
  const s = session;
  const rows = await db.select().from(connectors).orderBy(connectors.createdAt);
  // 普通成员只看自己可见且启用的；管理员看全部
  const visible = s.role === 'admin' ? rows : rows.filter((r) => r.enabled && r.status !== 'revoked' && JSON.parse(r.visibleRoles || '[]').includes(s.role));
  const caps = await db.select().from(capabilities).limit(2000);
  const countMap = new Map<string, number>();
  for (const c of caps) {
    if (!c.connectorId || c.status === 'revoked') continue;
    countMap.set(c.connectorId, (countMap.get(c.connectorId) || 0) + 1);
  }
  return NextResponse.json(
    visible.map((r) => {
      // 库里存的是密文；管理员读取时解密回 JSON 文本（前端 JSON.parse 后编辑），普通成员拿不到任何配置
      let configText = '{}';
      if (s.role === 'admin') {
        const cfg = parseConnectorConfig(r.config);
        configText = JSON.stringify(cfg);
      }
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        config: configText,
        enabled: r.enabled,
        visibleRoles: r.visibleRoles,
        status: r.status,
        specUrl: r.specUrl,
        baseUrl: r.baseUrl,
        healthStatus: r.healthStatus,
        healthAt: r.healthAt,
        // V8.5：MCP 审批策略，前端据此展示当前档位（auto/always/never）
        mcpApproval: r.mcpApproval,
        lastError: r.lastError,
        revision: r.revision,
        capabilityCount: countMap.get(r.id) || 0,
        createdAt: r.createdAt,
      };
    }),
  );
});

const createSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['http', 'builtin:file', 'mcp']),
  config: z.any().default({}),
  visibleRoles: z.array(z.enum(['admin', 'member'])).default(['admin', 'member']),
  enabled: z.boolean().default(true),
  /** V8.5：MCP 工具审批策略；非 MCP 连接器忽略此字段 */
  mcpApproval: z.enum(['auto', 'always', 'never']).default('auto'),
});

export const POST = withApi(
  async ({ req, session }) => {
    // 访客是只读角色：创建连接器会写入凭据与外部访问配置，必须拦住
    if (session.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法创建连接器');
    const body = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');
    const p = parsed.data;
    const id = newId('conn');
    await db.insert(connectors).values({
      id,
      name: p.name,
      type: p.type,
      // config 里通常带 Authorization / API Key / 数据库连接串：统一加密落库，避免 DB 备份、只读账号、
      // 日志转储等旁路直接拿到三方凭据明文。
      config: encryptJson(p.config),
      visibleRoles: JSON.stringify(p.visibleRoles),
      enabled: p.enabled,
      mcpApproval: p.mcpApproval,
      createdAt: Date.now(),
    });
    await logAction(session.userId, 'connector_create', p.name);
    return NextResponse.json({ id, name: p.name });
  },
  { auth: 'admin' },
);

const patchSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  config: z.any().optional(),
  enabled: z.boolean().optional(),
  visibleRoles: z.array(z.enum(['admin', 'member'])).optional(),
  mcpApproval: z.enum(['auto', 'always', 'never']).optional(),
});

export const PATCH = withApi(
  async ({ req, session }) => {
    if (session.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法修改连接器');
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) apiError(400, 'INVALID_ARGUMENT', '参数错误');
    const { id, ...rest } = parsed.data;
    const target = (await db.select().from(connectors).where(eq(connectors.id, id)).limit(1))[0];
    if (!target) apiError(404, 'NOT_FOUND', '连接器不存在');
    const patch: any = { ...rest };
    if (rest.config) patch.config = encryptJson(rest.config);
    if (rest.visibleRoles) patch.visibleRoles = JSON.stringify(rest.visibleRoles);
    await db.update(connectors).set(patch).where(eq(connectors.id, id));
    // 配置变更后清掉熔断状态：管理员刚改完地址/密钥就该能立即重试，而不是继续吃冷却期
    resetCircuit(`connector:${id}`);
    return NextResponse.json({ ok: true });
  },
  { auth: 'admin' },
);

export const DELETE = withApi(
  async ({ req, session }) => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) apiError(400, 'INVALID_ARGUMENT', '缺少 id');

    const conn = (await db.select().from(connectors).where(eq(connectors.id, id)).limit(1))[0];
    if (!conn) apiError(404, 'NOT_FOUND', '连接器不存在');

    // 删除连接器时能力一并删除：能力脱离连接器后既不能调用也没有展示价值，
    // 留在库里只会让「能力目录」出现无主条目。历史调用记录（capability_operations）保留。
    const capIds = (
      await db.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.connectorId, id))
    ).map((c) => c.id);
    if (capIds.length) {
      await db.delete(capabilityGrants).where(and(eq(capabilityGrants.scope, 'capability'), inArray(capabilityGrants.targetId, capIds)));
    }
    await db.delete(capabilityGrants).where(and(eq(capabilityGrants.scope, 'connector'), eq(capabilityGrants.targetId, id)));
    await db.delete(capabilities).where(eq(capabilities.connectorId, id));
    await db.delete(connectors).where(eq(connectors.id, id));
    resetCircuit(`connector:${id}`);
    await logAction(session.userId, 'connector_delete', conn.name, {
      detail: `removedCapabilities=${capIds.length}`,
    });
    return NextResponse.json({ ok: true, removedCapabilities: capIds.length });
  },
  { auth: 'admin' },
);
