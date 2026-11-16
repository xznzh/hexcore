import { db } from './db';
import { capabilities, capabilityGrants, capabilityOperations, connectors } from './schema';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { newId, logAction } from './util';
import { decodeResponseBody, applyResponseMapping, type ResponseMapping } from './http';
import { resolveBaseUrl, type OpenApiParameter } from './connectors/openapi';
import { decryptJson } from './crypto';
import { guardCircuit, markCircuitFailure, markCircuitSuccess } from './resilience';
import { safeFetch } from './ssrf';
import { assertBusinessSuccess } from './tools/business-success';

export type CapabilityRowT = typeof capabilities.$inferSelect;
export type ConnectorRowT = typeof connectors.$inferSelect;
export type CapabilityOperationRow = typeof capabilityOperations.$inferSelect;

export type Actor = { userId: string; role: string };

export type CapabilityView = {
  id: string;
  connectorId: string | null;
  connectorName: string | null;
  connectorStatus: string | null;
  key: string;
  name: string;
  description: string | null;
  method: string;
  path: string;
  inputSchema: string;
  minRole: string;
  requiresApproval: boolean;
  timeoutMs: number;
  status: string;
};

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function roleRank(role: string): number {
  if (role === 'admin') return 3;
  if (role === 'member') return 2;
  if (role === 'guest') return 1;
  return 0;
}

/** 连接器可见角色是否包含当前角色（空配置视为全部可见） */
export function roleVisible(visibleRolesRaw: string | null | undefined, role: string): boolean {
  const roles = safeJson<string[]>(visibleRolesRaw, []);
  if (!Array.isArray(roles) || !roles.length) return true;
  return roles.includes(role);
}

type GrantLike = { subjectType: string; subjectId: string };

/**
 * 授权判定：存在授权记录时白名单生效（用户级或角色级命中即可），否则按角色可见性放行。
 * 管理员始终可用。
 */
export function grantAllows(grants: GrantLike[], actor: Actor): boolean {
  if (actor.role === 'admin') return true;
  if (!grants.length) return true;
  return grants.some(
    (g) =>
      (g.subjectType === 'user' && g.subjectId === actor.userId) ||
      (g.subjectType === 'role' && g.subjectId === actor.role),
  );
}

export function capabilityAllowed(opts: {
  actor: Actor;
  minRole: string;
  visibleRoles: string | null | undefined;
  connectorGrants: GrantLike[];
  capabilityGrants: GrantLike[];
  connectorStatus?: string | null;
  capabilityStatus?: string | null;
}): boolean {
  const { actor } = opts;
  if (actor.role === 'admin') return true;
  if (roleRank(actor.role) < roleRank(opts.minRole)) return false;
  if (!roleVisible(opts.visibleRoles, actor.role)) return false;
  if (opts.connectorStatus && opts.connectorStatus !== 'active') return false;
  if (opts.capabilityStatus && opts.capabilityStatus !== 'active') return false;
  if (!grantAllows(opts.connectorGrants, actor)) return false;
  if (!grantAllows(opts.capabilityGrants, actor)) return false;
  return true;
}

async function loadGrants(targetIds: string[]) {
  const empty = new Map<string, GrantLike[]>();
  if (!targetIds.length) return empty;
  const rows = await db
    .select()
    .from(capabilityGrants)
    .where(inArray(capabilityGrants.targetId, targetIds))
    .limit(2000);
  const map = new Map<string, GrantLike[]>();
  for (const r of rows) {
    const key = `${r.scope}:${r.targetId}`;
    const list = map.get(key) || [];
    list.push({ subjectType: r.subjectType, subjectId: r.subjectId });
    map.set(key, list);
  }
  return map;
}

