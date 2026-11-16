/**
 * 检索路径判定（纯函数，无 I/O）。
 *
 * 为什么单独成文件：`rag.ts` 有两条检索路径——pgvector 的 `<=>` 索引排序，和内存 JSON 余弦兜底。
 * 但本机从未装过 pgvector 扩展，意味着**快路径一次也没执行过**：代码在、类型对、就是不跑。
 * 这不是「降级路径腐化」（某天救命时才发现坏了），是更隐蔽的「主路径腐化」——
 * 哪天在装了 pgvector 的环境部署，那条路径第一次执行就是首次上生产，且没有索引、没有压测。
 *
 * 所以这里把「到底走哪条路、为什么」做成可判定的：
 *  - 判定逻辑抽成纯函数，能用单测锁住（**不能**让「多模型混算」这种错误悄悄通过）
 *  - 真实查询放在 `/api/health/retrieval`，打开就能看到当前状态，不用读代码猜
 *
 * 判定顺序刻意与 `rag.ts` 的守卫链一致：先看能力，再看数据形状，最后才允许走快路径。
 * 任何一条不满足都返回 memory——宁可慢，不可混算。
 */

export type RetrievalPath = 'pgvector' | 'memory';

export type PathInput = {
  /** pgvector 扩展与 embedding_vec 列是否可用 */
  vectorSupported: boolean;
  /** 有 JSON 向量的切片数（总量口径） */
  indexedChunks: number;
  /** 其中「只有 JSON 向量、没写进向量列」的切片数 */
  jsonOnlyChunks: number;
  /** 这些切片来自几个不同的 embedding 模型 */
  distinctModels: number;
  /**
   * 向量列维度是否等于当前 EMBED_DIM。
   * 维度不一致时查询向量与列无法比较，必须整表回退内存。
   */
  vectorDimOk: boolean;
};

export type PathVerdict = {
  path: RetrievalPath;
  /** 给人看的原因，直接可展示在诊断页上 */
  reason: string;
};

export function decideRetrievalPath(i: PathInput): PathVerdict {
  if (!i.vectorSupported) {
    return {
      path: 'memory',
      reason: 'pgvector 扩展或 embedding_vec 列不可用，检索全部走内存余弦（功能正常，只是慢）',
    };
  }
  if (i.indexedChunks === 0) {
    return { path: 'memory', reason: '库里还没有任何带向量的切片，只能靠词面召回' };
  }
  if (!i.vectorDimOk) {
    return {
      path: 'memory',
      reason: 'embedding_vec 列维度与当前 EMBED_DIM 不一致，查询向量无法与列比较',
    };
  }
  if (i.jsonOnlyChunks > 0) {
    return {
      path: 'memory',
      reason: `有 ${i.jsonOnlyChunks} 个切片只存了 JSON 向量（未写入向量列），无法用单个查询向量排序`,
    };
  }
  if (i.distinctModels > 1) {
    return {
      path: 'memory',
      reason: `存在 ${i.distinctModels} 个不同 embedding 模型的向量，不同模型的向量不能混算`,
    };
  }
  return { path: 'pgvector', reason: '单一模型、向量列齐备且维度一致，走 HNSW 索引排序' };
}
