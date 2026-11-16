import { db } from '../db';
import { chunks, documents } from '../schema';
import { eq, sql, inArray, ilike, or, and } from 'drizzle-orm';
import { embedQueryForModel, cosine, normalizeEmbeddingRef } from './embed';
import { getRerankModel, rerankDocuments } from './rerank';
import { isVectorSupported } from '../db';
import { EMBED_DIM } from './embed-dim';

export type RetrievalHit = { content: string; source: string; score: number };

/**
 * 解析并夹取检索条数 topK。
 *
 * 单独抽出来的原因：旧写法 `Math.max(1, Math.min(20, Number(body?.topK) || 3))` 里
 * `Number(0)` 是 falsy，被 `|| 3` 提前吃掉——传 0 会静默变成 3，`Math.max(1, …)` 的下限
 * 对 0 永远不可达（BUG-023）。这里把「缺省 / 非法 / 越界」三种情况分开处理：
 *   - 未传（undefined / null / 空串）或非数值（'abc'、NaN、Infinity） → 默认值 3
 *   - 合法数值 → 夹到 [min, max]
 *   - 0 / 负数 → 夹到下限 1，而不是被当成「没传」而放大成默认值
 */
export function clampTopK(v: unknown, fallback = 3, min = 1, max = 20): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * 句末边界（零宽，用于 split）。
 *
 * 中文标点（。！？；）和换行无条件断开；**ASCII 的 `. ! ?` 必须满足「后面是空白或文末」才断**。
 * 旧实现写成 `(?<=[。.！!？?；;\n])`，把小数点也当句末——于是 `T2.5`、`0.6`、`3.48`、
 * 版本号 `1.3.1` 全被切断，切出来的碎片又在第 2 步用 `\n` 拼回去，正文里就留下
 * 「T2.\n5」「0.\n6」这种**把数字劈开的换行**。对一个通篇是监测读数值（几乎每个数都带小数）
 * 的知识库来说，这是直接往模型嘴里塞错的数字。
 */
const SENTENCE_BREAK = /(?<=[。！？；\n])|(?<=[.!?])(?=\s|$)/;

/**
 * 语义分块：先合并短段落（关键），再按句子切超长段落，最后加尾部重叠。
 *
 * 为什么必须合并：docx 的「一个视觉行 = 一个 w:p」被 mammoth 还原成「空行分隔的段落」，
 * 于是 `1.2 获取接口验证Token 3` 这种目录行也独立成段。旧实现「一段一片」，
 * 实测 711 片里 **613 片（86%）不足 20 字** —— 这类碎片的向量语义几乎为零，
 * 但词面命中率极高（问题里的词就在标题里），反而把含答案的长片段挤出了 top-k。
 * 现在先贪心合并到接近 size，让每片自带上下文。
 */
export function splitText(text: string, size = 800, overlap = 80): string[] {
  const clean = (text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [text || ''];

  // 1) 拆成「不可再分的单元」：短段落整段一个单元；超长段落先按句切，单句仍超长才硬切
  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const units: string[] = [];
  for (const p of paras) {
    if (p.length <= size) {
      units.push(p);
      continue;
    }
    const sent = p.split(SENTENCE_BREAK).map((s) => s.trim()).filter(Boolean);
    for (const s of sent) {
      if (s.length <= size) {
        units.push(s);
        continue;
      }
      // 超长单句按窗口硬切（旧实现这里直接 slice 截断，会静默丢字）
      for (let i = 0; i < s.length; i += size) units.push(s.slice(i, i + size));
    }
  }

  // 2) 贪心合并单元到接近 size
  const blocks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (!cur) {
      cur = u;
    } else if (cur.length + 1 + u.length <= size) {
      cur += '\n' + u;
    } else {
      blocks.push(cur);
      cur = u;
    }
  }
  if (cur) blocks.push(cur);

  // 3) 尾块过短就并回上一块，避免末尾孤零零剩一行（如「附：修订记录」）。
  //    合并后不超过 1.1×size —— 否则「为了收尾」会造出一个超长片，稀释向量语义。
  if (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    const prev = blocks[blocks.length - 2];
    if (last.length < size / 4 && prev.length + 1 + last.length <= size * 1.1) {
      blocks.pop();
      blocks[blocks.length - 1] = `${prev}\n${last}`;
    }
  }

  // 4) 重叠窗口，避免语义正好卡在边界上丢失
  if (blocks.length <= 1) return blocks.length ? blocks : [text || ''];
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let seg = blocks[i];
    if (i > 0 && overlap > 0) {
      seg = (blocks[i - 1].slice(-overlap) + '\n' + seg).trim();
    }
    out.push(seg);
  }
  return out.length ? out : [text || ''];
}

