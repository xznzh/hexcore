import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';

const SECRET = process.env.APP_SECRET || 'dev-insecure-secret-change-me';
const COOKIE = 'agent_platform_token';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 天

/**
 * 会话 Cookie 的 Secure 标记：生产环境默认开启（只在 HTTPS 下回传）。
 * 内网纯 HTTP 部署可通过 `COOKIE_SECURE=0` 显式关闭，否则会导致登录后立刻掉线。
 */
const COOKIE_SECURE = process.env.COOKIE_SECURE === '0' ? false : process.env.NODE_ENV === 'production';

/**
 * APP_SECRET 缺失处理：JWT 签名与模型 Key / 连接器凭据的 AES 密钥都由它派生。
 * 用内置默认值上线 = 签名密钥公开（可伪造任意用户会话）+ 凭据可被解密，属 P1 级配置缺陷。
 *
 * 因此生产环境默认 **拒绝启动**，而不是只打印告警——告警在容器日志里几乎没人看，
 * 而"能起来"会让部署者误以为配置正确。
 *
 * 逃生开关：`ALLOW_INSECURE_SECRET=1` 允许带默认密钥启动（仅用于内网自测/临时排障），
 * 启动后会打一条醒目的错误日志。构建期跳过，避免污染 build 日志。
 */
const INSECURE_ALLOWED = process.env.ALLOW_INSECURE_SECRET === '1';
const IS_BUILD = !!process.env.NEXT_PHASE?.includes('build');
/** 占位值或过短的密钥一并视为「未配置」：照抄 .env.example 就等于公开密钥 */
const RAW_SECRET = process.env.APP_SECRET || '';
const SECRET_IS_WEAK = RAW_SECRET.length < 16 || RAW_SECRET.startsWith('change-me');

if (SECRET_IS_WEAK && process.env.NODE_ENV === 'production' && !IS_BUILD) {
  if (!INSECURE_ALLOWED) {
    throw new Error(
      `[auth] 拒绝服务：APP_SECRET ${RAW_SECRET ? '过短或仍是示例占位值' : '未设置'}。\n` +
        '  JWT 签名与凭据加密都依赖该密钥，弱密钥等于把签名密钥公开（任何人都能伪造管理员会话）。\n' +
        '  在生产环境，所有页面与接口都会返回 500，直到配置正确的密钥并重启。\n' +
        '  修复：在环境变量/.env.local 里配置一个至少 16 字符的随机串，例如：\n' +
        '      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        '  仅限内网临时自测：设置 ALLOW_INSECURE_SECRET=1 可忽略该检查启动（不推荐）。',
    );
  }
  console.error(
    '[auth] 严重安全告警：ALLOW_INSECURE_SECRET=1 且 APP_SECRET 缺失/过弱，正在使用内置默认密钥。' +
      '任何人都可以伪造管理员会话，请立即配置足够随机的 APP_SECRET 并移除该开关。',
  );
}

export type Session = {
  userId: string;
  email: string;
  name: string;
  role: string;
};

/** JWT 载荷：在 Session 基础上附带会话版本号 tv（旧 token 无此字段，按 0 处理） */
type TokenPayload = Session & { tv?: number };

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function signToken(payload: Session, tokenVersion = 0): string {
  return jwt.sign({ ...payload, tv: tokenVersion }, SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

export async function setAuthCookie(token: string) {
  // Next 15 起 cookies() 返回 Promise，必须 await 后才能读写
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearAuthCookie() {
  (await cookies()).delete(COOKIE);
}

/**
 * 用户状态缓存（进程内，TTL 30s）。
 *
 * 为什么需要它：JWT 是自包含的，一旦签发，里面的 role 在 7 天内都不会变。
 * 这会导致三个真实问题（BUG-018 及其同类）：
 *   1. 账号被禁用后，旧 token 仍能访问；
 *   2. 管理员被降级为 member 后，旧 token 里仍带 admin，可继续用管理员接口；
 *   3. 管理员重置密码后，被盗的旧 token 依然有效。
 *
 * 修法：getSession 不再只信任 JWT，而是回查一次库里的 role/status/token_version。
 * 为免每个请求都打库，用 30s 进程内缓存；管理员侧变更时调用 invalidateUserState 立即失效。
 * 多实例部署下最坏有 30s 不一致窗口（远好于原来的 7 天），需要强一致可换成 Redis 共享缓存。
 */
type UserState = { role: string; status: string; tokenVersion: number };
const USER_STATE_TTL = 30_000;
const userStateCache = new Map<string, { v: UserState; at: number }>();

/** 主动失效某个用户的状态缓存（管理员改角色/禁用/重置密码后调用），不传则全清 */
export function invalidateUserState(userId?: string) {
  if (userId) userStateCache.delete(userId);
  else userStateCache.clear();
}

async function loadUserState(userId: string): Promise<UserState | null> {
  const hit = userStateCache.get(userId);
  const now = Date.now();
  if (hit && now - hit.at < USER_STATE_TTL) return hit.v;

  // 延迟加载 DB，避免仅需验签的路径引入数据库依赖
  const { db } = await import('./db');
  const { users } = await import('./schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db
    .select({ role: users.role, status: users.status, tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const v = rows[0];
  if (!v) return null;
  userStateCache.set(userId, { v, at: now });
  return v;
}

/**
 * 读取当前会话。
 *
 * 注意：这里是 async —— 调用方必须 `await getSession()`。
 * 直接当同步函数用会拿到 Promise（永远 truthy），等于放行所有未登录请求。
 *
 * 除验签外还校验：
 *  - 用户仍存在（被删则失效）
 *  - status !== 'disabled'（禁用即时生效）
 *  - token 版本号与库一致（密码重置后旧 token 失效）
 *  - role 以库为准（降权即时生效，不信任 JWT 里的旧角色）
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;

  const state = await loadUserState(payload.userId);
  if (!state) return null;
  if (state.status === 'disabled') return null;

  // 旧 token 没有 tv 字段，按 0 处理（与库默认值一致），保证升级后存量会话不中断
  const tokenTv = typeof payload.tv === 'number' ? payload.tv : 0;
  if (tokenTv !== state.tokenVersion) return null;

  return {
    userId: payload.userId,
    email: payload.email,
    name: payload.name,
    role: state.role,
  };
}

export async function isFirstUser(): Promise<boolean> {
  // 延迟加载 DB，避免仅需读会话（如根 layout）时初始化数据库连接
  const { db } = await import('./db');
  const { users } = await import('./schema');
  const cnt = await db.$count(users);
  return cnt === 0;
}
