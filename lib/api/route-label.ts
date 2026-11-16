/**
 * 把具体路径归一化成「路由」标签（供指标使用）。
 *
 * 为什么必须归一：`/api/connectors/abc123/revoke` 里的 id 每个都不一样，
 * 按原始 path 打标签会让指标条数随时间无限增长。Prometheus 里这叫基数爆炸，
 * 后果是抓取变慢、内存上涨，最后整块指标只能删掉重建——而那时历史已经断了。
 *
 * 收敛策略只认「看起来像 id」的段，不认识的段原样保留：
 *  - 纯数字（`/api/skills/123`）
 *  - 内部 id 前缀（`conv_9f2a1b`、`run_xxx`、`usg_xxx`）
 *  - uuid / 长十六进制
 *
 * 刻意不做的：不按「第几段」推断。`/api/admin/cost` 与 `/api/connectors/:id`
 * 的段数一样，按位置猜会把正常业务词也吞掉，反而制造「所有路由都叫 :id」的假数据。
 */
export function routeLabel(path: string): string {
  const normalized = path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[a-z]{2,6}_[A-Za-z0-9]{6,}$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id';
      return seg;
    })
    .join('/');
  return normalized || '/';
}