/**
 * 从已有切片还原原文，供「换了分块策略后重建切片」使用。
 *
 * splitText 的重叠规则是：`out[i] = blocks[i-1].slice(-overlap) + '\n' + blocks[i]`。
 * 要剥掉这段重叠，必须拿**还原出来的 blocks[i-1]** 去取尾巴，不能用 `contents[i-1]`：
 * 当旧切片本身短于 overlap 时（碎片化的历史数据全是几字一片），
 * `contents[i-1].slice(-overlap)` 得到的是「上一片全文 + 更早一片的尾巴」，
 * 不匹配任何前缀，于是每片的重叠都原样留下 —— 一整轮迁移下来，
 * 原文里每一行都会被重复一次（2026-10-29 就踩了这个：711 片 → 19 片，
 * 但每一行都变成了两行）。所以这里改成迭代还原，用上一块的真实内容当基准。
 *
 * 原文没有落库（`documents` 只存元信息），这是唯一能就地修复历史文档的办法；
 * 代价是原始空行位置丢失，但重新切分不依赖它。
 */
export function joinChunks(contents: string[], overlap = 80): string {
  const blocks: string[] = [];
  let prev = '';
  for (const c of contents) {
    let s = String(c || '');
    if (prev && overlap > 0) {
      const tail = prev.slice(-overlap);
      if (tail && s.startsWith(tail)) s = s.slice(tail.length);
    }
    s = s.replace(/^\n+/, '').trim();
    blocks.push(s);
    prev = s;
  }
  return blocks.filter(Boolean).join('\n\n');
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9一-龥]+/i)
    .filter(Boolean);
}

/** 高频虚词：含它的二元组信息量低，排在候选末尾 */
const STOP_CHARS = new Set(
  '的了着是在和与有这那你我他她它吗呢吧啊把被从对就都也很更最不没要到会能可个些么什怎如何为以所因但而或及同其此该之'.split(''),
);

/**
 * 中文二元组（用于词法候选召回）。
 *
 * 为什么不能直接用 `tokenize()`：它按「非字母数字汉字」切分，
 * 连续汉字会被当成**一个整 token**，于是
 * `ILIKE '%示例新区的设备综合指数同比排名前了几位%'` 必然 0 命中 ——
 * 纯中文问句召回不到任何片段。2026-10-29 用召回探针实测：12 条 answer 用例里 4 条 `hits=0`，
 * 而同一批里带空格/英文的问题（`振动`、`token`）却正常召回，正是这个原因。
 *
 * 返回顺序：纯实词二元组在前，含单个虚词的在后，去掉两字皆虚词的噪声组合。
 */
export function zhBigrams(s: string, max = 10): string[] {
  const strong: string[] = [];
  const weak: string[] = [];
  for (const run of String(s || '').match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      const stopCount = (STOP_CHARS.has(bg[0]) ? 1 : 0) + (STOP_CHARS.has(bg[1]) ? 1 : 0);
      if (stopCount >= 2) continue;
      (stopCount === 1 ? weak : strong).push(bg);
    }
  }
  return Array.from(new Set([...strong, ...weak])).slice(0, max);
}

/**
 * 判断「问题与片段是否真的相关」用的切词：中文按二元组、英文数字按单词。
 * 中文整句作为一个 token 会导致词面重合几乎恒为 0，必须拆成二元组才能识别同义片段里的关键词。
 */
