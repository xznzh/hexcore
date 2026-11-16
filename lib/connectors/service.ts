import { db } from '../db';
import { capabilities, connectors } from '../schema';
import { eq } from 'drizzle-orm';
import { newId } from '../util';
import { decryptJson } from '../crypto';
import { safeFetch } from '../ssrf';
import { McpClient } from '../mcp/client';
import {
  diffCapabilities,
  parseOpenApi,
  resolveBaseUrl,
  type CapabilityDiff,
  type OpenApiCandidate,
  type ParsedOpenApi,
} from './openapi';

export type SpecInput = {
  specUrl?: string;
  spec?: any;
  headers?: Record<string, string>;
  baseUrl?: string;
};

type CapabilityRowT = typeof capabilities.$inferSelect;
type ConnectorRowT = typeof connectors.$inferSelect;

/** 拉取并解析 OpenAPI 文档（只支持 JSON；YAML 请先转 JSON） */
export async function loadSpec(input: SpecInput): Promise<{
  parsed: ParsedOpenApi;
  raw: any;
  specUrl: string | null;
  baseUrl: string;
}> {
  const headers = { Accept: 'application/json', ...(input.headers || {}) };
  let raw = input.spec;
  const specUrl = String(input.specUrl || '').trim() || null;

  if (!raw && specUrl) {
    const res = await safeFetch(specUrl, { headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok) {
      // 不少三方文档站（如 reqres.in）要求带 API Key 才能取 OpenAPI，直接访问浏览器可能因缓存/登录态看似可用。
      const hint =
        res.status === 401 || res.status === 403
          ? '\n提示：该文档地址需要鉴权。请在「请求头」里填写凭据（如 {"x-api-key":"你的Key"} 或 {"Authorization":"Bearer ..."}）后重新解析。'
          : '';
      throw new Error(`拉取 OpenAPI 失败：HTTP ${res.status} ${text.slice(0, 400)}${hint}`);
    }
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('OpenAPI 文档不是合法 JSON（暂不支持 YAML，请提供 JSON 格式地址）');
    }
  }
  if (!raw || typeof raw !== 'object') throw new Error('缺少 spec 或 specUrl');

  const parsed = parseOpenApi(raw);
  // servers[].url 可能是相对路径（如 "/api/v3"），必须相对 spec 文档地址补全成绝对地址
  let baseUrl = resolveBaseUrl(String(input.baseUrl || '').trim() || parsed.baseUrl, specUrl);
  if (!baseUrl && specUrl) {
    try {
      baseUrl = new URL(specUrl).origin;
    } catch {
      baseUrl = '';
    }
  }
  return { parsed, raw, specUrl, baseUrl: baseUrl.replace(/\/+$/, '') };
}

