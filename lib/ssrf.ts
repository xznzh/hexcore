import net from 'net';
import dns from 'dns/promises';

/**
 * SSRF 防护（Server-Side Request Forgery）。
 *
 * 背景：连接器 / 能力网关 / MCP 端点都由用户自己填 URL，服务端代为发起请求。
 * 若不做校验，用户（哪怕是普通成员）可以填 `http://169.254.169.254/latest/meta-data/`
 * 拿到云主机凭据，或扫内网 `http://10.0.0.5:8080/admin`，把平台变成内网跳板。
 *
 * 三层防护：
 *  1) 字面量校验：协议只允许 http/https；拒绝带 `user:pass@` 的 URL；IP 字面量直接判私网；
 *  2) DNS 解析后校验：域名解析出的每个 IP 都要过私网判定（防 `127.0.0.1.nip.io` 这类域名绕过）；
 *  3) 逐跳重定向校验：手动跟 3xx，每一跳重新走 1)、2)，防「公网 302 到内网」。
 *
 * 逃生口：本地开发常要连 localhost 的自建服务，可用 `SSRF_ALLOW_PRIVATE=true` 放开，
 * 或在单次调用里传 allowHosts 精确放行某个主机。
 */

/** 与私网/保留地址等价的特殊主机名（云厂商元数据服务常用别名） */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.tencentyun.com',
  'instance-data',
]);

export type SsrfOptions = {
  /** 是否允许访问私网/环回地址；默认读环境变量 SSRF_ALLOW_PRIVATE（true/1 时放开） */
  allowPrivate?: boolean;
  /** 精确主机白名单（不区分大小写，支持 *.example.com 后缀匹配） */
  allowHosts?: string[];
  /** 允许的协议，默认 http/https */
  allowedProtocols?: string[];
  /** 最多跟随多少次重定向，默认 3 */
  maxRedirects?: number;
};

/** 校验结果：ok=false 时 reason 说明被拒原因（本项目 tsconfig 未开 strictNullChecks，故意用单形状类型而非可辨识联合） */
export type UrlCheck = { ok: boolean; url?: URL; reason?: string };

function envAllowsPrivate(): boolean {
  const v = String(process.env.SSRF_ALLOW_PRIVATE || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function hostAllowed(host: string, allowHosts?: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowHosts || []) {
    const w = String(raw || '').trim().toLowerCase();
    if (!w) continue;
    if (w.startsWith('*.')) {
      if (h === w.slice(2) || h.endsWith(w.slice(1))) return true;
    } else if (h === w) {
      return true;
    }
  }
  return false;
}

/**
 * 判断一个 IP 字面量是否属于「不该从服务端访问」的地址段。
 * 覆盖：未指定/环回/私网/链路本地（含云元数据）/CGNAT/基准测试/组播/保留，以及 IPv6 对应段。
 * 非法 IP 一律视为不安全（fail-closed）。
 */
export function isBlockedIp(ip: string): boolean {
  const raw = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (!raw) return true;
  const kind = net.isIP(raw);
  if (kind === 4) return isBlockedIPv4(raw);
  if (kind === 6) return isBlockedIPv6(raw);
  return true;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 未指定
  if (a === 10) return true; // 私有
  if (a === 127) return true; // 环回
  if (a === 169 && b === 254) return true; // 链路本地，含 169.254.169.254 元数据
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true; // 私有
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试 198.18/15
  if (a >= 224) return true; // 组播 + 保留 + 广播
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  // IPv4 映射/兼容：::ffff:127.0.0.1 / ::127.0.0.1 → 取出内嵌 v4 再判
  const mapped = s.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true; // fe80::/10
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // 唯一本地地址 fc00::/7
  if (s.startsWith('ff')) return true; // 组播
  if (s.startsWith('64:ff9b:')) return true; // NAT64
  return false;
}

/**
 * 只做「字面量」校验：协议、凭据、主机名黑名单、IP 字面量。
 * 不做 DNS，因此可在边缘/无网络环境安全调用，也便于单测。
 */
export function checkUrlLiteral(raw: string, opts: SsrfOptions = {}): UrlCheck {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, reason: 'URL 格式不合法' };
  }
  const protocols = opts.allowedProtocols || ['http:', 'https:'];
  if (!protocols.includes(u.protocol)) {
    return { ok: false, reason: `不支持的协议 ${u.protocol}（仅允许 ${protocols.join(' / ')}）` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'URL 不允许内嵌账号密码（凭据请放在请求头里）' };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: '缺少主机名' };
  const allowPrivate = opts.allowPrivate ?? envAllowsPrivate();
  if (hostAllowed(host, opts.allowHosts)) return { ok: true, url: u };
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
    if (allowPrivate) return { ok: true, url: u };
    return { ok: false, reason: `禁止访问本地主机 ${host}` };
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host) && !allowPrivate) {
      return { ok: false, reason: `禁止访问内网/保留地址 ${host}` };
    }
  }
  return { ok: true, url: u };
}