function overlapTokens(s: string): Set<string> {
  const out = new Set<string>();
  const text = String(s || '').toLowerCase();
  for (const w of text.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  for (const run of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 问题与片段的中文二元组 / 英文单词重合比例（0~1） */
export function queryOverlapRatio(query: string, doc: string): number {
  const q = overlapTokens(query);
  if (!q.size) return 0;
  const d = overlapTokens(doc);
  let hit = 0;
  q.forEach((t) => {
    if (d.has(t)) hit++;
  });
  return hit / q.size;
}

/**
 * 相关度闸门（对话用）：
 * 向量分会随模型整体漂移（国产模型 / 本地降级向量常在 0.3~0.5 起步），
 * 只靠 `score > 0` 等于「任何问题都能召回」，于是每条回答都被迫带上参考来源。
 * 这里要求「词面有重合」或「向量分足够高」，无关问题直接不注入资料、也不列来源。
 */
export function filterRelevantHits(
  query: string,
  hits: RetrievalHit[],
  opts: { minOverlap?: number; strongScore?: number } = {},
): RetrievalHit[] {
  const minOverlap = opts.minOverlap ?? 0.1;
  const strongScore = opts.strongScore ?? 0.62;
  return hits.filter((h) => h.score >= strongScore || queryOverlapRatio(query, h.content) >= minOverlap);
}

// 词法召回评分（无向量时的兜底，也用于混合评分）
/**
 * 词法分（0~1，饱和型）。
 *
 * 原来是「查询词的**平均出现次数**」，没有上界：词在片段里重复 13 次就是 13 分，
 * 于是 `0.75×向量 + 0.25×词法` 的融合分能到 3.37 —— 0.62 这个闸门阈值形同虚设，
 * 一个反复出现「接口」二字的目录碎片可以直接压过高分的正文片段。
 * 改成 `raw / (raw + 1)`：单调递增、值域 [0,1)，重复越多仍越靠前，但不会无限放大。
 */
export function lexicalScore(query: string, doc: string): number {
  const q = tokenize(query);
  if (!q.length) return 0;
  const freq = new Map<string, number>();
  for (const w of tokenize(doc)) freq.set(w, (freq.get(w) || 0) + 1);
  let score = 0;
  for (const w of q) score += freq.get(w) || 0;
  const raw = score / q.length;
  return raw / (raw + 1);
}

// 子串包含评分（最稳的兜底：查询短语直接出现在片段中）
function containsScore(query: string, doc: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  return doc.toLowerCase().includes(q) ? 1 : 0;
}

/**
 * 查询扩展：把「2026年5月1日」等中文日期补充为 ISO 形态（2026-05-01 / 2026-5-1 / 2026/5/1），
 * 让表格类数据（日期列通常是 YYYY-MM-DD）能在词法/子串评分中被命中。
 */
function expandQuery(query: string): string {
  const extras: string[] = [];
  const re = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const y = m[1];
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      extras.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      extras.push(`${y}-${mo}-${d}`);
      extras.push(`${y}/${mo}/${d}`);
    }
  }
  return extras.length ? `${query} ${extras.join(' ')}` : query;
}

/**
 * 标定后的融合分（0~1）：向量余弦（主） + 词法重叠（辅）。
 *
 * **这个分数不能随便换口径**：`filterRelevantHits` 的 0.62 闸门就是按它的分布定的，
 * 换成 rerank 分 / RRF 分会让阈值失真（要么放进噪声，要么把正确答案全滤掉）。
 * 因此 RRF 只用来决定「谁进候选池、进池后什么顺序」，score 仍然由这里算出。
 */
export function blendScore(query: string, content: string, vScore: number): number {
  const q2 = expandQuery(query);
  const lex = Math.max(lexicalScore(q2, content), containsScore(q2, content));
  return Number((0.75 * vScore + 0.25 * lex).toFixed(4));
}

/**
 * 本地融合排序：向量余弦（主） + 词法重叠（辅）加权。
 *
 * 这是**兜底排序**，也是 rerank 模型的候选来源：没有 rerank 模型时它就是最终结果，
 * 有 rerank 模型时它负责把候选池收敛到 top-N（cross-encoder 只对少量候选跑得起）。
 * 因此它返回全量排序、不截断，由调用方决定取多少。
 */
function rankLocally(
  query: string,
  cands: { content: string; source: string; vScore: number }[],
): RetrievalHit[] {
  const scored = cands.map((c) => ({
    content: c.content,
    source: c.source,
    score: blendScore(query, c.content, c.vScore),
  }));
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * 倒数排名融合（Reciprocal Rank Fusion, RRF）。
 *
 * 为什么用它，而不是继续加权求和：向量分与词法分**尺度完全不同**且不可比——
 * 向量余弦的分布随 embedding 模型整体漂移（0.3~0.5 起步很常见），词法分是
 * `raw/(raw+1)` 的饱和值。线性加权必须先标定两路分数，换一个 embedding 模型就得重标；
 * RRF 只用**名次**，对尺度免疫，两路怎么打分都不影响融合结果。
 *
 * 这意味着：同一片段在两个列表里都靠前 → 分数累加 → 稳定胜出；
 * 只在单路里冒尖的片段也能进池，不会因为另一路给它低分就被否掉。
 *
 * @param lists 已按「越好越靠前」排好序的若干候选列表（同一条目用 key 对齐）
 * @param k     平滑常数，常用 60：k 越大，名次差异被压得越平，越不容易被单路支配
 */
export function rrfFuse<T>(
  lists: { key: string; item: T }[][],
  opts: { k?: number; limit: number },
): { item: T; score: number; ranks: number[] }[] {
  const k = opts.k ?? 60;
  const acc = new Map<string, { item: T; score: number; ranks: number[] }>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((entry, idx) => {
      // 同一列表内的重复只按最好名次计一次，否则重复条目会刷分
      if (seen.has(entry.key)) return;
      seen.add(entry.key);
      const cur = acc.get(entry.key);
      const add = 1 / (k + idx + 1);
      if (cur) {
        cur.score += add;
        cur.ranks.push(idx);
      } else {
        acc.set(entry.key, { item: entry.item, score: add, ranks: [idx] });
      }
    });
  }
  // 同分时的确定性兜底：先比「在靠前列表里的最好名次」，仍相同则保留插入序
  // （Map 保持插入顺序，sort 在 V8 稳定），保证同一输入永远同一输出。
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || Math.min(...a.ranks) - Math.min(...b.ranks))
    .slice(0, opts.limit)
    .map((x) => ({ item: x.item, score: x.score, ranks: x.ranks }));
}

