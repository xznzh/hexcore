import { db } from '../db';
import { memories, messages } from '../schema';
import { eq, ilike, or, and } from 'drizzle-orm';
import { embedText, cosine } from './embed';
import { newId } from '../util';
import { resolveModelForTask } from '../llm';
import { callModel } from '../llm-gateway';

// 单类记忆候选硬上限：避免团队记忆膨胀时把整张表拉进内存（检索只需最相关的若干条）。
const MEMORY_CANDIDATE_CAP = 500;

export type MemoryItem = {
  content: string;
  type: string;
  scope: string;
  credibility?: string;
  sourceType?: string;
  /**
   * 证据已失效（V8.3 · O4）。
   *
   * `evidence_version` 存的是「抽取这条记忆时依据的消息 id」。消息被删/被编辑截断后，
   * 这条记忆的依据就不存在了——但它在结构上看起来和正常记忆一模一样。
   * 这里只打标不丢弃：用户看到的应该是「这条结论的依据已变更，需重新核实」，
   * 而不是「记忆凭空消失了」（后者会让人以为系统在丢数据）。
   */
  stale?: boolean;
};

/**
 * 检索与 query 相关的长期记忆（个人 + 团队共享），并返回类型/作用域。
 * 优先用 embedding 余弦相似度；无向量时回退关键词包含判断。
 */