/** 当前用户可见的能力目录 */
export async function listCapabilitiesForUser(actor: Actor): Promise<CapabilityView[]> {
  const caps = await db.select().from(capabilities).limit(2000);
  if (!caps.length) return [];
  const connIds = [...new Set(caps.map((c: CapabilityRowT) => c.connectorId).filter(Boolean) as string[])];
  const conns =
    connIds.length > 0
      ? await db.select().from(connectors).where(inArray(connectors.id, connIds)).limit(1000)
      : [];
  const connMap = new Map<string, ConnectorRowT>(conns.map((c: ConnectorRowT) => [c.id, c]));
  const grantMap = await loadGrants([...connIds, ...caps.map((c: CapabilityRowT) => c.id)]);

  return caps
    .filter((c: CapabilityRowT) => c.status !== 'revoked')
    .filter((c: CapabilityRowT) => {
      const conn = c.connectorId ? connMap.get(c.connectorId) : null;
      if (c.connectorId && !conn) return false;
      if (conn && (!conn.enabled || conn.status === 'revoked')) return false;
      return capabilityAllowed({
        actor,
        minRole: c.minRole,
        visibleRoles: conn?.visibleRoles,
        connectorGrants: c.connectorId ? grantMap.get(`connector:${c.connectorId}`) || [] : [],
        capabilityGrants: grantMap.get(`capability:${c.id}`) || [],
        connectorStatus: conn?.status || 'active',
        capabilityStatus: c.status,
      });
    })
    .map((c: CapabilityRowT) => {
      const conn = c.connectorId ? connMap.get(c.connectorId) : null;
      return {
        id: c.id,
        connectorId: c.connectorId,
        connectorName: conn?.name || null,
        connectorStatus: conn?.status || null,
        key: c.key,
        name: c.name,
        description: c.description,
        method: c.method,
        path: c.path,
        inputSchema: c.inputSchema,
        minRole: c.minRole,
        requiresApproval: c.requiresApproval,
        timeoutMs: c.timeoutMs,
        status: c.status,
      };
    });
}

/** 按 id 或能力名查找当前用户可用的能力 */
export async function findCapabilityForUser(
  idOrName: string,
  actor: Actor,
): Promise<{ cap: CapabilityRowT; conn: ConnectorRowT | null } | null> {
  const key = String(idOrName || '').trim();
  if (!key) return null;
  const all = await listCapabilitiesForUser(actor);
  const view =
    all.find((c) => c.id === key) ||
    all.find((c) => c.key.toLowerCase() === key.toLowerCase()) ||
    all.find((c) => c.name.toLowerCase() === key.toLowerCase()) ||
    all.find((c) => c.name.toLowerCase().includes(key.toLowerCase()));
  if (!view) return null;
  const cap = (await db.select().from(capabilities).where(eq(capabilities.id, view.id)).limit(1))[0] as
    | CapabilityRowT
    | undefined;
  if (!cap) return null;
  const conn = cap.connectorId
    ? ((await db.select().from(connectors).where(eq(connectors.id, cap.connectorId)).limit(1))[0] as
        | ConnectorRowT
        | undefined) || null
    : null;
  return { cap, conn };
}

export type InputValidationError = { field: string; message: string };

function typeMatches(expected: string, value: any): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    default:
      return true; // 未知类型不拦
  }
}

/**
 * 把模型常见的「类型走样」纠正回 schema 声明的类型：
 * - number / integer：`"30.59"` → `30.59`
 * - boolean：`"true"` / `"false"` → `true` / `false`
 * - array / object：JSON 字符串 → 真实结构
 *
 * 为什么要做：模型（尤其 OpenAI 兼容端点）经常把数字参数写成带引号的字符串，
 * 严格校验会让本来能成功的调用反复失败、白烧 token。这里只做无损纠正，
 * 纠正不了的原值保留，仍交给 validateCapabilityInput 报错。
 */