/**
 * 构造 PG 文本数组字面量（`ARRAY['a','b']::text[]`）。
 *
 * 为什么不用参数占位：这段要嵌进 `unnest(...)` 且与 `sql.raw` 拼接的 kb 过滤条件同处一条 SQL，
 * 参数占位在多段 `sql.raw` 拼接下顺序容易错位。改成显式字面量后，转义责任全在这里：
 * **必须把单引号翻倍**，否则查询词里的 `'` 会截断字符串（注入）。
 * PG 9.1+ 默认 `standard_conforming_strings=on`，反斜杠按字面处理，因此只需处理单引号。
 */
export function pgTextArrayLiteral(values: string[]): string {
  if (!values.length) return `ARRAY[]::text[]`;
  const esc = values.map((v) => `'${String(v).replace(/'/g, "''")}'`);
  return `ARRAY[${esc.join(',')}]::text[]`;
}

/**
 * 词法腿的查询词：英文/数字整词 + 中文二元组。
 *
 * 为什么必须包含二元组：纯中文问句按整句去 `ILIKE` 必然 0 命中（中文没有空格），
 * 这也是内存路径那段注释里踩过的坑。两路合并后再去重、限量，避免把候选池灌满泛词。
 */
export function lexicalTerms(query: string, max = 16): string[] {
  const words = tokenize(query).filter((t) => t.length >= 2 && !/[\u4e00-\u9fa5]/.test(t));
  return Array.from(new Set([...words, ...zhBigrams(query)])).slice(0, max);
}

/**
 * 精排：本地融合排序 → 取 top-N 候选 → 交给 rerank 模型重排 → 取 top-k。
 *
 * 三个刻意的取舍：
 *  - **未配置 rerank 模型时零成本**：直接返回本地排序，不发任何网络请求（`getRerankModel` 返回 null）。
 *  - **候选池放大到 3k / 至少 12**：只把 3~6 篇交给 cross-encoder，等于让它在一堆本来就对的
 *    结果里挑，起不到「把被向量误排的正确答案捞回来」的作用。放大候选池才是精排的价值所在。
 *  - **score 不换成 rerank 分**：`filterRelevantHits` 的 0.62 闸门是按本地融合分定的分布，
 *    而各家 rerank 的分数尺度差异极大（0~1 / logits / 对无关文档也给 0.6）。写回 score 会让
 *    闸门失真——要么放进噪声，要么把正确答案全滤掉。rerank 只决定「选谁、什么顺序」。
 */
