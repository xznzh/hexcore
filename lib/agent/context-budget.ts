/**
 * 上下文预算工具（V8 · O2，缺口 G8）。
 *
 * 两个独立问题，同一个根因——**每轮都把整份数据重新拼进 system**：
 *  1) 个人快照的 6 个查询每轮都跑，其中「项目/文件/技能/定时任务」这类清单变化很慢，
 *     属于典型的可 memo 数据；而配额/存储必须实时（用户下一句就在问「我用了多少」）。
 *  2) 清单类字段没有长度上限。技能/定时任务是**用户可无限新增**的，
 *     一旦攒到几百条，光这行就吃掉几千 token，把真正该给的资料与历史挤出去。
 *
 * 这里只提供纯工具，不碰数据库：`createTtlMemo` 管缓存与并发去重，
 * `joinCapped` 管「限量 + 告知还有多少」，`truncateSegment` 管整段硬上限。
 */

export type TtlMemo<T> = {
  get(key: string, loader: () => Promise<T>): Promise<T>;
  /** 仅测试/显式失效用 */
  clear(): void;
  size(): number;
};

/**
 * 带 TTL 的异步 memo。
 *
 * 除了 TTL，还做**同 key 并发去重**：并发的两个请求会共享同一个 in-flight promise，
 * 否则「缓存」在最需要它的高并发时刻反而会放大穿透。
 * 失败不缓存（error 会让下一次重试，而不是把错误固化 TTL 那么久）。
 */
export function createTtlMemo<T>(ttlMs: number, now: () => number = Date.now): TtlMemo<T> {
  const store = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();

  return {
    async get(key, loader) {
      const hit = store.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const pending = inflight.get(key);
      if (pending) return pending;
      const p = loader()
        .then((value) => {
          store.set(key, { at: now(), value });
          return value;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, p);
      return p;
    },
    clear() {
      store.clear();
      inflight.clear();
    },
    size() {
      return store.size;
    },
  };
}

/**
 * 把清单渲染成一行，超过上限时截断并**明确告知剩余数量**。
 *
 * 为什么不干脆静默截断：模型看到「技能：a、b、c」会认为这就是全部，
 * 被问「我有几个技能」时会答错且答得很自信。带上「等 N 项」它才知道自己只看到一部分。
 */
export function joinCapped<T>(items: T[], max: number, render: (item: T) => string, sep = '、'): string {
  if (!items.length) return '无';
  const shown = items.slice(0, Math.max(0, max)).map(render);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(sep)}… 等 ${items.length} 项（另有 ${rest} 项未列出）` : shown.join(sep);
}

/**
 * 整段文本的硬上限：超长时保留头部并在尾部标注被截断。
 *
 * 保留头部而非头尾：这类段落（参考资料/快照）的结论与字段名通常在前，
 * 截掉尾部损失的是明细；而工具结果那种「主结论在头、下载链接在尾」的场景
 * 需要头尾都留，走的是 `lib/tools/policy.ts` 的另一套策略。
 */
export function truncateSegment(text: string, maxChars: number, label = '内容'): string {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars))}\n…（${label}过长，已截断 ${s.length - maxChars} 字符）`;
}
