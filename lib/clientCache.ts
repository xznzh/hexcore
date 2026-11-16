// 客户端 GET 数据缓存：重进页面时先秒显上次数据（stale-while-revalidate），后台再刷新。
const store = new Map<string, unknown>();

export function getCache<T = unknown>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function setCache(key: string, val: unknown): void {
  store.set(key, val);
}

export function clearCache(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}

/** GET 并写入缓存；失败返回 null。
 *  opts.force=true 时跳过浏览器 HTTP 缓存（用于「刚写入数据，必须看到最新结果」的场景，
 *  例如生成文档后立刻刷新最近产物列表）。 */
export async function cachedJson<T = any>(url: string, opts?: { force?: boolean }): Promise<T | null> {
  try {
    const r = await fetch(url, opts?.force ? { cache: 'no-store' } : undefined);
    if (!r.ok) return null;
    const j = await r.json();
    setCache(url, j);
    return j as T;
  } catch {
    return null;
  }
}
