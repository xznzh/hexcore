/**
 * 向量维度：与 embedding 模型输出保持一致，pgvector 列按此维度建。
 * 默认 384（内置本地降级向量）；用云端 embedding（1024/1536/2048 维）且启用 pgvector 时显式设置 EMBED_DIM。
 * 改动后启动会重建向量列、清空 JSON 向量并把受影响文档标记为「待索引」，重新索引即可。
 */
export const EMBED_DIM = (() => {
  const n = Number(process.env.EMBED_DIM);
  if (!Number.isFinite(n) || n <= 0) return 384;
  return Math.min(4096, Math.max(64, Math.floor(n)));
})();