export function coerceCapabilityInput(inputSchema: string | any, input: any): any {
  const schema = typeof inputSchema === 'string' ? safeJson<any>(inputSchema, {}) : inputSchema;
  const data = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const props = (schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, any>;
  for (const [field, def] of Object.entries(props)) {
    const v = data[field];
    const expected = String(def?.type || '');
    if (v === undefined || v === null) continue;
    if ((expected === 'number' || expected === 'integer') && typeof v === 'string') {
      const s = v.trim();
      if (s !== '' && Number.isFinite(Number(s))) {
        const n = Number(s);
        data[field] = expected === 'integer' ? Math.trunc(n) : n;
      }
      continue;
    }
    if (expected === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v.trim())) {
      data[field] = v.trim().toLowerCase() === 'true';
      continue;
    }
    if ((expected === 'array' || expected === 'object') && typeof v === 'string' && /^[[{]/.test(v.trim())) {
      try {
        data[field] = JSON.parse(v);
      } catch {
        /* 保留原值，交给校验报错 */
      }
    }
  }
  return data;
}

/**
 * 按能力 inputSchema 做轻量校验：必填、基础类型、枚举。
 * 只拦明确错误，不拒绝 schema 之外的字段（三方接口常有隐式参数）。
 */
export function validateCapabilityInput(inputSchema: string | any, input: any): InputValidationError[] {
  const schema = typeof inputSchema === 'string' ? safeJson<any>(inputSchema, {}) : inputSchema;
  const errors: InputValidationError[] = [];
  if (!schema || typeof schema !== 'object') return errors;
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const required: string[] = Array.isArray(schema.required) ? schema.required.map(String) : [];

  for (const field of required) {
    const v = data[field];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      errors.push({ field, message: `缺少必填参数 ${field}` });
    }
  }

  const props = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, any>;
  for (const [field, def] of Object.entries(props)) {
    const v = data[field];
    if (v === undefined || v === null) continue;
    const expected = String(def?.type || '');
    if (expected && !typeMatches(expected, v)) {
      errors.push({ field, message: `参数 ${field} 应为 ${expected}` });
      continue;
    }
    const enumValues = Array.isArray(def?.enum) ? def.enum : null;
    if (enumValues && enumValues.length && !enumValues.includes(v)) {
      errors.push({ field, message: `参数 ${field} 只能是：${enumValues.join(' / ')}` });
    }
  }
  return errors;
}

/** 把校验错误拼成一行给用户/模型看的提示 */
export function formatInputErrors(errors: InputValidationError[]): string {
  return errors.map((e) => e.message).join('；');
}

export type CapabilityRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function appendQuery(url: URL, key: string, value: any) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const v of value) appendQuery(url, key, v);
    return;
  }
  if (typeof value === 'object') {
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }
  url.searchParams.append(key, String(value));
}

/**
 * 根据能力定义拼出真实请求。纯函数，便于单测。
 * - path / query / header / cookie 参数按位置处理；
 * - body 参数合并成 JSON（input.body 为对象时再深合并）；
 * - baseUrl 可为空，此时 path 必须是绝对地址。
 */
export function buildCapabilityRequest(opts: {
  baseUrl: string;
  method: string;
  path: string;
  parameters: OpenApiParameter[];
  input: Record<string, any>;
  headers?: Record<string, string>;
  connectorConfig?: any;
}): CapabilityRequest {
  const input = opts.input && typeof opts.input === 'object' ? opts.input : {};
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  const rawPath = String(opts.path || '/');

  let urlStr: string;
  if (/^https?:\/\//i.test(rawPath)) urlStr = rawPath;
  else if (base) urlStr = `${base}${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
  else urlStr = rawPath;

  // path 参数替换
  for (const p of opts.parameters) {
    if (p.in !== 'path') continue;
    const v = input[p.name];
    if (v === undefined || v === null) continue;
    urlStr = urlStr.split(`{${p.name}}`).join(encodeURIComponent(String(v)));
    urlStr = urlStr.split(`:${p.name}`).join(encodeURIComponent(String(v)));
  }

  const url = new URL(
    urlStr.startsWith('http') ? urlStr : `http://localhost${urlStr.startsWith('/') ? '' : '/'}${urlStr}`,
  );
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers || {}),
    ...(opts.connectorConfig?.headers || {}),
  };

  const body: Record<string, any> = {};
  const cookie: string[] = [];
  let hasBody = false;
  let hasForm = false;

  for (const p of opts.parameters) {
    const v = input[p.name];
    if (v === undefined) continue;
    if (p.in === 'query') appendQuery(url, p.name, v);
    else if (p.in === 'header') headers[p.name] = String(v);
    else if (p.in === 'cookie') cookie.push(`${p.name}=${encodeURIComponent(String(v))}`);
    else if (p.in === 'formData') {
      hasForm = true;
      body[p.name] = v;
    } else if (p.in === 'body') {
      if (p.name === 'body' && v && typeof v === 'object' && !Array.isArray(v)) Object.assign(body, v);
      else body[p.name] = v;
      hasBody = true;
    }
  }
  if (input.body && typeof input.body === 'object' && !Array.isArray(input.body)) {
    Object.assign(body, input.body);
    hasBody = true;
  }
  // 连接器级静态查询参数（如 DemoAPI 的 appKey）：调用参数优先，配置值只补缺
  const cfgQuery = opts.connectorConfig?.query;
  if (cfgQuery && typeof cfgQuery === 'object' && !Array.isArray(cfgQuery)) {
    for (const [k, v] of Object.entries(cfgQuery)) {
      if (!url.searchParams.has(k)) appendQuery(url, k, v);
    }
  }
  if (cookie.length) headers.Cookie = [headers.Cookie, ...cookie].filter(Boolean).join('; ');

  const method = String(opts.method || 'GET').toUpperCase();
  let payload: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && (hasBody || hasForm || Object.keys(body).length)) {
    if (hasForm && !hasBody) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      payload = params.toString();
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    } else {
      payload = JSON.stringify(body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
  }

  return { url: url.toString(), method, headers, body: payload };
}