function candidateToRow(connectorId: string, c: OpenApiCandidate, actorId: string) {
  const now = Date.now();
  const meta = c.meta && typeof c.meta === 'object' ? c.meta : {};
  return {
    id: newId('cap'),
    connectorId,
    key: c.key,
    name: c.name,
    description: c.description,
    method: c.method,
    path: c.path,
    parameters: JSON.stringify(c.parameters),
    inputSchema: JSON.stringify(c.inputSchema),
    responseMapping: '{}',
    minRole: 'member',
    requiresApproval: false,
    timeoutMs: 30000,
    status: 'active',
    fingerprint: c.fingerprint,
    meta: JSON.stringify(meta),
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 安装/刷新能力：
 * - 新 key 插入；
 * - 已存在 key 只更新「接口结构」字段，保留管理员配置（审批/权限/映射/超时）；
 * - selectedKeys 为空表示全部。
 */
export async function upsertCapabilities(
  connectorId: string,
  candidates: OpenApiCandidate[],
  actorId: string,
  options: { selectedKeys?: string[]; onlyKeys?: string[] } = {},
): Promise<{ inserted: number; updated: number }> {
  const selected = options.selectedKeys?.length
    ? new Set(options.selectedKeys)
    : options.onlyKeys?.length
      ? new Set(options.onlyKeys)
      : null;
  const list = selected ? candidates.filter((c) => selected.has(c.key)) : candidates;

  const existing = (await db
    .select()
    .from(capabilities)
    .where(eq(capabilities.connectorId, connectorId))
    .limit(2000)) as CapabilityRowT[];
  const byKey = new Map<string, CapabilityRowT>(existing.map((e) => [e.key, e]));
  let inserted = 0;
  let updated = 0;

  for (const c of list) {
    const old = byKey.get(c.key);
    if (old) {
      const meta = c.meta && typeof c.meta === 'object' ? c.meta : {};
      const patch: any = {
        name: c.name,
        description: c.description,
        method: c.method,
        path: c.path,
        parameters: JSON.stringify(c.parameters),
        inputSchema: JSON.stringify(c.inputSchema),
        fingerprint: c.fingerprint,
        meta: JSON.stringify(meta),
        status: 'active',
        updatedAt: Date.now(),
      };
      await db.update(capabilities).set(patch).where(eq(capabilities.id, old.id));
      updated += 1;
    } else {
      await db.insert(capabilities).values(candidateToRow(connectorId, c, actorId));
      inserted += 1;
    }
  }
  return { inserted, updated };
}

/** 刷新预览：对比库中能力与最新 spec；跳过「管理员确认时不装」的 key，也不重复报告已下架项 */
export async function previewRefresh(
  connectorId: string,
  parsed: ParsedOpenApi,
  options: { skippedKeys?: string[] } = {},
): Promise<CapabilityDiff<OpenApiCandidate>> {
  const existing = (await db
    .select()
    .from(capabilities)
    .where(eq(capabilities.connectorId, connectorId))
    .limit(2000)) as CapabilityRowT[];
  const live = existing.filter((e) => e.status === 'active');
  const disabledKeys = new Set(existing.filter((e) => e.status === 'disabled').map((e) => e.key));
  const skipped = new Set(options.skippedKeys || []);
  const d = diffCapabilities(
    live.map((e) => ({ key: e.key, name: e.name, fingerprint: e.fingerprint })),
    parsed.candidates.filter((c) => !skipped.has(c.key)),
  );
  d.removed = d.removed.filter((r) => !disabledKeys.has(String(r.key)));
  return d;
}

/** 应用刷新：新增/更新/下架（下架仅置 disabled，保留历史调用记录） */
export async function applyRefresh(
  connectorId: string,
  parsed: ParsedOpenApi,
  actorId: string,
  decisions?: { added?: boolean; updated?: boolean; removed?: boolean },
  options: { skippedKeys?: string[] } = {},
): Promise<{ inserted: number; updated: number; disabled: number; diff: CapabilityDiff<OpenApiCandidate> }> {
  const d = await previewRefresh(connectorId, parsed, options);
  const applyAdded = decisions?.added !== false;
  const applyUpdated = decisions?.updated !== false;
  const applyRemoved = decisions?.removed !== false;

  let inserted = 0;
  let updated = 0;
  if (applyAdded || applyUpdated) {
    const r = await upsertCapabilities(
      connectorId,
      [...(applyAdded ? d.added : []), ...(applyUpdated ? d.updated : [])],
      actorId,
    );
    inserted = r.inserted;
    updated = r.updated;
  }

  let disabled = 0;
  if (applyRemoved && d.removed.length) {
    const rows = (await db
      .select()
      .from(capabilities)
      .where(eq(capabilities.connectorId, connectorId))
      .limit(2000)) as CapabilityRowT[];
    for (const item of d.removed) {
      const row = rows.find((c) => c.key === item.key);
      if (row && row.status === 'active') {
        await db
          .update(capabilities)
          .set({ status: 'disabled', updatedAt: Date.now() })
          .where(eq(capabilities.id, row.id));
        disabled += 1;
      }
    }
  }

  const conn = ((await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1))[0] ||
    null) as ConnectorRowT | null;
  if (conn) {
    await db
      .update(connectors)
      .set({ revision: (conn.revision || 1) + 1, discoveredAt: Date.now() })
      .where(eq(connectors.id, connectorId));
  }

  return { inserted, updated, disabled, diff: d };
}

/** 健康检查：优先探测 specUrl，否则探测 baseUrl */
export async function checkConnectorHealth(connectorId: string): Promise<{
  status: 'ok' | 'error';
  latencyMs: number;
  detail: string;
}> {
  const conn = (await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1))[0];
  if (!conn) throw new Error('连接器不存在');
  // config 落库时已加密（lib/crypto.ts encryptJson），decryptJson 兼容历史明文行
  const cfg: any = decryptJson(conn.config);

  // MCP：端点只接受 POST 的 JSON-RPC，GET 探测必然拿到 405/400，会被误判成「异常」。
  // 只有走完 initialize + tools/list 才算真健康 —— 这也顺便把服务名与工具数报出来。
  if (conn.type === 'mcp') {
    const started = Date.now();
    const url = String(cfg?.url || conn.baseUrl || '').trim();
    if (!url) {
      const detail = '未配置 MCP 端点地址（config.url），无法握手';
      await db
        .update(connectors)
        .set({ healthStatus: 'error', healthAt: Date.now(), lastError: detail })
        .where(eq(connectors.id, connectorId));
      return { status: 'error', latencyMs: 0, detail };
    }
    try {
      const cli = new McpClient({
        url,
        headers: cfg?.headers && typeof cfg.headers === 'object' ? cfg.headers : undefined,
        timeoutMs: 10000,
      });
      await cli.initialize();
      const list = await cli.listTools();
      const latencyMs = Date.now() - started;
      const svc = cli.serverInfo ? `${cli.serverInfo.name || '未知服务'} ${cli.serverInfo.version || ''}`.trim() : '未声明 serverInfo';
      const detail = `正常：MCP 握手成功（${svc}，协议 ${cli.protocolVersion}），暴露 ${list.length} 个工具（${latencyMs}ms）`;
      await db
        .update(connectors)
        .set({ healthStatus: 'ok', healthAt: Date.now(), lastError: null })
        .where(eq(connectors.id, connectorId));
      return { status: 'ok', latencyMs, detail };
    } catch (e: any) {
      const latencyMs = Date.now() - started;
      const detail = `MCP 握手失败：${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? '超时（10s）' : String(e?.message || e).slice(0, 300)}`;
      await db
        .update(connectors)
        .set({ healthStatus: 'error', healthAt: Date.now(), lastError: detail })
        .where(eq(connectors.id, connectorId));
      return { status: 'error', latencyMs, detail };
    }
  }

  const target = conn.specUrl || conn.baseUrl || cfg.baseUrl || cfg.url || '';
  const started = Date.now();
  if (!target) {
    const detail = '未配置 specUrl / baseUrl，无法探测';
    await db
      .update(connectors)
      .set({ healthStatus: 'error', healthAt: Date.now(), lastError: detail })
      .where(eq(connectors.id, connectorId));
    return { status: 'error', latencyMs: 0, detail };
  }
  try {
    const res = await safeFetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(cfg.headers || {}) },
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = Date.now() - started;
    const ok = res.status < 500;
    const detail = `${ok ? '正常' : '异常'}：HTTP ${res.status}（${latencyMs}ms，${target}）`;
    await db
      .update(connectors)
      .set({ healthStatus: ok ? 'ok' : 'error', healthAt: Date.now(), lastError: ok ? null : detail })
      .where(eq(connectors.id, connectorId));
    return { status: ok ? 'ok' : 'error', latencyMs, detail };
  } catch (e: any) {
    const detail = `探测失败：${e?.name === 'TimeoutError' ? '超时' : String(e?.message || e).slice(0, 300)}`;
    await db
      .update(connectors)
      .set({ healthStatus: 'error', healthAt: Date.now(), lastError: detail })
      .where(eq(connectors.id, connectorId));
    return { status: 'error', latencyMs: Date.now() - started, detail };
  }
}
