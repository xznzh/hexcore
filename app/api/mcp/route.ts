import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { connectors } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { decryptJson } from '@/lib/crypto';
import { McpClient } from '@/lib/mcp/client';
import { inspectMcp, clearMcpCache, mcpToolKey } from '@/lib/tools/mcp-tools';
import { logAction } from '@/lib/util';
import { withApi, apiError, ApiError } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * MCP 连接器的工具探查与调用入口。
 *
 * 用途：聊天里模型能自动用上 MCP 工具，但排障需要一个「人能直接点」的入口——
 * 先看这个端点到底暴露了哪些工具、参数长什么样，再手工调一次验证链路。
 *
 * POST body:
 *   { connectorId, action: 'tools' }                     → 列出工具（强制刷新缓存）
 *   { connectorId, action: 'call', name, args }          → 调用工具
 */
export const POST = withApi(async ({ req, session }) => {
  const s = session;
  if (s.role === 'guest') apiError(403, 'FORBIDDEN', '访客为只读角色，无法操作连接器');

  const body = await req.json().catch(() => ({}));
  const connectorId = String(body?.connectorId || '').trim();
  const action = String(body?.action || 'tools');
  if (!connectorId) apiError(400, 'INVALID_ARGUMENT', '缺少 connectorId');

  const c = (await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1))[0];
  if (!c) apiError(404, 'NOT_FOUND', '连接器不存在');
  if (c.type !== 'mcp') apiError(400, 'INVALID_ARGUMENT', '该连接器不是 MCP 类型');

  // 可见性：visibleRoles 为空视为对所有人可见
  let roles: string[] = [];
  try {
    roles = JSON.parse(c.visibleRoles || '[]');
  } catch {
    roles = [];
  }
  if (roles.length && !roles.includes(s.role)) apiError(403, 'FORBIDDEN', '无权访问该连接器');

  const cfg: any = decryptJson(c.config);
  const url = String(cfg?.url || c.baseUrl || '').trim();
  if (!url) apiError(400, 'INVALID_STATE', 'MCP 连接器未配置 url');

  const started = Date.now();
  try {
    if (action === 'tools') {
      clearMcpCache(c.id);
      const info = await inspectMcp(c, { force: true });
      await logAction(s.userId, 'mcp_tools', c.name, {
        status: 'ok',
        durationMs: Date.now() - started,
        detail: `发现 ${info.tools.length} 个工具`,
      });
      return NextResponse.json({
        ok: true,
        url,
        count: info.tools.length,
        // chatName：模型在对话里实际看到的函数名（服务端命名规则的唯一来源，前端不要自己拼）
        tools: info.tools.map((t) => ({ ...t, chatName: mcpToolKey(c.name, t.name) })),
        serverInfo: info.serverInfo || null,
        protocolVersion: info.protocolVersion || null,
      });
    }

    if (action === 'call') {
      const name = String(body?.name || '').trim();
      if (!name) apiError(400, 'INVALID_ARGUMENT', '缺少工具名 name');
      const args = body?.args && typeof body.args === 'object' ? body.args : {};
      const client = new McpClient({
        url,
        headers: cfg?.headers && typeof cfg.headers === 'object' ? cfg.headers : undefined,
        timeoutMs: 15000,
      });
      await client.initialize();
      const r = await client.callTool(name, args);
      await logAction(s.userId, 'mcp_call_manual', `${c.name} / ${name}`, {
        status: r.isError ? 'error' : 'ok',
        durationMs: Date.now() - started,
        detail: r.text.slice(0, 800),
      });
      return NextResponse.json({
        ok: !r.isError,
        isError: r.isError,
        text: r.text,
        durationMs: Date.now() - started,
        protocolVersion: client.protocolVersion,
        serverInfo: client.serverInfo || null,
      });
    }

    apiError(400, 'INVALID_ARGUMENT', '不支持的 action（可选 tools / call）');
  } catch (e: any) {
    // 内层 try/catch 会吞掉上层 apiError（把它当成普通异常再包一层 502），必须原样放行
    if (e instanceof ApiError) throw e;

    // 502 而不是 500：失败来自 MCP 服务端（连不上、握手失败、工具报错），
    // 这段信息对排障是刚需，截断后透传。同时落审计，便于事后对齐时间点。
    const msg = String(e?.message || e).slice(0, 400);
    await logAction(s.userId, 'mcp_error', c.name, {
      status: 'error',
      durationMs: Date.now() - started,
      detail: msg,
    }).catch(() => {});
    apiError(502, 'MCP_UPSTREAM_ERROR', msg);
  }
});