export type CallResult = { ok: boolean; status: number; text: string; durationMs: number };

/**
 * 识别「HTTP 200 但业务失败」的响应包裹。
 * 判定逻辑已抽到 `lib/tools/business-success.ts`（可扩展规则表），此处保留导出以兼容现有调用方；
 * DemoAPI / Open-Meteo 两条内置规则的文案与行为与迁移前完全一致。
 */
export function detectBusinessError(raw: string): string | null {
  return assertBusinessSuccess(raw);
}

/** 直接执行一次能力 HTTP 调用（不含权限/审批） */
export async function callCapability(
  cap: CapabilityRowT,
  conn: ConnectorRowT | null,
  input: Record<string, any>,
  opts: { invocationId?: string; idempotencyKey?: string } = {},
): Promise<CallResult> {
  // config 落库时已加密（lib/crypto.ts encryptJson）；这里必须走 decryptJson，否则读不到 baseUrl / headers
  const cfg = decryptJson<any>(conn?.config);
  const parameters = safeJson<OpenApiParameter[]>(cap.parameters, []);
  const mapping = safeJson<ResponseMapping>(cap.responseMapping, {});
  const baseUrl = resolveBaseUrl(conn?.baseUrl || cfg.baseUrl || '', conn?.specUrl || cfg.specUrl || '');
  const absolute = /^https?:\/\//i.test(baseUrl) || /^https?:\/\//i.test(String(cap.path || ''));
  if (!absolute) {
    return {
      ok: false,
      status: 0,
      text:
        `连接器地址不完整（baseUrl=${baseUrl || '空'}）。\n` +
        '请在连接器配置里填写以 http(s):// 开头的地址，或重新发现（refresh）该连接器后再试。',
      durationMs: 0,
    };
  }
  const req = buildCapabilityRequest({
    baseUrl,
    method: cap.method,
    path: cap.path,
    parameters,
    input,
    connectorConfig: cfg,
  });

  const started = Date.now();
  const timeout = Math.max(1000, Number(cap.timeoutMs) || 30000);
  const breakerKey = `connector:${cap.connectorId || conn?.id || 'unknown'}`;
  // 熔断打开（下游连续失败）时直接快速失败，不再白等一个超时周期
  try {
    guardCircuit(breakerKey, conn?.name || cap.name);
  } catch (e: any) {
    return { ok: false, status: 0, text: String(e?.message || e), durationMs: 0 };
  }
  try {
    // 走 safeFetch：能力地址来自连接器配置，属用户可控输入，必须做 SSRF 校验 + 逐跳重定向校验
    const res = await safeFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeout),
    });
    // 5xx 说明下游自己故障 → 计失败；4xx 说明下游活着（只是请求不对）→ 计成功，不误伤熔断
    if (res.status >= 500) markCircuitFailure(breakerKey);
    else markCircuitSuccess(breakerKey);
    const buf = await res.arrayBuffer();
    const raw = decodeResponseBody(buf, res.headers.get('content-type') || '');
    const mapped = applyResponseMapping(raw, mapping);
    const bizError = detectBusinessError(raw);
    const text = bizError ? `${bizError}\n原始返回：${String(mapped).slice(0, 1000)}` : mapped;
    return {
      ok: res.ok && !bizError,
      status: res.status,
      text: `${res.status} ${String(text).slice(0, 8000)}`,
      durationMs: Date.now() - started,
    };
  } catch (e: any) {
    markCircuitFailure(breakerKey);
    // undici 只抛出 "fetch failed"，真实原因在 cause 里（ENOTFOUND / ECONNREFUSED / 证书错误等）
    const cause = e?.cause?.code || e?.cause?.message || '';
    const base = e?.name === 'TimeoutError' ? `请求超时（${timeout}ms）` : String(e?.message || e);
    const detail = `${base}${cause ? `（${cause}）` : ''}\n${req.method} ${req.url}`;
    return { ok: false, status: 0, text: detail.slice(0, 2000), durationMs: Date.now() - started };
  }
}

