import { createHash } from 'crypto';

/**
 * V8 · C2：语义缓存键稳定化
 *
 * 原实现把「整段 system」直接哈希进缓存 key，而 system 里含有大量**每轮都变**的内容：
 *   1. `【当前时间】2026-11-01 周日 11:28` —— 精确到分钟，意味着同一个问题跨分钟必然 miss；
 *   2. 个人数据快照里的 `Token：已用 x / 额度 y（剩余 z）` —— 每次回答后用量变化；
 *   3. 存储用量同样的道理。
 * 结果是 TTL 600s 的语义缓存形同虚设（除同一分钟内重复提问外基本不命中）。
 *
 * 这里把这些「对答案语义没有影响、但会污染 key」的片段归一化掉，
 * 让 key 只反映真正决定回答的因子：模型 + 静态约束 + 检索内容 + 用户问题。
 *
 * 注意：知识库检索结果（`===== 团队知识库参考资料 ... =====`）**不做归一化**，
 * 因为它确实决定答案内容——同一问题命中不同资料时必须区分开，否则会串答案。
 */

/** 分钟级时间 → 只保留日期（同一天内的回答约束一致，日期跨天则本就该失效） */
const TIME_LINE_RE = /【当前时间】\s*\d{4}-\d{2}-\d{2}\s*周.\s*\d{1,2}:\d{2}/;

/** 个人数据快照里会随用量变化的行 */
const TOKEN_LINE_RE = /Token：已用\s*[\d,]+\s*\/\s*额度/;
const STORAGE_LINE_RE = /存储：已用\s/;

export function normalizeSystemForCache(system: string): string {
  if (!system) return '';
  return system
    .split('\n')
    .map((line) => {
      if (TIME_LINE_RE.test(line)) {
        // 只抹掉「时分」，保留日期：同一天内缓存可复用，跨天必须失效
        // （「今天/昨天/本周」的解读依赖日期，跨天复用会把昨天的答案当成今天的）
        return line.replace(TIME_LINE_RE, (m) => m.replace(/\s*\d{1,2}:\d{2}$/, ' <time>'));
      }
      if (TOKEN_LINE_RE.test(line)) {
        return '- 本月 Token 用量：<volatile>（不影响回答语义）';
      }
      if (STORAGE_LINE_RE.test(line)) {
        return '- 存储用量：<volatile>（不影响回答语义）';
      }
      return line;
    })
    .join('\n');
}

/**
 * 是否属于「答案会随实时数据变化」的问题。
 *
 * 归一化把 Token/存储用量抹掉了，这对绝大多数问题无害（用量只是背景约束），
 * 但如果用户问的**就是**用量本身，命中 10 分钟前的缓存就会给出过时数字。
 * 这类问题直接跳过缓存（只是少一次可能的命中，不影响正确性）。
 */
const VOLATILE_QUESTION_RE = /(token|额度|配额|用量|已用|存储|计费|花了多少|几点|现在时间)/i;

export function isVolatileQuestion(prompt: string): boolean {
  return VOLATILE_QUESTION_RE.test(prompt || '');
}

/**
 * 生成缓存键。
 * @param variant 用于区分「同样的 model+system+prompt 但行为不同」的场景
 *                （例如本轮是否强制走工具/能力调用），默认空。
 */
export function buildCacheKey(model: string, system: string, prompt: string, variant?: string): string {
  const normalized = normalizeSystemForCache(system);
  const h = createHash('sha256')
    // v2：键结构变更（归一化 + variant），带版本前缀让旧键自然过期，无需手动清 Redis
    .update(`v2|||${model}|||${normalized}|||${prompt}|||${variant || ''}`)
    .digest('hex')
    .slice(0, 32);
  return `llmcache:v2:${h}`;
}

/**
 * 缓存准入判定（V8.10）。
 *
 * 原实现只看「有没有关联能力」和「问的是不是实时数据」，**没有看对话历史**。
 * 而 key 里只有 `model + system + prompt`——历史是以 messages 数组另传给模型的，
 * 不参与哈希。于是同一个短问题（「继续」「那第二点呢」「总结一下」）在不同会话里
 * 会命中同一个答案：**答非所问，而且是静默的**，看起来就像模型理解错了上下文。
 *
 * 修法有两个方向：
 *  a. 把历史摘要 hash 进 key —— 缓存基本再也不命中（每轮历史都在变）；
 *  b. 只在首轮启用 —— 命中率降一些，但每一次命中都是「同一问题的首次提问」。
 *
 * 选 b。语义缓存省的是「同一问题被反复问」的钱，而反复问通常发生在首轮
 * （FAQ、同一批人问同一件事）。多轮里的重复提问本来就带着上文，语料不再相同，
 * 缓存它属于用一个错的答案换一点钱。
 *
 * 返回 reason 而不是布尔：页面/日志要能回答「这轮为什么没走缓存」。
 */
export function cacheDecision(input: {
  /** 本轮是否带历史（true = 多轮，不共享缓存） */
  hasHistory: boolean;
  /** 本轮显式关联的能力数（>0 时必须真的调用工具，命中缓存会跳过调用） */
  wantedCapabilities: number;
  prompt: string;
}): { eligible: boolean; reason: 'ok' | 'multi_turn' | 'capability_bound' | 'volatile_question' } {
  if (input.wantedCapabilities > 0) return { eligible: false, reason: 'capability_bound' };
  if (input.hasHistory) return { eligible: false, reason: 'multi_turn' };
  if (isVolatileQuestion(input.prompt)) return { eligible: false, reason: 'volatile_question' };
  return { eligible: true, reason: 'ok' };
}
