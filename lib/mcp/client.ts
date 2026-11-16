import { safeFetch } from '../ssrf';

/**
 * 极简 MCP 客户端（Model Context Protocol，JSON-RPC 2.0 over Streamable HTTP）。
 *
 * 为什么自己写：项目里工具都是「平台内注册」的，而 MCP 让 Agent 能即插即用地接入外部工具服务
 * （文件系统、数据库、浏览器、内部系统…）。一个几十行的客户端就能覆盖 initialize / tools/list / tools/call
 * 三个必需方法，不必引入额外 SDK，也便于理解协议本身。
 *
 * 传输：POST JSON-RPC 到端点，响应可能是 `application/json`（一次性返回）或 `text/event-stream`（SSE 流）。
 * 会话：initialize 的响应头会带 `Mcp-Session-Id`，后续请求必须回传；协议版本走 `MCP-Protocol-Version` 头。
 *
 * 注意：协议细节会随版本演进，默认版本可用配置覆盖（MCP_PROTOCOL_VERSION 或构造参数）。
 */

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: any;
};

export type McpInitializeResult = {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, any>;
};

export type McpClientOptions = {
  url: string;
  headers?: Record<string, string>;
  /** 协议版本，默认 2025-06-18；对端不支持时会在 initialize 结果里返回它自己的版本 */
  protocolVersion?: string;
  timeoutMs?: number;
  /** 与 SSRF 选项一致：本地自建 MCP 服务需显式放开 */
  allowPrivate?: boolean;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
};

/**
 * 从「一次性 JSON」响应里取出匹配 id 的 JSON-RPC 结果。
 * 兼容服务端把多条消息打包成数组返回的情况。
 */
export function parseJsonRpcBody(text: string, id: number | string): JsonRpcMessage | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const list: JsonRpcMessage[] = Array.isArray(data) ? data : [data];
  return list.find((m) => m && String(m.id) === String(id)) || null;
}

/**
 * 从 SSE 响应里取出匹配 id 的 JSON-RPC 结果。
 * SSE 帧格式：若干 `data: {...}` 行，空行分隔事件；通知（无 id）跳过。
 */
export function parseSseBody(text: string, id: number | string): JsonRpcMessage | null {
  const lines = String(text || '').split(/\r?\n/);
  let found: JsonRpcMessage | null = null;
  for (const line of lines) {
    const m = line.match(/^data:\s*(.*)$/i);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const msg = JSON.parse(payload) as JsonRpcMessage;
      if (msg && String(msg.id) === String(id)) found = msg;
    } catch {
      /* 单个坏帧不影响其它帧 */
    }
  }
  return found;
}

/** 把 tools/call 的 content 数组压平成文本（text / 其它类型降级为 JSON） */
export function flattenToolContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') {
      parts.push(String(c));
      continue;
    }
    if (c.type === 'text') parts.push(String(c.text ?? ''));
    else if (c.type === 'resource' && c.resource?.text) parts.push(String(c.resource.text));
    else parts.push(JSON.stringify(c));
  }
  return parts.join('\n').trim();
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;
  /** 协商后的协议版本：以服务端 initialize 返回值为准，服务端可能降级 */
  private proto: string;
  serverInfo: McpInitializeResult['serverInfo'];
  private caps: Record<string, any> = {};

  constructor(private readonly opts: McpClientOptions) {
    this.proto = opts.protocolVersion || process.env.MCP_PROTOCOL_VERSION || '2025-06-18';
  }

  get protocolVersion(): string {
    return this.proto;
  }

  get serverCapabilities(): Record<string, any> {
    return this.caps;
  }

  private async rpc(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // 两个都声明：服务端可以选择一次性 JSON 或 SSE 流式返回
      Accept: 'application/json, text/event-stream',
      ...(this.opts.headers || {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.initialized) headers['MCP-Protocol-Version'] = this.proto;

    const timeout = Math.max(1000, this.opts.timeoutMs || 15000);
    const res = await safeFetch(
      this.opts.url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeout),
      },
      { allowPrivate: this.opts.allowPrivate },
    );
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const ct = String(res.headers.get('content-type') || '');
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MCP 端点返回 HTTP ${res.status}：${text.slice(0, 300)}`);
    }
    const msg = ct.includes('text/event-stream') ? parseSseBody(text, id) : parseJsonRpcBody(text, id);
    if (!msg) throw new Error('MCP 响应中没有匹配的 JSON-RPC 结果（端点可能不是 MCP 服务，或协议版本不兼容）');
    if (msg.error) throw new Error(`MCP 错误 ${msg.error.code ?? ''}：${msg.error.message || '未知错误'}`);
    return msg.result;
  }

  /** 通知类消息（无 id，服务端通常返回 202/空体），失败不影响主流程 */
  private async notify(method: string, params: any = {}): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.opts.headers || {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.initialized) headers['MCP-Protocol-Version'] = this.proto;
    try {
      await safeFetch(
        this.opts.url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method, params }),
          signal: AbortSignal.timeout(Math.max(1000, this.opts.timeoutMs || 15000)),
        },
        { allowPrivate: this.opts.allowPrivate },
      );
    } catch {
      /* 通知丢失可接受 */
    }
  }

  /** 握手：完成后本客户端带上 session id 与协议版本，后续 rpc 才可用 */
  async initialize(): Promise<McpInitializeResult> {
    const result = (await this.rpc('initialize', {
      protocolVersion: this.proto,
      capabilities: {},
      clientInfo: { name: 'hexcore', version: '1.0.0' },
    })) as McpInitializeResult;
    this.initialized = true;
    this.caps = result?.capabilities || {};
    // 以服务端返回的版本为准（服务端可能降级到更低版本），后续请求头要跟着改
    if (result?.protocolVersion) this.proto = String(result.protocolVersion);
    this.serverInfo = result?.serverInfo;
    await this.notify('notifications/initialized');
    return result || {};
  }

  /** 列出服务端暴露的工具（处理 nextCursor 分页，最多 5 页防死循环） */
  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = (await this.rpc('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      for (const t of r?.tools || []) {
        if (t && t.name) out.push({ name: String(t.name), description: t.description, inputSchema: t.inputSchema });
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** 调用工具，返回压平后的文本与是否业务失败 */
  async callTool(name: string, args: Record<string, any> = {}): Promise<{ text: string; isError: boolean }> {
    const r = (await this.rpc('tools/call', { name, arguments: args })) as { content?: any; isError?: boolean };
    return { text: flattenToolContent(r?.content), isError: Boolean(r?.isError) };
  }
}