async function rerank(
  query: string,
  cands: { content: string; source: string; vScore: number }[],
  k: number,
  /**
   * 已算好分、且已排好序的候选（混合召回路径传入）。
   * 传了就跳过 `rankLocally`：此时顺序来自 RRF，不该再被线性加权覆盖回去。
   */
  prescored?: RetrievalHit[],
): Promise<RetrievalHit[]> {
  const local = prescored ?? rankLocally(query, cands);
  if (local.length <= k) return local.slice(0, k);

  const model = await getRerankModel();
  if (!model) return local.slice(0, k);

  const poolSize = Math.min(local.length, Math.max(k * 3, 12));
  const pool = local.slice(0, poolSize);
  try {
    const order = await rerankDocuments(model, query, pool.map((h) => h.content), k);
    if (!order.length) return local.slice(0, k);
    return order
      .slice(0, k)
      .map((r) => pool[r.index])
      .filter((h): h is RetrievalHit => !!h);
  } catch (e) {
    // 精排是增强项：它挂了不能让检索失败，否则「配了个不可达的 rerank 端点」会直接打断问答
    console.warn(`[rerank] 精排失败，回退本地融合排序：${(e as Error)?.message || e}`);
    return local.slice(0, k);
  }
}

/**
 * 混合检索（支持按知识库选择 embedding 模型）：
 *  - 切片会记录产出向量的模型（`chunks.embedding_model`），不同模型/维度的向量不能混算；
 *  - 按模型分组，每组用「同一个模型」算一次查询向量（MiniMax 要求入库/检索成对）；
 *  - 单一模型组且查询向量维度与 pgvector 列一致时走 `<=>` 索引排序，否则走 JSON 内存余弦；
 *  - 无向量/模型不可用时降级为「词法 + 子串」内存召回，保证相关内容一定能被召回；
 *  - 候选集经 rerank 加权重排后取 top-k。
 */
export async function retrieve(
  query: string,
  limit = 4,
  kbIdOrIds?: string | string[],
): Promise<RetrievalHit[]> {
  /**
   * 范围的三种语义（V8.3 · R6，刻意区分，别再合并）：
   *  - `undefined` / `null`：**不限定**，全库检索。只给评测、巡检这类内部调用用；
   *  - `[]`（或全为空的数组）：调用方算出来的可见范围为空 → **直接返回空**。
   *  - 非空数组：只在这些库里检索。
   *
   * 为什么必须区分后两者：原来的实现把「空数组」和「不传」合并成同一件事——不限定范围。
   * 于是任何一处「按权限算出可见库、结果为空」的调用都会**静默退化成全库扫描**，
   * 越权读别人的个人库。`app/api/knowledge/query/route.ts` 早就用「空则直接返回」绕过了这个坑，
   * 但 `executor.ts`（技能通道）和 `lib/generate.ts`（文档/PPT 生成）都踩着它。
   * 把默认改成 fail-closed 之后，将来再有人忘了传范围，结果是「查不到」而不是「全读到」。
   */
  if (kbIdOrIds !== undefined && kbIdOrIds !== null) {
    const asked = (Array.isArray(kbIdOrIds) ? kbIdOrIds : [kbIdOrIds]).filter(Boolean);
    if (!asked.length) return [];
  }
  const kbIds = (Array.isArray(kbIdOrIds) ? kbIdOrIds : kbIdOrIds ? [kbIdOrIds] : []).filter(Boolean);
  /**
   * 检索结果短时缓存（V8.3 · W2）。
   *
   * 为什么值得：命中文档后仍然要跑「统计 SQL → 向量近邻 → 词法腿 → 精排 HTTP」四段，
   * 其中精排是一次外部网络调用。语义缓存（答案级）在检索**之后**才判定，
   * 所以缓存命中时这些成本已经全部付掉了。
   *
   * 为什么不长：知识库内容随时可能更新，60s 是「同一句话被重复追问」的典型窗口；
   * 超过这个窗口就必须重新检索，否则会拿旧片段回答新入库的内容。
   * `RETRIEVE_CACHE_TTL_MS=0` 可关闭（回到每次真检索）。
   */
  const ttl = (() => {
    const raw = process.env.RETRIEVE_CACHE_TTL_MS;
    if (raw !== undefined && raw.trim() !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 60_000;
  })();
  const cacheKey = ttl > 0 ? `${limit}\u0000${kbIds.slice().sort().join(',')}\u0000${query}` : '';
  if (cacheKey) {
    const hit = retrieveCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) return hit.hits;
  }

  const hits = await retrieveUncached(query, limit, kbIds);
  if (cacheKey) {
    retrieveCache.set(cacheKey, { at: Date.now(), hits });
    if (retrieveCache.size > RETRIEVE_CACHE_MAX) {
      const oldest = retrieveCache.keys().next();
      if (!oldest.done) retrieveCache.delete(oldest.value);
    }
  }
  return hits;
}

