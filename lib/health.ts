/**
 * 探针用到的错误分类。放在 lib 而不是 route 文件里，有两个原因：
 * 1. Next 的类型检查（`.next/types/app/**`）只允许 route 文件导出约定成员
 *    （GET/POST/dynamic/...），多导出一个函数会报 TS2344；
 * 2. 它是纯函数，与 HTTP 无关，单独放一层才测得到边界。
 */

/**
 * 数据库故障类别。**只回类别，不回原文**。
 *
 * `/api/health?full=1` 是匿名的，原始错误信息里常带完整连接串、用户名、
 * 内网主机名与端口（pg 的 `ECONNREFUSED 10.0.3.17:5432`、
 * `password authentication failed for user "agent"`），等于把内网拓扑
 * 直接贴到公网探针上。原文只写服务端日志。
 */
export type DbErrorKind =
  | 'auth_failed'
  | 'database_missing'
  | 'unreachable'
  | 'timeout'
  | 'dns_failed'
  | 'tls_failed'
  | 'unknown';

/** 把 PG 错误码或网络错误码收敛成不含敏感信息的类别。 */
export function classifyDbError(e: unknown): DbErrorKind {
  const code = (e as { code?: unknown } | null)?.code;
  const message = String((e as { message?: unknown } | null)?.message ?? '');
  const text = `${typeof code === 'string' ? code : ''} ${message}`;
  const has = (re: RegExp) => re.test(text);

  // PostgreSQL SQLSTATE：只挑与运维判断相关的几个，其余归 unknown
  if (has(/\b28P01\b/) || has(/\b28000\b/)) return 'auth_failed';
  if (has(/\b3D000\b/)) return 'database_missing';
  if (has(/\b57P03\b/)) return 'unreachable'; // cannot_connect_now：实例启动中或拒绝连接
  if (has(/\b53300\b/)) return 'unreachable'; // too_many_connections

  // 网络层
  if (has(/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE/)) return 'unreachable';
  if (has(/ENOTFOUND|EAI_AGAIN/)) return 'dns_failed';
  if (has(/ETIMEDOUT|timeout|timed out/i)) return 'timeout';
  if (has(/self[- ]signed certificate|SSL|TLS|certificate/i)) return 'tls_failed';

  return 'unknown';
}