export type InvokeResult =
  | { status: 'succeeded'; operationId: string; output: string; durationMs: number }
  | { status: 'failed'; operationId: string; error: string; durationMs: number }
  | { status: 'running'; operationId: string; message: string }
  | { status: 'pending_approval'; operationId: string; message: string };

async function runOperation(
  opId: string,
  cap: CapabilityRowT,
  conn: ConnectorRowT | null,
  input: Record<string, any>,
  actorId: string,
): Promise<InvokeResult> {
  const started = Date.now();
  await db
    .update(capabilityOperations)
    .set({ status: 'running', startedAt: started })
    .where(eq(capabilityOperations.id, opId));
  const result = await callCapability(cap, conn, input, { invocationId: opId, idempotencyKey: opId });

  // 运行期间被取消：保留 cancelled 状态，不被迟到结果覆盖
  const current = (
    await db
      .select({ status: capabilityOperations.status })
      .from(capabilityOperations)
      .where(eq(capabilityOperations.id, opId))
      .limit(1)
  )[0];
  if (current?.status === 'cancelled') {
    return { status: 'failed', operationId: opId, error: '操作已取消', durationMs: result.durationMs };
  }

  const ok = result.ok;
  const output = ok ? result.text : null;
  const error = ok ? null : result.text;
  await db
    .update(capabilityOperations)
    .set({
      status: ok ? 'succeeded' : 'failed',
      output,
      error,
      durationMs: result.durationMs,
      finishedAt: Date.now(),
    })
    .where(eq(capabilityOperations.id, opId));
  await logAction(actorId, 'capability_invoke', cap.name, {
    status: ok ? 'ok' : 'error',
    durationMs: result.durationMs,
    detail: ok ? output?.slice(0, 1000) : error || '',
  });
  return ok
    ? { status: 'succeeded', operationId: opId, output: result.text, durationMs: result.durationMs }
    : { status: 'failed', operationId: opId, error: result.text, durationMs: result.durationMs };
}

/**
 * 后台执行（异步长任务）：
 * 不阻塞 HTTP 响应；异常兜底写回 failed，避免未处理 rejection 把进程带崩。
 * 说明：本地/自托管单进程有效；若部署到无状态 Serverless，应改为 BullMQ Worker。
 */
function backgroundRun(
  opId: string,
  cap: CapabilityRowT,
  conn: ConnectorRowT | null,
  input: Record<string, any>,
  actorId: string,
) {
  void (async () => {
    try {
      await runOperation(opId, cap, conn, input, actorId);
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 2000);
      try {
        await db
          .update(capabilityOperations)
          .set({ status: 'failed', error, finishedAt: Date.now() })
          .where(and(eq(capabilityOperations.id, opId), ne(capabilityOperations.status, 'cancelled')));
      } catch {
        /* 兜底写回失败也不抛出 */
      }
      await logAction(actorId, 'capability_invoke', cap.name, { status: 'error', detail: error });
    }
  })();
}

/**
 * 调用能力（统一入口）：
 * - 需要审批的能力先落 pending_approval，管理员审批后再执行；
 * - mode='async' 时长任务转后台执行，立即返回 operationId 供轮询；
 * - 其它能力立即执行并落 capability_operations，供指标/审计聚合。
 */