/** 检索结果短时缓存容器（进程内；多实例各自一份，不影响正确性） */
const RETRIEVE_CACHE_MAX = 200;
const retrieveCache = new Map<string, { at: number; hits: RetrievalHit[] }>();

/** 知识库内容变更后清空（重新索引 / 删除文档时调用） */
export function clearRetrieveCache(): void {
  retrieveCache.clear();
}

async function retrieveUncached(
  query: string,
  limit: number,
  kbIds: string[],
): Promise<RetrievalHit[]> {
  const inKb = kbIds.length ? inArray(chunks.kbId, kbIds) : undefined;
  const whereSql = kbIds.length
    ? ` AND c.kb_id IN (${kbIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',')})`
    : '';

  // 同一模型在本次检索里只算一次查询向量（云端 embedding 按量计费）
  const qCache = new Map<string, number[] | null>();
  const getQueryVector = async (ref: string): Promise<number[] | null> => {
    if (qCache.has(ref)) return qCache.get(ref)!;
    let vec: number[] | null = null;
    try {
      vec = (await embedQueryForModel(ref, query))?.vec ?? null;
    } catch {
      vec = null;
    }
    qCache.set(ref, vec);
    return vec;
  };

  // —— pgvector 快路径 ——
  // 仅当库内向量只来自「同一个模型」且全部写进了向量列时才能用一条查询向量排序：
  // 多模型 / 维度不一致（只存了 JSON）必须按组分别算向量，走下面的内存路径。
  if (isVectorSupported()) {
    try {
      // 必须经 db.execute 执行。写成 `await sql\`...\`` 是**不会跑查询**的：
      // drizzle 的 sql 是 SQL 片段对象（thenable 只返回自身），await 它得到的仍是 SQL 对象，
      // 于是 stat[0] 恒为 undefined、`Number(st.total) > 0` 恒为 false ——
      // 快路径成了死代码。`as unknown as` 把这个错误从类型系统里挡掉了，
      // 而它又只在 isVectorSupported() 为真时才执行，所以本机从未跑到、也从未暴露。
      const stat = (await db.execute(sql`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE c.embedding_vec IS NULL) AS json_only,
               count(DISTINCT c.embedding_model) AS models,
               min(c.embedding_model) AS model
        FROM chunks c
        WHERE c.embedding IS NOT NULL ${sql.raw(whereSql)}
      `)) as unknown as {
        total: number | string;
        json_only: number | string;
        models: number | string;
        model: string | null;
      }[];
      const st = stat[0];
      if (st && Number(st.total) > 0 && Number(st.json_only) === 0 && Number(st.models) <= 1) {
        const ref = normalizeEmbeddingRef(st.model);
        const q = await getQueryVector(ref);
        // 守卫不满足时必须留痕：以前这里静默落到内存路径，
        // 「扩展/列/索引全就绪，但查询向量拿不到」与「根本没装 pgvector」在日志里长得一样，
        // 排障只能靠猜。这条日志把降级原因和可比对维度直接写出来。
        if (!q || q.length !== EMBED_DIM) {
          console.warn(
            `[rag] path=memory reason=query_embedding_unavailable ref=${ref} dim=${q?.length ?? 0}/${EMBED_DIM}`,
          );
        }
        if (q && q.length === EMBED_DIM) {
          const lit = `[${q.join(',')}]`;
          const poolN = Math.max(limit * 3, 12);
          /**
           * 距离 → 相似度。这里原来写的是 `1 - (Number(r.dist) || 1)`，
           * 而 `Number('0') || 1` 会得到 1 —— 距离为 0（完全相同的向量）反倒被算成相似度 0，
           * 一模一样的片段被排到最后。用 isFinite 判空，别用 `||` 兜默认值。
           */
          const vScoreOf = (d: unknown): number => {
            const n = Number(d);
            return Number.isFinite(n) ? 1 - n : 0;
          };

          // 腿 A：向量近邻（pgvector `<=>` 索引排序）
          const vecRows = (await db.execute(sql`
            SELECT c.id, c.content, d.filename,
                   (c.embedding_vec <=> ${lit}::vector) AS dist
            FROM chunks c
            LEFT JOIN documents d ON c.doc_id = d.id
            WHERE c.embedding_vec IS NOT NULL ${sql.raw(whereSql)}
            ORDER BY c.embedding_vec <=> ${lit}::vector
            LIMIT ${poolN}
          `)) as unknown as any[];

          // 腿 B：词法命中。命中计数在 SQL 侧算完，只把 top-N 拿回来，
          // 不把整表或全部候选拉进内存（内存路径正是在这里设了 3000 的硬上限）。
          // 没有词法腿时，快路径只有「语义近邻」一种视角：查询里带确切标识符
          // （振动、温度、错误码、接口名）时，语义相近但没写这个标识符的片段会挤掉真正答案。
          //
          // 成本边界：每条候选要跑「词法项数」次 `ILIKE '%x%'`，是 O(行数 × 词法项数) 的顺序扫描，
          // 走不了索引。知识库在万片级以内没问题；再往上应装 pg_trgm（GIN 支持 `LIKE '%..%'`，
          // 但要求模式 ≥3 字符，中文二元组还需配合 zhparser 才能用上）或改用外部检索。
          // 迁移期/极端数据量下可用 `RAG_HYBRID=off` 一键退回纯向量召回，不必改代码。
          const terms = process.env.RAG_HYBRID === 'off' ? [] : lexicalTerms(query);
          let lexRows: any[] = [];
          if (terms.length) {
            try {
              lexRows = (await db.execute(sql`
                SELECT s.id, s.content, s.filename, s.dist
                FROM (
                  SELECT c.id, c.content, d.filename,
                         (c.embedding_vec <=> ${lit}::vector) AS dist,
                         (SELECT count(*) FROM unnest(${sql.raw(pgTextArrayLiteral(terms))}) AS t
                           WHERE c.content ILIKE '%' || t || '%') AS hits
                  FROM chunks c
                  LEFT JOIN documents d ON c.doc_id = d.id
                  WHERE c.embedding_vec IS NOT NULL ${sql.raw(whereSql)}
                ) s
                WHERE s.hits > 0
                ORDER BY s.hits DESC
                LIMIT ${poolN}
              `)) as unknown as any[];
            } catch (e) {
              // 词法腿是增强项：失败只降级为纯向量召回，绝不让整个检索挂掉
              console.warn(`[rag] lexical_leg_failed detail=${String((e as Error)?.message || e).slice(0, 160)}`);
            }
          }

          if (vecRows.length) {
            // 按 id 去重后 RRF 融合：两路名次都靠前的片段胜出。
            // 只在单路冒尖的片段也能进池——这正是「语义对的」与「字面对得上的」互相补位。
            const seen = new Set<string>();
            const uniq = (rows: any[]) => {
              const out: { key: string; item: any }[] = [];
              for (const r of rows) {
                const key = String(r.id);
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ key, item: r });
              }
              return out;
            };
            const vecList = uniq(vecRows);
            const lexList = uniq(lexRows);
            const fused = rrfFuse([vecList, lexList], { limit: poolN });
            const hits: RetrievalHit[] = fused.map(({ item }) => ({
              content: item.content,
              source: item.filename || '未知',
              // score 仍是标定口径（0.62 闸门依赖它），RRF 只决定谁进池与顺序
              score: blendScore(query, item.content, vScoreOf(item.dist)),
            }));
            console.info(
              `[rag] path=pgvector vec=${vecRows.length} lex=${lexRows.length} fused=${hits.length} dim=${EMBED_DIM}`,
            );
            return await rerank(query, [], limit, hits);
          }
        }
      }
    } catch (e) {
      // 向量查询异常必须留痕：静默降级会让「扩展装了、列也有，但查询一直失败」
      // 表现为「功能正常只是慢」，排查时完全看不出根因。
      console.warn(`[rag] path=memory reason=pgvector_query_failed detail=${String((e as Error)?.message || e).slice(0, 160)}`);
    }
  }

  // —— 内存路径：按向量来源模型分组，各组用自己的查询向量 ——
  // 安全约束：绝不把整张 chunks 拉进内存。inKb 为空（全局检索，如技能里的 search_knowledge）
  // 时若直接 where(inKb) 会变成全表扫描 + 全量余弦，知识库一大就 OOM。
  // 这里先用词面命中（ILIKE）做候选召回，再在内存里算余弦/重排，
  // 既保证相关性，又把内存上限锁死（硬上限 3000）。无可用词面时直接不召回，避免全表扫描。
  //
  // 召回分两轮，是为了「修一个坑不引入另一个」：
  //  第 1 轮只用英文/数字词（`header`、`振动`、`pm2`）—— 精度高，与修复前的行为一致；
  //  只有召回数量不足时才补中文二元组（纯中文问句在第 1 轮会被整句 ILIKE 打到 0 条）。
  //  若不设这道门槛、直接把二元组混进去，候选池会被「天府/府新/新区」这类泛词灌满，
  //  原本能命中的片段反被挤出 top-k —— 实测 ans-02 就是这样从「答对」退化成「答不出」。
  const exactTokens = Array.from(
    new Set(tokenize(query).filter((t) => t.length >= 2 && !/[\u4e00-\u9fa5]/.test(t))),
  );
  const runCandidateQuery = async (tokens: string[]) => {
    const lexicalCond = tokens.length
      ? or(...tokens.map((t) => ilike(chunks.content, `%${t}%`)))
      : sql`1=0`;
    return db
      .select({
        id: chunks.id,
        content: chunks.content,
        embedding: chunks.embedding,
        embeddingModel: chunks.embeddingModel,
        filename: documents.filename,
      })
      .from(chunks)
      .leftJoin(documents, eq(chunks.docId, documents.id))
      .where(inKb ? and(inKb, lexicalCond) : lexicalCond)
      .limit(3000);
  };

  let rows = await runCandidateQuery(exactTokens);
  if (rows.length < Math.max(limit, 4)) {
    const widened = Array.from(new Set([...exactTokens, ...zhBigrams(query)])).slice(0, 12);
    if (widened.length > exactTokens.length) rows = await runCandidateQuery(widened);
  }

  if (!rows.length) return [];

  // 先解出每行的向量及其来源模型，再按模型并行算查询向量（最多几组，互不依赖）
  const parsed: { row: (typeof rows)[number]; emb: number[] | null; ref: string }[] = rows.map((c) => {
    let emb: number[] | null = null;
    try {
      emb = c.embedding ? (JSON.parse(c.embedding) as number[] | null) : null;
    } catch {
      emb = null; // 历史脏数据不影响词法召回
    }
    return { row: c, emb, ref: emb && emb.length ? normalizeEmbeddingRef(c.embeddingModel) : '' };
  });
  const refs = Array.from(new Set(parsed.map((p) => p.ref))).filter((r): r is string => r.length > 0);
  await Promise.all(refs.map((ref) => getQueryVector(ref)));

  const cands = parsed.map(({ row, emb, ref }) => {
    let v = 0;
    if (emb && ref) {
      const qVec = qCache.get(ref);
      if (qVec) v = cosine(emb, qVec);
    }
    return { content: row.content, source: row.filename || '未知', vScore: v };
  });

  // 兜底过滤：score 为 0 不代表不相关，只代表**打分函数在这个查询上失灵**。
  // 具体场景：片段没有向量（新导入还没算 embedding、或演示模式用本地降级），
  // 此时 blendScore 只剩词法项，而 lexicalScore 走 tokenize——中文整句是一个 token，
  // 与片段几乎不可能重合，分恒为 0。于是真正能答的问题在这里被丢掉，
  // 表现为「知识库明明有这句话，却报告没有找到」（2026-11-13 实测 12 条中文用例 11 条 hits=0）。
  // 因此补一道与分词无关的结构性判据：问题与片段的词面重合够高，就保留。
  // 注意这里**不改 score 口径**——0.62 闸门是按原分布标定的，改口径会让闸门失真。
  const out = (await rerank(query, cands, limit)).filter(
    (c) => c.score > 0 || queryOverlapRatio(query, c.content) >= 0.1,
  );
  // 全部 score 都是 0（纯词法场景）时，rerank 的排序信息为空，结果顺序取决于 SQL 返回顺序，
  // 也就是「谁先被扫到谁靠前」。这里按词面重合度重排，保证最相关的片段进得了 top-k——
  // 否则回答器拿到的是一堆无关片段里夹着一条答案，抽取大概率抽错。
  if (out.length > 1 && out.every((h) => h.score === 0)) {
    return out
      .map((h) => ({ h, ov: queryOverlapRatio(query, h.content) }))
      .sort((a, b) => b.ov - a.ov)
      .map((x) => x.h);
  }
  return out;
}
