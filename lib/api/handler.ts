import { NextRequest, NextResponse } from 'next/server';
import { ensureInit } from '@/lib/db';
import { getSession, type Session } from '@/lib/auth';
import { runWithTrace, traceIdFromHeaders, newTraceId } from '@/lib/trace';

/**
 * 统一的 API 路由包装器。
 *
 * 现状问题（V8.2 审计）：87 个 route.ts 里只有 29 个有 try/catch，58 个的异常
 * 直接冒泡成 Next 的默认 500（HTML/纯文本 + 空 body），前端 `res.json()` 解析失败，
 * 用户只看到「网络错误」。同时 401 与 403 的口径在各文件里不一致，同一条「未登录」
 * 在 5 处返回 403。
 *
 * 这个包装器把四件事收敛到一处：
 *   1. ensureInit()          —— 不再每文件手写
 *   2. 鉴权分层              —— 未登录 401 / 越权 403，语义固定
 *   3. traceId 贯穿          —— 用中间件写入的 x-trace-id，错误响应里回传，便于贴给运维
 *   4. 异常兜底              —— 统一 { error, code, traceId }，且不向客户端泄露内部错误原文
 *
 * 刻意不做的事：不统一「成功响应」的形状。现有接口有的返回裸数组、有的返回 {items}，
 * 强行统一会破坏前端调用方；错误契约才是真正需要一致的。
 */

export type ApiCtx<P = Record<string, string>> = {
  req: NextRequest;
  /** auth: 'none' 时为 null；其余情况已保证非空 */
  session: Session;
  traceId: string;
  /** 动态路由的 params（Next 15 起是 Promise，调用方自行 await） */
  params: Promise<P> | undefined;
};

export type ApiOptions = {
  /** 'user'（默认）| 'admin' | 'none' */
  auth?: 'none' | 'user' | 'admin';
  /** 是否在进入 handler 前执行 ensureInit（默认 true） */
  init?: boolean;
  /** 日志里的入口标识，默认 api:<pathname> */
  entry?: string;
};

/** 业务代码用它抛带状态码的错误，包装器会翻译成统一响应 */
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function apiError(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

function err(status: number, code: string, message: string, traceId: string) {
  return NextResponse.json({ error: message, code, traceId }, { status });
}

/**
 * 未接入 `withApi` 的历史路由专用：产出与 withApi 完全一致的错误契约。
 *
 * 之前这些路由手写 `NextResponse.json({ error: '未登录' }, { status: 401 })`，
 * 响应里没有 `code` 和 `traceId`，前端统一错误处理拿不到可判断的错误码，
 * 用户报障时也没法把 traceId 贴给运维。这里只统一「错误形状」，不接管鉴权逻辑。
 *
 * @param req 用于取中间件写入的 x-trace-id；拿不到时新建一个（响应头一并回传）
 */
export function failResponse(
  req: { headers: { get(name: string): string | null } } | undefined,
  status: number,
  code: string,
  message: string,
): NextResponse {
  const traceId = req ? traceIdFromHeaders(req.headers) : newTraceId();
  return NextResponse.json({ error: message, code, traceId }, { status, headers: { 'x-trace-id': traceId } });
}

type Handler = (ctx: ApiCtx<any>) => Promise<Response> | Response;

export function withApi(handler: Handler, opts: ApiOptions = {}) {
  const auth = opts.auth ?? 'user';

  return async (req: NextRequest, routeCtx?: { params?: Promise<any> }): Promise<Response> => {
    const traceId = traceIdFromHeaders(req.headers);
    let path = 'unknown';
    try {
      path = new URL(req.url).pathname;
    } catch {
      /* 非法 URL：保留 unknown，不影响后续处理 */
    }

    return runWithTrace({ traceId, entry: opts.entry || `api:${path}` }, async () => {
      try {
        if (opts.init !== false) await ensureInit();

        let session: Session | null = null;
        if (auth !== 'none') {
          session = await getSession();
          if (!session) return err(401, 'UNAUTHORIZED', '未登录', traceId);
          if (auth === 'admin' && session.role !== 'admin') {
            return err(403, 'FORBIDDEN', '需要管理员权限', traceId);
          }
        }

        return await handler({
          req,
          session: session as Session,
          traceId,
          params: routeCtx?.params,
        });
      } catch (e: any) {
        if (e instanceof ApiError) return err(e.status, e.code, e.message, traceId);
        // 不把内部错误原文返回给客户端：可能是 SQL 片段、表名、文件路径。
        // 但必须写进服务端日志，并带上 traceId —— 这是排障的唯一线索。
        console.error(
          `[api] ${req.method} ${path} 未捕获异常 [trace:${traceId}] ${String(e?.message || e)}`,
        );
        return err(500, 'INTERNAL', '服务器内部错误', traceId);
      }
    });
  };
}
