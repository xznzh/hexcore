/**
 * pgvector 快路径「端到端」验证（真实 PG + 真实 retrieve + 真实 `<=>` SQL）。
 *
 * 为什么单独一个文件：常规单测必须零 I/O、任何机器都能跑；而这条用例要连真实
 * PostgreSQL 并读 `.env.local`，所以默认跳过，只有显式设置 QA_PGVECTOR_E2E=1 才执行：
 *
 *   QA_PGVECTOR_E2E=1 npx vitest run tests/pgvector-e2e.test.ts --config vitest.config.mts
 *
 * 为什么用 `embedding_model='local'`：2026-11-09 第二轮实测里，云端 MiniMax embedding
 * 查询向量超时（30s），问答退回内存路径，导致「装了 pgvector 却没走到 `<=>`」始终只有
 * 静态证据。这里改用系统自带的本地确定性降级向量（localVector，维度=EMBED_DIM），
 * 在隔离库造同源切片，于是**检索链路每一步都是真的**：守卫统计、`<=>` 排序、rerank、
 * 结构化日志。它没有验证云端 embedding 端点的可用性——那是另一件事，报告里分开标注。
 *
 * 隔离保证：只连 QA_DATABASE_URL（默认 aap_qa_conv 隔离库），只写 kb_pgv_e2e 前缀的
 * 测试数据，执行前后清理自己的数据；业务库零接触。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';

const RUN = process.env.QA_PGVECTOR_E2E === '1';
const QA_DB =
  process.env.QA_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aap_qa_conv';
const KB = 'kb_pgv_e2e';
const DOC = 'doc_pgv_e2e';

describe.skipIf(!RUN)('pgvector 快路径端到端（真实 PG / 本地同源向量）', () => {
  let sql: any;
  let retrieve: (q: string, limit?: number, kb?: string | string[]) => Promise<any[]>;
  let embedDim = 0;
  let supported = false;
  // 不用 vi.spyOn：vitest 自身会接管 console，测试内的 spy 可能收不到模块里的调用。
  // 直接替换方法并在 afterAll 还原，是这类「验证结构化日志」用例更可靠的做法。
  const captured: string[] = [];
  let origInfo: typeof console.info;
  let origWarn: typeof console.warn;

  beforeAll(async () => {
    origInfo = console.info;
    origWarn = console.warn;
    console.info = (...a: any[]) => { captured.push(a.map(String).join(' ')); };
    console.warn = (...a: any[]) => { captured.push(a.map(String).join(' ')); };
    // db.ts 在模块加载时就读取 env 创建连接池，所以必须先注入再动态 import。
    // 这里只填「尚未设置」的键，命令行显式传入的 QA_DATABASE_URL 优先。
    try {
      for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !/^\s*#/.test(line) && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      /* 无 .env.local 时用默认连接串，由调用方保证 */
    }
    process.env.DATABASE_URL = QA_DB;

    const postgres = (await import('postgres')).default;
    sql = postgres(QA_DB, { max: 2, connect_timeout: 5 });
    const embed = await import('../lib/ai/embed');
    embedDim = embed.EMBED_DIM;
    const dbmod = await import('../lib/db');
    await dbmod.ensureInit();
    supported = dbmod.isVectorSupported();
    ({ retrieve } = await import('../lib/ai/rag'));

    // —— 造数：只写 JSON 向量 + 同源 embedding_model='local'，向量列直接给字面量 ——
    // 存量回填逻辑已在第二轮隔离库实测（3/3 回填），本用例聚焦快路径是否真的执行。
    const uid = (await sql`select id from users limit 1`)[0]?.id;
    await sql`delete from chunks where kb_id = ${KB}`;
    await sql`delete from documents where kb_id = ${KB}`;
    await sql`delete from knowledge_bases where id = ${KB}`;
    await sql`insert into knowledge_bases (id,name,scope,owner_id,embedding_model,created_at)
              values (${KB},'pgvector 快路径验证库','team',${uid},'local',${Date.now()})`;
    await sql`insert into documents (id,kb_id,filename,status,chunk_count,created_at)
              values (${DOC},${KB},'设备状态周报-向量验证.txt','indexed',3,${Date.now()})`;
    const texts = [
      '示例新区未来七天运行状态预报：综合指数同比排名情况与主要异常项读数变化。',
      '本周温度与湿度读数监测结果，达标天数比例及同比对照说明。',
      '设备状态重污染天气应急预警的启动条件、响应流程与解除标准。',
    ];
    for (let i = 0; i < texts.length; i++) {
      const vec = embed.localVector(texts[i]);
      const lit = `[${vec.join(',')}]`;
      await sql`insert into chunks (id,doc_id,kb_id,content,idx,embedding,embedding_model,embedding_vec)
                values (${`ck_pgv_e2e_${i + 1}`},${DOC},${KB},${texts[i]},${i},${JSON.stringify(vec)},'local',${lit}::vector)`;
    }
  }, 120_000);

  afterAll(async () => {
    if (origInfo) console.info = origInfo;
    if (origWarn) console.warn = origWarn;
    if (!sql) return;
    await sql`delete from chunks where kb_id = ${KB}`;
    await sql`delete from documents where kb_id = ${KB}`;
    await sql`delete from knowledge_bases where id = ${KB}`;
    await sql.end();
  });

  it('守卫条件满足时真实执行 <=> 排序并打印 path=pgvector', async () => {
    expect(supported).toBe(true);
    const st = await sql`select count(*)::int total,
      count(*) filter (where embedding_vec is null)::int json_only,
      count(distinct embedding_model)::int models,
      min(embedding_model) as model,
      max(vector_dims(embedding_vec))::int dim from chunks where kb_id = ${KB}`;
    expect(st[0]).toMatchObject({ total: 3, json_only: 0, models: 1, model: 'local', dim: embedDim });

    let hits: any[] = [];
    hits = await retrieve('未来七天设备状态综合指数同比排名怎么样', 3, KB);
    const ragLogs = captured.filter((l) => l.startsWith('[rag]'));
    // 日志同时打出两路召回数量：vec=0 或 lex=0 说明某一路没跑起来（例如词法腿 SQL 报错被降级），
    // 只断言 path=pgvector 会漏掉「快路径在跑、但混合召回其实只剩一条腿」这种半失效。
    expect(ragLogs.some((p) => /\[rag\] path=pgvector vec=\d+ lex=\d+ fused=\d+ dim=\d+/.test(p)), `实际日志: ${ragLogs.join(' | ') || '(无)'}`).toBe(true);
    expect(ragLogs.some((p) => /\[rag\] path=pgvector vec=\d+ lex=[1-9]\d*/.test(p)), `词法腿未召回任何片段，实际日志: ${ragLogs.join(' | ') || '(无)'}`).toBe(true);
    expect(Array.isArray(hits)).toBe(true);
  }, 120_000);
});