export async function invokeCapability(opts: {
  cap: CapabilityRowT;
  conn: ConnectorRowT | null;
  input: Record<string, any>;
  actor: Actor;
  source?: string;
  conversationId?: string;
  approvedOperationId?: string;
  mode?: 'sync' | 'async';
}): Promise<InvokeResult> {
  const { cap, conn, input, actor } = opts;
  const now = Date.now();
  const source = opts.source || 'api';
  const mode = opts.mode === 'async' ? 'async' : 'sync';

  // 已审批的异步操作：按审批时保存的参数执行，避免审批后偷换参数
  if (opts.approvedOperationId) {
    const op = (
      await db.select().from(capabilityOperations).where(eq(capabilityOperations.id, opts.approvedOperationId)).limit(1)
    )[0];
    if (op && op.capabilityId === cap.id && op.userId === actor.userId && op.status === 'approved') {
      const stored = safeJson<Record<string, any>>(op.input, {});
      if (op.mode === 'async') {
        backgroundRun(op.id, cap, conn, stored, actor.userId);
        return { status: 'running', operationId: op.id, message: `操作 ${op.id} 已在后台执行，请稍后在调用记录查看结果。` };
      }
      return runOperation(op.id, cap, conn, stored, actor.userId);
    }
  }

  const opId = newId('op');
  if (cap.requiresApproval && actor.role !== 'admin') {
    await db.insert(capabilityOperations).values({
      id: opId,
      capabilityId: cap.id,
      connectorId: cap.connectorId,
      userId: actor.userId,
      status: 'pending_approval',
      mode,
      input: JSON.stringify(input).slice(0, 8000),
      source,
      conversationId: opts.conversationId || null,
      createdAt: now,
    });
    await logAction(actor.userId, 'capability_approval_request', cap.name, {
      status: 'pending_approval',
      detail: JSON.stringify(input).slice(0, 1000),
    });
    return {
      status: 'pending_approval',
      operationId: opId,
      message: `该能力需要管理员审批，已提交审批（操作编号 ${opId}）。审批通过后会自动执行。`,
    };
  }

  await db.insert(capabilityOperations).values({
    id: opId,
    capabilityId: cap.id,
    connectorId: cap.connectorId,
    userId: actor.userId,
    status: 'running',
    mode,
    input: JSON.stringify(input).slice(0, 8000),
    source,
    conversationId: opts.conversationId || null,
    createdAt: now,
    startedAt: now,
  });

  // 异步：立即返回，后台执行并轮询结果
  if (mode === 'async') {
    backgroundRun(opId, cap, conn, input, actor.userId);
    return {
      status: 'running',
      operationId: opId,
      message: `已在后台执行（操作编号 ${opId}），完成后可在「调用记录」查看结果。`,
    };
  }

  return runOperation(opId, cap, conn, input, actor.userId);
}

