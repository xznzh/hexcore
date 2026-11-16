import crypto from 'crypto';

/**
 * OpenAPI / Swagger 解析（纯函数，可单测）。
 *
 * 目标：把三方接口文档转成本平台「能力」候选清单，供管理员勾选后落地为可调用工具。
 * 支持 OpenAPI 3.x 与 Swagger 2.0；只解析本地 `$ref`（#/...），远程引用保持占位，避免 SSRF。
 */

export type ParamLocation = 'path' | 'query' | 'header' | 'cookie' | 'body' | 'formData';

export type OpenApiParameter = {
  name: string;
  in: ParamLocation;
  required: boolean;
  description?: string;
  schema?: any;
};

export type InputSchema = {
  type: 'object';
  properties: Record<string, any>;
  required: string[];
};

export type OpenApiCandidate = {
  /** 连接器内唯一 key */
  key: string;
  /** 展示名 / 能力名 */
  name: string;
  description: string;
  method: string;
  path: string;
  /** 参数清单（含来源位置），调用时据此拼 URL / body */
  parameters: OpenApiParameter[];
  /** 给模型看的 JSON Schema */
  inputSchema: InputSchema;
  /** 结构指纹，用于 refresh 差异比对 */
  fingerprint: string;
  /** 协议扩展元数据（签名/异步/产物声明等），不含密钥 */
  meta?: Record<string, any>;
};

/** 文档声明的 API Key 认证（OpenAPI securitySchemes / Swagger 2.0 securityDefinitions） */
export type OpenApiAuthScheme = {
  /** 凭据参数名，如 appKey */
  name: string;
  in: 'query' | 'header' | 'cookie';
  description?: string;
};

export type ParsedOpenApi = {
  title: string;
  version: string;
  baseUrl: string;
  candidates: OpenApiCandidate[];
  /** 全局 API Key 认证；安装时可由管理员填写并写入连接器 config.query / config.headers */
  auth: OpenApiAuthScheme[];
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** 解析本地 $ref；遇到循环引用时截断，保证不递归爆栈 */
function deref(spec: any, node: any, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const parts = node.$ref.slice(2).split('/');
    let cur = spec;
    for (const raw of parts) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      cur = cur?.[key];
      if (cur === undefined) return node;
    }
    const { $ref, ...rest } = node;
    const merged = { ...(cur && typeof cur === 'object' ? cur : {}), ...rest };
    return deref(spec, merged, depth + 1);
  }
  return node;
}

/** 生成稳定指纹（键排序后 sha1 前 16 位） */
function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function fingerprintOf(value: any): string {
  return crypto.createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function sanitizeKey(raw: string): string {
  const s = String(raw || '')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'op';
}

/** 把文档里的 schema 收敛成模型可读的最小结构，避免把整份 spec 塞进 prompt */
function compactSchema(schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 5) return { type: 'object' };
  const out: any = {};
  if (schema.type) out.type = schema.type;
  else if (schema.properties) out.type = 'object';
  if (schema.description) out.description = String(schema.description).slice(0, 240);
  if (schema.enum) out.enum = schema.enum;
  if (schema.default !== undefined) out.default = schema.default;
  if (schema.items) out.items = compactSchema(schema.items, depth + 1);
  if (schema.properties && typeof schema.properties === 'object') {
    out.type = 'object';
    out.properties = {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const [k, v] of Object.entries(schema.properties)) {
      const child = compactSchema(v, depth + 1);
      if (required.includes(k)) child.description = `${child.description || ''}`.trim();
      out.properties[k] = child;
    }
    if (required.length) out.required = required;
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    out.type = out.type || 'object';
    out.description = out.description || '联合类型';
  }
  return out;
}

function detectBaseUrl(spec: any): string {
  // OpenAPI 3.x
  if (Array.isArray(spec.servers) && spec.servers[0]?.url) {
    let url = String(spec.servers[0].url);
    // 相对 server（如 "/"）对解析没有意义，交给调用方填 baseUrl
    if (url === '/' || url === '.') return '';
    return url.replace(/\/+$/, '');
  }
  // Swagger 2.0
  const host = String(spec.host || '').trim();
  if (host) {
    const scheme = Array.isArray(spec.schemes) && spec.schemes[0] ? `${spec.schemes[0]}://` : 'https://';
    const basePath = String(spec.basePath || '').replace(/\/+$/, '');
    return `${scheme}${host}${basePath}`;
  }
  return '';
}

