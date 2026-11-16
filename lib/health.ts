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

/**
 * 把类别翻译成「下一步该做什么」。
 *
 * 为什么单独一层、而不是把建议写进 classifyDbError：两者的受众不同。
 * 类别进 `/api/health`（机器读，且必须保持不含细节）；建议进启动日志与
 * 首屏报错（人读，要具体到命令）。混在一起会让探针被迫输出运维文案。
 *
 * 为什么必须做这件事：中文 Windows 上的 PostgreSQL 默认 `lc_messages` 是
 * `Chinese (Simplified)_China.936`，错误消息按 GBK 生成、经 UTF-8 通道传输，
 * 到 Node 这边就是 `���ݿ� "x" ������` 这样的乱码（U+FFFD）。也就是说
 * **依赖错误消息原文翻译的方案在中文环境里必失效**。所以这里只认 `code`
 * （SQLSTATE / errno 永远是 ASCII，不会乱码），文案由我们自己给。
 */
export function dbErrorHint(kind: DbErrorKind): { title: string; fix: string } {
  switch (kind) {
    case 'database_missing':
      return {
        title: '数据库不存在',
        // 表由应用自动创建，但库本身不会自动建 —— 这是新手最容易漏的一步
        fix: '数据库本身要先建好（表不用管，首次请求会自动创建）。执行 `createdb <库名>`，或把 DATABASE_URL 里的库名改成已存在的库。',
      };
    case 'auth_failed':
      return {
        title: '数据库认证失败',
        fix: '核对 DATABASE_URL 里的用户名与密码；若密码正确仍失败，检查 pg_hba.conf 是否允许该来源以密码方式（scram-sha-256 / md5）登录。',
      };
    case 'unreachable':
      return {
        title: '数据库连不上',
        fix: '确认 PostgreSQL 已启动且端口正确。Docker Compose 里主机名要用服务名（如 postgres:5432），不能用 localhost —— 容器内的 localhost 指的是容器自己。',
      };
    case 'dns_failed':
      return {
        title: '数据库主机名解析失败',
        fix: 'DATABASE_URL 的主机名写错了，或两个容器不在同一个 Docker 网络里。',
      };
    case 'timeout':
      return {
        title: '数据库响应超时',
        fix: '检查网络连通性与数据库负载；首次启动可能正在建索引，稍候重试。',
      };
    case 'tls_failed':
      return {
        title: '数据库 TLS 握手失败',
        fix: '自建库多为自签证书：在连接串末尾加 `?sslmode=disable`（内网可信环境），或给数据库配置受信任证书。',
      };
    default:
      return {
        title: '数据库错误',
        fix: '在服务端日志中按本次 traceId 检索原始错误。',
      };
  }
}