/**
 * 文档/教程里的占位域名（example.com、your-domain 之类）：本来就不会解析。
 * 单独识别出来，报错时直说是「示例地址没换」，避免用户去查网络和 DNS。
 */
export function isPlaceholderHost(host: string): boolean {
  const h = String(host || '').toLowerCase();
  for (const d of ['example.com', 'example.org', 'example.net', 'example.edu', 'your-domain.com', 'yourdomain.com', 'domain.com']) {
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}

/**
 * 完整校验：字面量 + DNS 解析后的每个 IP。
 * 域名解析出多个 A/AAAA 记录时，只要有一个落在禁止段就拒绝（防部分污染/轮询绕过）。
 */
export async function assertSafeUrl(raw: string, opts: SsrfOptions = {}): Promise<URL> {
  const lit = checkUrlLiteral(raw, opts);
  if (!lit.ok || !lit.url) throw new Error(`URL 被安全策略拒绝：${lit.reason || '格式不合法'}`);
  const url = lit.url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowPrivate = opts.allowPrivate ?? envAllowsPrivate();
  if (allowPrivate || hostAllowed(host, opts.allowHosts) || net.isIP(host)) return url;

  let addrs: { address: string }[] = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(
      isPlaceholderHost(host)
        ? `域名解析失败：${host}（这是文档里的占位域名，请换成服务端真实地址）`
        : `域名解析失败：${host}（请检查域名拼写，或本机 DNS 是否可用）`
    );
  }
  if (!addrs.length) {
    throw new Error(
      isPlaceholderHost(host)
        ? `域名无解析结果：${host}（这是文档里的占位域名，请换成服务端真实地址）`
        : `域名无解析结果：${host}`
    );
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`URL 被安全策略拒绝：${host} 解析到内网地址 ${a.address}`);
    }
  }
  return lit.url;
}

/**
 * 带 SSRF 校验的 fetch：逐跳校验重定向（最多 maxRedirects 次）。
 * 其余行为与原生 fetch 一致，调用方无需改代码结构。
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  opts: SsrfOptions = {},
): Promise<Response> {
  const maxRedirects = Math.max(0, opts.maxRedirects ?? 3);
  let target = await assertSafeUrl(raw, opts);
  let reqInit: RequestInit = { ...init, redirect: 'manual' };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(target.toString(), reqInit);
    const isRedirect = res.status >= 300 && res.status < 400;
    const loc = res.headers.get('location');
    if (!isRedirect || !loc) return res;
    if (hop === maxRedirects) {
      throw new Error(`重定向次数超过上限（${maxRedirects} 次），已中止`);
    }
    const next = new URL(loc, target);
    target = await assertSafeUrl(next.toString(), opts); // 每一跳都重新校验
    // 303 与 301/302 的语义差异对 GET 无影响；对 POST 按浏览器行为改成 GET
    if (res.status === 303 || (res.status !== 307 && res.status !== 308)) {
      const method = String(reqInit.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        reqInit = { ...reqInit, method: 'GET', body: undefined };
      }
    }
  }
  throw new Error('重定向处理异常');
}
