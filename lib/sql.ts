/** drizzle 在 postgres-js / node-postgres 下返回结构不同，统一取行数组 */
export function rowsOf(r: any): any[] {
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.rows)) return r.rows;
  return [];
}