/**
 * 把 baseUrl / servers[].url 归一成绝对地址。
 * OpenAPI 允许 servers[0].url 是相对路径（如 Petstore 的 "/api/v3"），按规范应相对「文档地址」解析；
 * 直接拿相对路径去拼请求，Node fetch 会直接抛 `fetch failed`，所以这里统一补全。
 */
export function resolveBaseUrl(baseUrl: string | null | undefined, specUrl?: string | null): string {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  const doc = String(specUrl || '').trim();
  if (!doc) return raw.replace(/\/+$/, '');
  try {
    return new URL(raw, doc).toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/**
 * 解析 API Key 认证声明：
 * - OpenAPI 3.x 用 components.securitySchemes + security；Swagger 2.0 用 securityDefinitions。
 * - 只处理 `type: 'apiKey'`（query/header/cookie），其它类型（OAuth2/OIDC）保持不处理。
 * - 优先全局 security；未声明全局时汇总各 operation 的 security，兼容「每个接口单独声明」的文档。
 */
export function parseAuthSchemes(spec: any): OpenApiAuthScheme[] {
  const defs = spec?.components?.securitySchemes || spec?.securityDefinitions || {};
  const out = new Map<string, OpenApiAuthScheme>();

  const add = (refName: string) => {
    if (!refName || out.has(refName)) return;
    const raw = deref(spec, defs[refName]);
    if (!raw || raw.type !== 'apiKey' || !raw.name) return;
    const loc = raw.in === 'header' || raw.in === 'cookie' ? raw.in : 'query';
    out.set(refName, {
      name: String(raw.name),
      in: loc,
      description: raw.description ? String(raw.description).replace(/\s+/g, ' ').slice(0, 240) : undefined,
    });
  };

  const addFromRequirements = (list: any) => {
    if (!Array.isArray(list)) return;
    for (const req of list) {
      if (!req || typeof req !== 'object') continue;
      for (const name of Object.keys(req)) add(name);
    }
  };

  if (Array.isArray(spec?.security)) {
    addFromRequirements(spec.security);
  } else {
    for (const item of Object.values(spec?.paths || {})) {
      if (!item || typeof item !== 'object') continue;
      for (const method of HTTP_METHODS) {
        addFromRequirements((item as any)[method]?.security);
      }
    }
  }

  return [...out.values()];
}

/**
 * 解析文档为能力候选。
 * @param spec OpenAPI JSON 对象
 * @param options.maxCandidates 防止超大文档把界面拖死（默认 200）
 */
export function parseOpenApi(spec: any, options: { maxCandidates?: number } = {}): ParsedOpenApi {
  const max = options.maxCandidates ?? 200;
  const info = spec?.info || {};
  const baseUrl = detectBaseUrl(spec);
  const paths = spec?.paths && typeof spec.paths === 'object' ? spec.paths : {};
  const candidates: OpenApiCandidate[] = [];
  const usedKeys = new Map<string, number>();

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(spec, rawItem) as any;
    if (!item || typeof item !== 'object') continue;
    const pathLevelParams = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;

      const opParams = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => deref(spec, p))
        .filter((p) => p && p.name);

      const parameters: OpenApiParameter[] = [];
      const properties: Record<string, any> = {};
      const required: string[] = [];
      const usedNames = new Set<string>();

      const addProperty = (name: string, location: ParamLocation, schema: any, desc: string, isRequired: boolean) => {
        let prop = name;
        if (usedNames.has(prop)) prop = `${location}_${name}`;
        usedNames.add(prop);
        const compact = compactSchema(schema);
        compact.description = [desc, compact.description].filter(Boolean).join(' — ').slice(0, 240) || undefined;
        properties[prop] = compact;
        if (isRequired) required.push(prop);
        parameters.push({ name: prop, in: location, required: isRequired, description: desc, schema: compact });
      };

      for (const p of opParams) {
        const location = (p.in || 'query') as ParamLocation;
        // body 单独处理（Swagger 2.0），避免与展开后的属性重复
        if (location === 'body') continue;
        if (!['path', 'query', 'header', 'cookie', 'formData'].includes(location)) continue;
        const schema = p.schema || (p.type ? { type: p.type, enum: p.enum, items: p.items } : p);
        // path 参数天然必填
        addProperty(String(p.name), location, schema, p.description || '', location === 'path' || !!p.required);
      }

      // 请求体：OpenAPI 3.x
      if (op.requestBody) {
        const rb = deref(spec, op.requestBody);
        const content = rb?.content && typeof rb.content === 'object' ? rb.content : {};
        const media = content['application/json'] || content['*/*'] || Object.values(content)[0];
        const schema = deref(spec, (media as any)?.schema);
        if (schema) {
          const rbRequired = !!rb.required;
          if (schema.type === 'object' && schema.properties) {
            const rbReq: string[] = Array.isArray(schema.required) ? schema.required : [];
            for (const [k, v] of Object.entries(schema.properties)) {
              addProperty(k, 'body', v, '', rbRequired && rbReq.includes(k));
            }
          } else {
            addProperty('body', 'body', schema, rb.description || '请求体', rbRequired);
          }
        }
      }

      // 请求体：Swagger 2.0
      if (Array.isArray(op.parameters)) {
        for (const p of opParams) {
          if (p.in !== 'body') continue;
          const schema = deref(spec, p.schema);
          if (schema?.type === 'object' && schema.properties) {
            const rbReq: string[] = Array.isArray(schema.required) ? schema.required : [];
            for (const [k, v] of Object.entries(schema.properties)) {
              addProperty(k, 'body', v, '', !!p.required && rbReq.includes(k));
            }
          } else if (schema) {
            addProperty(String(p.name || 'body'), 'body', schema, p.description || '请求体', !!p.required);
          }
        }
      }

      const summary = String(op.summary || '').trim();
      const apiDesc = String(op.description || '').replace(/\s+/g, ' ').trim();
      const description = [summary, apiDesc].filter(Boolean).join(' — ').slice(0, 500) || `${method.toUpperCase()} ${path}`;
      const name = sanitizeKey(summary || op.operationId || `${method}_${path}`);
      const baseKey = sanitizeKey(op.operationId || `${method}_${path}`);

      const n = usedKeys.get(baseKey) || 0;
      usedKeys.set(baseKey, n + 1);
      const key = n === 0 ? baseKey : `${baseKey}_${n + 1}`;

      candidates.push({
        key,
        name,
        description,
        method: method.toUpperCase(),
        path,
        parameters,
        inputSchema: {
          type: 'object',
          properties: Object.keys(properties).length ? properties : {},
          required: [...new Set(required)],
        },
        fingerprint: fingerprintOf({ method, path, parameters, schema: properties }),
      });

      if (candidates.length >= max) break;
    }
    if (candidates.length >= max) break;
  }

  return {
    title: String(info.title || '未命名接口'),
    version: String(info.version || ''),
    baseUrl,
    candidates,
    auth: parseAuthSchemes(spec),
  };
}

export type CapabilityLike = {
  key: string;
  name?: string;
  fingerprint?: string | null;
};

export type CapabilityDiff<T extends CapabilityLike = CapabilityLike> = {
  added: T[];
  updated: T[];
  unchanged: T[];
  removed: CapabilityLike[];
};

/** 比对「库中已有能力」与「最新 spec 解析结果」，供刷新预览/应用 */
export function diffCapabilities<T extends CapabilityLike>(
  existing: CapabilityLike[],
  incoming: T[],
): CapabilityDiff<T> {
  const byKey = new Map(existing.map((e) => [String(e.key), e]));
  const incomingKeys = new Set(incoming.map((i) => String(i.key)));
  const added: T[] = [];
  const updated: T[] = [];
  const unchanged: T[] = [];
  for (const item of incoming) {
    const old = byKey.get(String(item.key));
    if (!old) added.push(item);
    else if (old.fingerprint && item.fingerprint && old.fingerprint !== item.fingerprint) updated.push(item);
    else unchanged.push(item);
  }
  const removed = existing.filter((e) => !incomingKeys.has(String(e.key)));
  return { added, updated, unchanged, removed };
}