export async function retrieveMemories(
  query: string,
  userId: string,
  projectId?: string | null,
  limit = 5,
): Promise<MemoryItem[]> {
  // 词面预筛：用查询里的高频词（≥2 字）做 ILIKE，只召回可能相关的记忆，避免全表拉取。
  // 查不到可用词面（如纯标点）时退化为「按类上限取最近若干条」，仍保证内存有界。
  const qTok = Array.from(
    new Set((query.toLowerCase().match(/[a-z0-9_一-龥]{2,}/g) || [])),
  ).slice(0, 8);
  const lexOr = qTok.length > 0 ? or(...qTok.map((t) => ilike(memories.content, `%${t}%`))) : null;
  /**
   * 证据版本校验直接并进同一条查询（LEFT JOIN messages），不加往返。
   *
   * 为什么不先查记忆再单独查一次消息：记忆检索在对话首字路径上，
   * 每次多一次 DB 往返就是白加的延迟。JOIN 在 text 主键上做，代价可忽略。
   */
  const sel = (cond: any) =>
    db
      .select({ m: memories, ev: messages.id })
      .from(memories)
      .leftJoin(messages, eq(messages.id, memories.evidenceVersion))
      .where(lexOr ? and(cond, lexOr) : cond)
      .limit(MEMORY_CANDIDATE_CAP);

  // 三类候选互不依赖，并行拉取（原来是三次串行 await）
  const [team, mine, proj] = await Promise.all([
    sel(eq(memories.scope, 'team')),
    sel(eq(memories.userId, userId)),
    projectId ? sel(eq(memories.projectId, projectId)) : Promise.resolve([] as any[]),
  ]);
  type MemRow = (typeof team)[number];
  const dedup = new Map<string, MemRow>();
  for (const r of [...team, ...mine, ...proj] as MemRow[]) dedup.set(r.m.id, r);
  // V8 · 记忆治理：过滤已失效（expiresAt 过期）的条目，避免旧结论继续影响回答
  const nowTs = Date.now();
  const rows = [...dedup.values()].filter((r) => r.m.expiresAt == null || Number(r.m.expiresAt) > nowTs);

  if (!rows.length) return [];

  // V8 · 记忆治理：按可信度加权——未验证的 low 记忆降权，防止推测被当成事实放大
  const credWeight = (c?: string | null) => (c === 'high' ? 1 : c === 'medium' ? 0.85 : 0.6);
  const toItem = (r: MemRow): MemoryItem => ({
    content: r.m.content,
    type: r.m.type,
    scope: r.m.scope,
    credibility: r.m.credibility,
    sourceType: r.m.sourceType,
    // evidence_version 为空 = 历史数据（未接线时期写入的），不算失效
    stale: !!r.m.evidenceVersion && !r.ev,
  });
  const hasVector = rows.some((r) => !!r.m.embedding);
  let scored: { item: MemoryItem; score: number }[];
  if (hasVector) {
    const qv = await embedText(query);
    scored = rows.map((r) => ({
      item: toItem(r),
      score: cosine(r.m.embedding ? (JSON.parse(r.m.embedding) as number[]) : null, qv) * credWeight(r.m.credibility),
    }));
  } else {
    const q = query.toLowerCase();
    scored = rows.map((r) => ({
      item: toItem(r),
      score: (r.m.content.toLowerCase().includes(q) ? 1 : 0) * credWeight(r.m.credibility),
    }));
  }
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

/**
 * 从一段对话中自动抽取可沉淀的长期记忆（事实/偏好/约束）。
 * 由大模型产出 JSON 数组；与已有记忆做相似去重后入库。best-effort，失败不影响主流程。
 */
export async function extractMemories(
  userId: string,
  userText: string,
  assistantText: string,
  opts: {
    /**
     * 证据版本（V8.3 · O4）：本轮依据的消息 id。
     * 消息被删除/被编辑截断后，这条记忆的 `stale` 标记就会亮起来。
     */
    evidenceVersion?: string;
    /** 客户端断连后不再继续跑这条尾随调用（V8.3 · R1） */
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  if (!userText || userText.length < 12) return 0;
  if (opts.signal?.aborted) return 0;
  try {
    // V8 · C1：记忆抽取是纯结构化输出（一段对话 → JSON 数组），不需要主模型的推理深度，
    // 走可降档任务；MODEL_TIERING=off 时自动回退主模型。
    const { model } = await resolveModelForTask('memory-extract');
    if (!model) return 0;
    const prompt = [
      '从下面的对话中，抽取值得长期记住的条目。每条输出一个对象：{"type":"fact"|"episodic","content":"..."}。',
      'fact = 稳定的事实/偏好/约束（如“用户偏好中文回复”“项目使用 PostgreSQL”）；',
      'episodic = 具体经历/事件（如“上周完成了 v2 上线”“客户 A 反馈了性能问题”）。',
      '只抽取明确、稳定、可复用的内容，忽略一次性问答。',
      '输出严格 JSON 数组，例如：[{"type":"fact","content":"用户偏好中文回复"}]。若无有价值内容，输出 []。不要输出其他内容。',
      '',
      `用户：${userText.slice(0, 1500)}`,
      `助手：${assistantText.slice(0, 1500)}`,
    ].join('\n');

    const { text } = await callModel({
      model,
      label: 'memory-extract',
      system: '你是记忆抽取器。',
      prompt,
      userId,
      // R1：尾随调用也要能被断连中止；原来没有 signal，用户关页面后它照跑照计费
      signal: opts.signal,
    });

    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return 0;
    const raw = JSON.parse(m[0]);
    if (!Array.isArray(raw) || !raw.length) return 0;

    const items = raw
      .map((x: any) =>
        typeof x === 'string'
          ? { type: 'fact', content: x }
          : { type: x?.type === 'episodic' ? 'episodic' : 'fact', content: String(x?.content || '') },
      )
      .filter((x: any) => x.content.trim().length >= 4);

    // 与已有个人记忆去重（余弦 > 0.92 视为重复）
    const existing = await db.select().from(memories).where(eq(memories.userId, userId));
    let added = 0;
    for (const it of items.slice(0, 8)) {
      const c = it.content.trim();
      const vec = await embedText(c).catch(() => null);
      let dup = false;
      for (const e of existing) {
        if (e.content === c) { dup = true; break; }
        if (vec && e.embedding) {
          const ev = JSON.parse(e.embedding) as number[];
          if (cosine(vec, ev) > 0.92) { dup = true; break; }
        }
      }
      if (dup) continue;
      await db.insert(memories).values({
        id: newId('mem'),
        userId,
        scope: 'personal',
        type: it.type,
        content: c,
        embedding: vec ? JSON.stringify(vec) : null,
        // V8 · 记忆治理：自动抽取的记忆默认「低可信 + 未验证」，episodic 设 180 天失效
        credibility: 'low',
        sourceType: 'extracted',
        // V8.3 · O4：字段此前「有列、有 ADD COLUMN、注释写着版本变更即失效，但全仓无读写点」。
        // 现在写入的是证据消息 id；检索侧 LEFT JOIN 校验它是否还在。
        evidenceVersion: opts.evidenceVersion || null,
        expiresAt: it.type === 'episodic' ? Date.now() + 180 * 24 * 3600 * 1000 : null,
        createdAt: Date.now(),
      });
      added++;
    }
    return added;
  } catch {
    return 0;
  }
}