/** 管理员审批：approve=true 时立即执行，否则标记为 rejected（failed） */
export async function decideApproval(
  operationId: string,
  admin: Actor,
  approve: boolean,
): Promise<InvokeResult | { status: 'rejected'; operationId: string } | null> {
  if (admin.role !== 'admin') return null;
  const op = (await db.select().from(capabilityOperations).where(eq(capabilityOperations.id, operationId)).limit(1))[0];
  if (!op || op.status !== 'pending_approval') return null;

  if (!approve) {
    await db
      .update(capabilityOperations)
      .set({
        status: 'failed',
        error: '审批未通过',
        approvedBy: admin.userId,
        approvedAt: Date.now(),
        finishedAt: Date.now(),
      })
      .where(eq(capabilityOperations.id, op.id));
    await logAction(admin.userId, 'capability_approval_reject', op.capabilityId || op.id);
    return { status: 'rejected', operationId: op.id };
  }

  // 非能力类待审批：注册表工具 or MCP 工具。input 里记录了 tool + args，审批后按原参数执行
  if (!op.capabilityId) {
    const payload = safeJson<{
      tool?: string;
      args?: any;
      /** V8.5：MCP 工具在此带连接器 id 与远端原始工具名（命名空间键不可逆，不能反解） */
      mcp?: { connectorId?: string; toolName?: string };
    }>(op.input, {});
    const toolName = String(payload.tool || '');
    const { invokeRegisteredTool } = await import('./tools/registry');
    const { users } = await import('./schema');
    const user = (await db.select().from(users).where(eq(users.id, op.userId)).limit(1))[0];
    await db
      .update(capabilityOperations)
      .set({ status: 'approved', approvedBy: admin.userId, approvedAt: Date.now() })
      .where(eq(capabilityOperations.id, op.id));
    // 分流：MCP 工具走 `executeMcpTool`（与免审批路径同一个函数），其余走注册表。
    // 两条分支返回同构结构，下面的写回逻辑才能只有一份。
    const isMcp = !!payload.mcp?.connectorId;
    const r = isMcp
      ? await (await import('./tools/mcp-tools')).executeMcpTool(
          String(payload.mcp!.connectorId),
          String(payload.mcp!.toolName || ''),
          (payload.args ?? {}) as Record<string, any>,
          { userId: op.userId, source: (op.source as any) || 'chat' },
        )
      : await invokeRegisteredTool(toolName, payload.args ?? {}, {
          userId: op.userId,
          role: user?.role || 'member',
          source: (op.source as any) || 'api',
          conversationId: op.conversationId || undefined,
          approved: true,
        });
    // MCP 结果没有 `error` 字段，失败原因就在 text 里——不能一律写成「执行失败」，
    // 否则审批人点完只看到一句无信息量的错误，还得去翻第三方日志。
    const failReason = (r as any).error || String(r.text || '执行失败');
    await db
      .update(capabilityOperations)
      .set({
        status: r.ok ? 'succeeded' : 'failed',
        output: r.ok ? r.text.slice(0, 8000) : null,
        error: r.ok ? null : failReason,
        durationMs: r.durationMs,
        finishedAt: Date.now(),
      })
      .where(eq(capabilityOperations.id, op.id));
    if (!r.ok) await logAction(admin.userId, 'mcp_approval_approve_failed', toolName, { status: 'error', detail: failReason.slice(0, 500) }).catch(() => {});
    return r.ok
      ? { status: 'succeeded', operationId: op.id, output: r.text, durationMs: r.durationMs }
      : { status: 'failed', operationId: op.id, error: failReason, durationMs: r.durationMs };
  }

  const cap = op.capabilityId
    ? (await db.select().from(capabilities).where(eq(capabilities.id, op.capabilityId)).limit(1))[0]
    : undefined;
  if (!cap) return null;
  const conn = cap.connectorId
    ? ((await db.select().from(connectors).where(eq(connectors.id, cap.connectorId)).limit(1))[0] as
        | ConnectorRowT
        | undefined) || null
    : null;
  await db
    .update(capabilityOperations)
    .set({ status: 'approved', approvedBy: admin.userId, approvedAt: Date.now() })
    .where(eq(capabilityOperations.id, op.id));
  await logAction(admin.userId, 'capability_approval_approve', cap.name);
  const input = safeJson<Record<string, any>>(op.input, {});
  if (op.mode === 'async') {
    backgroundRun(op.id, cap as CapabilityRowT, conn, input, op.userId);
    return {
      status: 'running',
      operationId: op.id,
      message: `审批已通过，已在后台执行（操作编号 ${op.id}）。`,
    };
  }
  return runOperation(op.id, cap as CapabilityRowT, conn, input, op.userId);
}

/** 取消：待审批可直接取消；运行中的任务只能标记取消（不强行中断远端请求） */
export async function cancelOperation(operationId: string, actor: Actor): Promise<boolean> {
  const op = (await db.select().from(capabilityOperations).where(eq(capabilityOperations.id, operationId)).limit(1))[0];
  if (!op) return false;
  if (actor.role !== 'admin' && op.userId !== actor.userId) return false;
  if (!['pending_approval', 'running', 'approved'].includes(op.status)) return false;
  await db
    .update(capabilityOperations)
    .set({ status: 'cancelled', finishedAt: Date.now() })
    .where(eq(capabilityOperations.id, operationId));
  await logAction(actor.userId, 'capability_operation_cancel', operationId);
  return true;
}
