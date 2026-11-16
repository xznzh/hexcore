import { db } from '../db';
import { capabilityOperations } from '../schema';
import { logAction, newId } from '../util';
import { redactPii } from '../guardrails';

/**
 * 统一工具注册表（P0 能力底座）。
 *
 * 目标：聊天、技能、定时任务、API 共用一套工具定义与调用语义：
 * 权限 → 审批 → 超时 → 审计。后续新增工具只需 registerTool，不必散落在各路由里。
 */

export type ToolPermission = 'admin' | 'member' | 'guest';

export type ToolContext = {
  userId: string;
  role: string;
  source?: 'chat' | 'api' | 'skill' | 'schedule';
  conversationId?: string;
  /** 审批通过后由审批器置 true，避免二次进入审批 */
  approved?: boolean;
};

export type ToolDef<I = any> = {
  name: string;
  title?: string;
  description: string;
  /** 给模型看的 JSON Schema 对象 */
  parameters: any;
  permission?: ToolPermission;
  requiresApproval?: boolean;
  timeoutMs?: number;
  invoke: (input: I, ctx: ToolContext) => Promise<string>;
};

export type ToolInvokeResult = {
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
  pendingApproval?: boolean;
  operationId?: string;
};

const registry = new Map<string, ToolDef>();

const RANK: Record<string, number> = { admin: 3, member: 2, guest: 1 };

function allows(required: ToolPermission | undefined, role: string): boolean {
  if (!required) return true;
  if (role === 'admin') return true;
  return (RANK[role] || 0) >= (RANK[required] || 0);
}

export function registerTool<I = any>(def: ToolDef<I>): ToolDef<I> {
  registry.set(def.name, def as ToolDef);
  return def;
}

export function getRegisteredTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

export function listRegisteredTools(ctx?: ToolContext): ToolDef[] {
  const all = [...registry.values()];
  if (!ctx) return all;
  return all.filter((t) => allows(t.permission, ctx.role));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 执行超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 调用注册表中的工具：权限检查 → 审批 → 超时 → 审计。
 * 返回值统一为 ToolInvokeResult，调用方可直接取 text。
 */
export async function invokeRegisteredTool(
  name: string,
  input: any,
  ctx: ToolContext,
): Promise<ToolInvokeResult> {
  const started = Date.now();
  const def = registry.get(name);
  if (!def) {
    return { ok: false, text: `未注册的工具：${name}`, error: 'not_found', durationMs: 0 };
  }
  if (!allows(def.permission, ctx.role)) {
    await logAction(ctx.userId, 'tool_invoke', name, { status: 'error', detail: 'permission_denied' });
    return { ok: false, text: `无权调用工具：${name}`, error: 'forbidden', durationMs: Date.now() - started };
  }

  // 审批：管理员直接执行；普通成员落待审批记录
  if (def.requiresApproval && !ctx.approved && ctx.role !== 'admin') {
    const opId = newId('op');
    await db.insert(capabilityOperations).values({
      id: opId,
      capabilityId: null,
      connectorId: null,
      userId: ctx.userId,
      status: 'pending_approval',
      input: JSON.stringify({ tool: name, args: input }).slice(0, 8000),
      source: ctx.source || 'api',
      conversationId: ctx.conversationId || null,
      createdAt: Date.now(),
    });
    await logAction(ctx.userId, 'tool_approval_request', name, {
      status: 'pending_approval',
      detail: JSON.stringify(input).slice(0, 1000),
    });
    return {
      ok: true,
      pendingApproval: true,
      operationId: opId,
      text: `工具「${name}」需要管理员审批，已提交审批（编号 ${opId}）。审批通过后会自动执行。`,
      durationMs: Date.now() - started,
    };
  }

  const timeoutMs = Math.max(500, Number(def.timeoutMs) || 30000);
  // 审计需要的四要素：入参 / 返回 / 耗时 / 是否失败。入参与返回都先脱敏，
  // 避免手机号、身份证、API Key 这类内容原样落进操作日志。
  const argsBrief = () => {
    try {
      return redactPii(JSON.stringify(input ?? {})).text.slice(0, 600);
    } catch {
      return '(入参无法序列化)';
    }
  };
  try {
    const out = await withTimeout(Promise.resolve(def.invoke(input, ctx)), timeoutMs, def.title || name);
    const text = String(out ?? '');
    const durationMs = Date.now() - started;
    await logAction(ctx.userId, 'tool_invoke', name, {
      status: 'ok',
      durationMs,
      detail: `入参 ${argsBrief()} | 返回 ${redactPii(text).text.slice(0, 800)}`,
    });
    return { ok: true, text, durationMs };
  } catch (e: any) {
    const durationMs = Date.now() - started;
    const error = String(e?.message || e).slice(0, 1000);
    await logAction(ctx.userId, 'tool_invoke', name, {
      status: 'error',
      durationMs,
      detail: `入参 ${argsBrief()} | 失败 ${redactPii(error).text}`,
    });
    return { ok: false, text: `工具执行失败：${error}`, error, durationMs };
  }
}
