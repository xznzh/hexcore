import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** 中间件跑在 Edge runtime，不能引 node:async_hooks（lib/trace.ts 用了），故此处内联生成 */
function newTraceId(): string {
  return 'tr' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

const COOKIE = 'agent_platform_token';
const AUTH_PAGES = ['/login', '/register'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 额外允许的来源（反向代理改写 Host、前置域名与容器内 Host 不一致时用环境变量补充） */
const EXTRA_ORIGINS = (process.env.APP_ORIGINS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

/**
 * CSRF 校验（仅对状态变更请求）：
 * 1. 优先看 `Sec-Fetch-Site`——浏览器强制写入、页面脚本无法伪造，只允许 same-origin / none；
 * 2. 没有该头时回退到 `Origin` 与 `Host` 比对（支持 APP_ORIGINS 白名单以兼容反代）；
 * 3. 完全没有 Origin 的非浏览器请求（curl / 服务端互调）放行——CSRF 只对「浏览器自动携带 Cookie」有意义。
 *
 * 说明：会话 Cookie 已是 SameSite=Lax，这一层补的是同站子域、老浏览器、以及未来若改 Cookie 策略时的纵深防御。
 */
function csrfBlocked(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;

  const site = req.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';

  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const o = new URL(origin);
    if (o.host === (req.headers.get('host') || '')) return false;
    return !EXTRA_ORIGINS.includes(o.origin);
  } catch {
    return true; // Origin 存在但无法解析：按不可信处理
  }
}

/**
 * 边缘鉴权：仅做「Cookie 是否存在」的快速判断，避免未登录页面的客户端闪烁。
 * 真正的 JWT 校验仍在服务端 layout / API 中完成。
 * API 路径只做 CSRF 校验，不做页面跳转（否则前端拿到 302 而不是 JSON 错误）。
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 链路追踪：给每个请求定一个 traceId，写回请求头 + 响应头。
  // 请求头让 Node 侧的 route handler 能读到同一个 id（写日志时带上），
  // 响应头让浏览器 Network 面板 / 前端报错信息能直接引用，用户报障时贴 id 即可定位。
  const traceId = req.headers.get('x-trace-id') || newTraceId();
  const fwd = new Headers(req.headers);
  fwd.set('x-trace-id', traceId);
  const withTrace = (res: NextResponse) => {
    res.headers.set('x-trace-id', traceId);
    return res;
  };

  if (pathname.startsWith('/api')) {
    if (csrfBlocked(req)) {
      return withTrace(NextResponse.json({ error: '跨站请求已被拒绝' }, { status: 403 }));
    }
    return withTrace(NextResponse.next({ request: { headers: fwd } }));
  }

  const hasToken = Boolean(req.cookies.get(COOKIE)?.value);
  const isAuthPage = AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const isPublic = pathname.startsWith('/share/');

  if (!hasToken && !isAuthPage && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (hasToken && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/work';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // 新增 /api 分支：状态变更接口需要 CSRF 校验；页面分支保持原有「排除静态资源」的行为
  matcher: ['/api/:path*', '/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
