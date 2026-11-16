import { NextRequest, NextResponse } from 'next/server';
import { ensureInit } from '@/lib/db';
import { getSession, type Session } from '@/lib/auth';
import { runWithTrace, traceIdFromHeaders, newTraceId } from '@/lib/trace';
import { incCounter, observeMs } from '@/lib/metrics';
import { routeLabel } from './route-label';
import { classifyDbError, dbErrorHint } from '@/lib/health';

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
 *
 * V8.22 追加第五件事：**RED 指标**（请求数 / 错误数 / 耗时分布）。挂在包装器里而不是
 * 逐个路由埋点，理由和上面四条一样——逐个埋必然漏，而漏掉的那个恰好是出问题的时候。
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

/**
 * 把具体路径归一化成「路由」标签。
 *
 * 实现与理由见 `lib/api/route-label.ts`——单独成文件是为了能不加任何 mock 地单测它
 * （这里 import 会连带 db / auth，纯函数测试没必要为它拉起这些依赖）。
 */
export { routeLabel } from './route-label';

type Handler = (ctx: ApiCtx<any>) => Promise<Response> | Response;

/**
 * `withApi` 的返回值签名。
 *
 * 为什么要把「两参必填」单独声明成最后一个重载：
 * Next 15 会为每个 route 生成 `.next/types/.../route.ts`，里面用
 * `SecondArg<MaybeField<TEntry,'GET'>>` 取导出函数的第二个参数，去和
 * `ParamCheck<RouteContext>`（`{ params: Promise<…> }`，必填）比对。
 *
 * 原先返回值签名是 `(req, routeCtx?) => Response`，第二个参数可选 →
 * 在 `strictNullChecks` 下 `SecondArg` 推出来是 `{ params?: … } | undefined`，
 * 塞不进必填的 `RouteContext`，`next build` 在「Checking validity of types」阶段直接失败：
 *   Type '{ __tag__: "GET"; … __param_type__: { params?: Promise<any> | undefined } | undefined }'
 *   does not satisfy the constraint 'ParamCheck<RouteContext>'
 *
 * 所以：**最后一条重载必须是「两个必填参数」**（TS 推断 SecondArg 时取最后一条重载），
 * 前面留一条单参重载，让测试与内部调用继续可以只传 req。
 */
export type ApiRoute = {
  /** 测试 / 脚本直接调用：Next 的 req 已自备，ctx 可省 */
  (req: NextRequest): Promise<Response>;
  /** Next 15 的真实调用签名：第二个参数必填 */
  (req: NextRequest, routeCtx: { params: Promise<any> }): Promise<Response>;
};

export function withApi(handler: Handler, opts: ApiOptions = {}): ApiRoute {
  const auth = opts.auth ?? 'user';

  const route = async (
    req: NextRequest,
    routeCtx?: { params?: Promise<any> },
  ): Promise<Response> => {
    const traceId = traceIdFromHeaders(req.headers);
    let path = 'unknown';
    try {
      path = new URL(req.url).pathname;
    } catch {
      /* 非法 URL：保留 unknown，不影响后续处理 */
    }

    return runWithTrace({ traceId, entry: opts.entry || `api:${path}` }, async () => {
      const startedAt = Date.now();
      // 预置 500：如果某个分支既不 return 也不抛（理论上不会），指标应记成失败而不是成功
      let res: Response | undefined;
      try {
        if (opts.init !== false) await ensureInit();

        let session: Session | null = null;
        if (auth !== 'none') {
          session = await getSession();
          if (!session) {
            res = err(401, 'UNAUTHORIZED', '未登录', traceId);
            return res;
          }
          if (auth === 'admin' && session.role !== 'admin') {
            res = err(403, 'FORBIDDEN', '需要管理员权限', traceId);
            return res;
          }
        }

        res = await handler({
          req,
          session: session as Session,
          traceId,
          params: routeCtx?.params,
        });
        return res;
      } catch (e: any) {
        if (e instanceof ApiError) {
          res = err(e.status, e.code, e.message, traceId);
          return res;
        }
        // 不把内部错误原文返回给客户端：可能是 SQL 片段、表名、文件路径。
        // 但必须写进服务端日志，并带上 traceId —— 这是排障的唯一线索。
        //
        // 数据库类故障单独处理，理由是它对「刚部署完的人」是必然而非意外：
        // 库没建、端口不对、容器网络写错 localhost，这三件事占首次部署失败的大头。
        // 笼统回「服务器内部错误」会让人完全无从下手，而原始错误文本在中文
        // Windows 上还是乱码（GBK 消息走 UTF-8 通道），连猜都猜不了。
        // 这里按错误码（ASCII，不会乱码）分类，给出可操作的一步。
        const dbKind = classifyDbError(e);
        const dbHint = dbKind === 'unknown' ? null : dbErrorHint(dbKind);
        console.error(
          `[api] ${req.method} ${path} 未捕获异常 [trace:${traceId}] ` +
            (dbHint ? `[db:${dbKind}] ${dbHint.title}｜` : '') +
            `${String(e?.message || e)}` +
            (dbHint ? `\n  修复建议：${dbHint.fix}` : ''),
        );
        res = dbHint
          ? err(503, 'DB_UNAVAILABLE', `数据库不可用：${dbHint.title}`, traceId)
          : err(500, 'INTERNAL', '服务器内部错误', traceId);
        return res;
      } finally {
        const label = routeLabel(path);
        incCounter('hexcore_api_requests_total', 'API 请求数（按路由 / 方法 / 状态码）', {
          route: label,
          method: req.method,
          status: res?.status ?? 500,
        });
        observeMs('hexcore_api_duration_ms', 'API 请求耗时（毫秒）', Date.now() - startedAt, { route: label });
      }
    });
  };

  // 运行时 Next 必定传入 routeCtx，声明成必填只是为了让 `.next/types` 的参数校验通过；
  // 实现里仍按可选处理（测试 / 脚本只传 req 时 routeCtx 为 undefined），断言是安全的。
  return route as ApiRoute;
}
