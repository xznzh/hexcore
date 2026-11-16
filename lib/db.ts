import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from './schema';
import { models, chunks, skills } from './schema';
import { encryptText, safeDecrypt } from './crypto';
import { EMBED_DIM } from './ai/embed-dim';
import { DEMO_MODEL_ID, DEMO_PROVIDER, demoModeFlag } from './ai/demo';
import { DEMO_KB_ID, DEMO_KB_NAME, DEMO_DOC_ID, DEMO_DOC_NAME, demoChunks } from './ai/demo-seed';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ai_agent_platform';

// 开发态复用同一个连接池：next dev 热更新会重新执行本模块，
// 若每次都 new 一个 pool（max 5），改动几十次就会耗尽 PostgreSQL 的 max_connections，
// 表现为接口 500（too many clients）。生产环境只执行一次，无需挂载到 globalThis。
const globalForDb = globalThis as unknown as { __pgClient?: ReturnType<typeof postgres> };
const client = globalForDb.__pgClient ?? postgres(DATABASE_URL, { max: 5 });
if (process.env.NODE_ENV !== 'production') globalForDb.__pgClient = client;

// 说明：drizzle-orm 0.36 的 $inferInsert 会把带 .default() / nullable 的列从 insert 类型中丢弃，
// 导致写操作出现“属性不存在”的类型错误（运行时正常）。demo 阶段将 db 设为宽松类型以关闭该过度检查。
export const db = drizzle(client, { schema }) as any;

/**
 * 优雅关闭：释放 PG 连接池。
 *
 * 为什么需要：滚动发布时旧 Pod 若不主动 end()，连接要等 TCP 超时才被 PG 回收。
 * max_connections 被占满时，新 Pod 启动的第一个请求就会 500（too many clients），
 * 表现为「新版本一直起不来」，而日志里只有一句连接错误。
 */
export async function closeDb(timeoutSec = 5): Promise<void> {
  try {
    await client.end({ timeout: timeoutSec });
  } catch {
    /* 已关闭 / 连接已断：忽略 */
  }
}

// pgvector 支持探测：扩展/向量列可用则为 true，否则降级为内存 JSON 余弦。
let vectorSupported: boolean | null = null;
/** 探测失败的具体原因（区分「没装扩展」与「装了但用不了」） */
let vectorError: string | null = null;
/** 启动时未执行成功的结构语句（缺字段/缺索引），供诊断接口展示 */
let schemaIssues: string[] = [];

export function isVectorSupported(): boolean {
  return vectorSupported === true;
}

/** 向量能力与结构自检状态：给 /api/health/retrieval 用，不参与业务逻辑 */
export function getDbSelfCheck(): { vectorSupported: boolean | null; vectorError: string | null; schemaIssues: string[] } {
  return { vectorSupported, vectorError, schemaIssues };
}

// 将 number[] 转为 pgvector 字面量（过滤非法值，防止注入/类型错误）
export function toVectorLiteral(arr: number[]): string {
  return (
    '[' +
    arr
      .map((n) => (typeof n === 'number' && isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0))
      .join(',') +
    ']'
  );
}

// 写入切片向量：支持向量列则双写 embedding_vec + embedding(JSON)，否则只写 JSON。
// 同时记录产出该向量的模型 id（'local' 表示本地降级），检索时按模型分组算查询向量。
// 注意：pgvector 列维度由 EMBED_DIM 决定；模型输出维度不符时自动降级为「JSON 向量 + 内存余弦检索」，功能不受影响。
export async function saveChunkEmbedding(chunkId: string, vec: number[], modelId: string): Promise<void> {
  const lit = toVectorLiteral(vec);
  const json = JSON.stringify(vec);
  try {
    if (isVectorSupported() && vec.length === EMBED_DIM) {
      await client.unsafe(
        `UPDATE chunks SET embedding_vec = $1::vector, embedding = $2, embedding_model = $3 WHERE id = $4`,
        [lit, json, modelId, chunkId],
      );
    } else {
      await db.update(chunks).set({ embedding: json, embeddingModel: modelId }).where(eq(chunks.id, chunkId));
    }
  } catch {
    /* 单条失败不影响整体 */
  }
}

// 现有表新增列的兼容迁移（幂等，已存在则跳过）
const ALTER_STMTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota INTEGER NOT NULL DEFAULT 1073741824;`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id TEXT;`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources TEXT;`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta TEXT;`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunk_count INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding TEXT;`,
  `ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS project_id TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS over_quota_action TEXT NOT NULL DEFAULT 'block';`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_threshold INTEGER NOT NULL DEFAULT 80;`,
  // 会话版本号：密码重置/账号禁用时 +1，使所有已签发 JWT 立即失效（见 lib/auth.ts getSession）
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE models ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;`,
  `ALTER TABLE models ADD COLUMN IF NOT EXISTS price_in INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE models ADD COLUMN IF NOT EXISTS price_out INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary TEXT;`,
  // V8.3 · W3：摘要水位线（已摘要的最后一条消息 createdAt），支撑增量摘要
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary_upto BIGINT;`,
  `ALTER TABLE skills ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE skill_runs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done';`,
  `ALTER TABLE skill_runs ADD COLUMN IF NOT EXISTS resume_index INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE skill_runs ADD COLUMN IF NOT EXISTS resume_prev TEXT;`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS conversation_id TEXT;`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS trace TEXT;`,
  `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS project_id TEXT;`,
  `ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_id TEXT;`,
  // V8 · 记忆治理：可信度 / 来源 / 证据版本 / 失效时间（老库自动补齐）
  `ALTER TABLE memories ADD COLUMN IF NOT EXISTS credibility TEXT NOT NULL DEFAULT 'low';`,
  `ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'extracted';`,
  `ALTER TABLE memories ADD COLUMN IF NOT EXISTS evidence_version TEXT;`,
  `ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at BIGINT;`,
  `ALTER TABLE skills ADD COLUMN IF NOT EXISTS project_id TEXT;`,
  `ALTER TABLE schedules ADD COLUMN IF NOT EXISTS project_id TEXT;`,
  // P0 能力底座：连接器生命周期字段
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`,
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS spec_url TEXT;`,
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS base_url TEXT;`,
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown';`,
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS health_at BIGINT;`,
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS last_error TEXT;`,
  // V8.5：MCP 工具审批策略（auto | always | never），老库默认 auto，行为变化见 approval.ts 注释
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS mcp_approval TEXT NOT NULL DEFAULT 'auto';`,
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS discovered_at BIGINT;`,
  `ALTER TABLE connectors ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;`,
  // P0 能力底座：调用审计增强
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS status TEXT;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS detail TEXT;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS tokens INTEGER;`,
  // V8.10 · 日志结构化：把「靠字符串反解」的字段落成真列
  // trace_id 之前只作为 `[trace:xxx] ` 前缀塞在 detail 里，按链路查日志等于全表 LIKE；
  // model/label/ok/token 之前靠 `split_part(target,' | ',n)`，模型名带分隔符就静默错位。
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS trace_id TEXT;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS model TEXT;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS label TEXT;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS ok BOOLEAN;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;`,
  `ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;`,
  // 能力调用：同步 / 异步（长任务）
  `ALTER TABLE capability_operations ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'sync';`,
  // 能力协议扩展元数据（签名/异步/产物声明），老库自动补齐
  `ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS meta TEXT NOT NULL DEFAULT '{}';`,
  // 注意：usage 的「重复行合并 + DELETE」原先是这里的两条 DML（V8.2 已移出启动路径）。
  // 启动时无条件全表扫 + 删行，等于让每次进程重启都付出一次写放大，且一旦误删无法回滚。
  // 现改为一次性脚本：node scripts/migrate-usage-dedupe.mjs（幂等，执行后会重建唯一索引）。
];

const CREATE_STMTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active', monthly_limit INTEGER NOT NULL DEFAULT 1000000,
    storage_quota BIGINT NOT NULL DEFAULT 1073741824, token_version INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT,
    api_key TEXT, capabilities TEXT NOT NULL DEFAULT '[]',
    visible_roles TEXT NOT NULL DEFAULT '["admin","member"]',
    is_default BOOLEAN NOT NULL DEFAULT false, context_length INTEGER NOT NULL DEFAULT 8192
  );`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '新对话',
    pinned BOOLEAN NOT NULL DEFAULT false, archived BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, model_id TEXT, tokens INTEGER NOT NULL DEFAULT 0,
    sources TEXT, trace TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL,
    rating TEXT NOT NULL, comment TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS knowledge_bases (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'team',
    owner_id TEXT, embedding_model TEXT NOT NULL DEFAULT 'auto',
    created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, kb_id TEXT NOT NULL, filename TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready', chunk_count INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, kb_id TEXT NOT NULL,
    content TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0, embedding TEXT, embedding_model TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'personal',
    project_id TEXT, filename TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    mime TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'personal',
    name TEXT NOT NULL, cron TEXT NOT NULL, target TEXT NOT NULL, prompt TEXT, skill_id TEXT,
    model_id TEXT, notify TEXT NOT NULL DEFAULT 'none', webhook_url TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true, last_run_at BIGINT, last_status TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, owner_id TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'team', created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS project_members (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'personal',
    type TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL, embedding TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'personal',
    name TEXT NOT NULL, description TEXT, steps TEXT NOT NULL DEFAULT '[]', model_id TEXT,
    created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS skill_proposals (
    id TEXT PRIMARY KEY, ref TEXT NOT NULL, source TEXT NOT NULL,
    source_label TEXT, name TEXT NOT NULL, description TEXT, version TEXT, author TEXT,
    security TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]',
    script_files TEXT NOT NULL DEFAULT '[]', body_preview TEXT, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, confirmed_by TEXT,
    skill_id TEXT, created_at BIGINT NOT NULL, confirmed_at BIGINT
  );`,
  `CREATE TABLE IF NOT EXISTS skill_runs (
    id TEXT PRIMARY KEY, skill_id TEXT, owner_id TEXT NOT NULL, input TEXT NOT NULL,
    trajectory TEXT NOT NULL DEFAULT '[]', result TEXT,
    status TEXT NOT NULL DEFAULT 'done', resume_index INTEGER NOT NULL DEFAULT 0, resume_prev TEXT,
    created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS skill_versions (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
    steps TEXT NOT NULL, created_at BIGINT NOT NULL, created_by TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true, visible_roles TEXT NOT NULL DEFAULT '["admin","member"]',
    created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, period TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE IF NOT EXISTS operation_logs (
    id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL,
    target TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'member',
    used BOOLEAN NOT NULL DEFAULT false, used_by TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, status TEXT NOT NULL,
    result TEXT, error TEXT, started_at BIGINT NOT NULL, finished_at BIGINT
  );`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL,
    body TEXT, read BOOLEAN NOT NULL DEFAULT false, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS session_shares (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE, visibility TEXT NOT NULL DEFAULT 'link', shared_with TEXT,
    title TEXT, revoked BOOLEAN NOT NULL DEFAULT false, expires_at BIGINT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT, conversation_id TEXT,
    type TEXT NOT NULL, title TEXT, filename TEXT NOT NULL, path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'personal',
    project_id TEXT, title TEXT NOT NULL, detail TEXT,
    status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL DEFAULT 'manual',
    source_ref TEXT, due_date BIGINT, created_at BIGINT NOT NULL, completed_at BIGINT
  );`,
  `CREATE TABLE IF NOT EXISTS briefings (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL,
    items TEXT NOT NULL DEFAULT '[]', model_used TEXT, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY, connector_id TEXT, key TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, method TEXT NOT NULL DEFAULT 'GET', path TEXT NOT NULL DEFAULT '/',
    parameters TEXT NOT NULL DEFAULT '[]', input_schema TEXT NOT NULL DEFAULT '{}',
    response_mapping TEXT NOT NULL DEFAULT '{}', min_role TEXT NOT NULL DEFAULT 'member',
    requires_approval BOOLEAN NOT NULL DEFAULT false, timeout_ms INTEGER NOT NULL DEFAULT 30000,
    status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT, meta TEXT NOT NULL DEFAULT '{}', created_by TEXT,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS capability_grants (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'capability', target_id TEXT NOT NULL,
    subject_type TEXT NOT NULL DEFAULT 'user', subject_id TEXT NOT NULL, created_at BIGINT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS capability_operations (
    id TEXT PRIMARY KEY, capability_id TEXT, connector_id TEXT, user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running', mode TEXT NOT NULL DEFAULT 'sync',
    input TEXT, output TEXT, error TEXT,
    source TEXT NOT NULL DEFAULT 'api', conversation_id TEXT, approved_by TEXT, approved_at BIGINT,
    duration_ms INTEGER, created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT
  );`,
  // 工具幂等账本（V8.2 · C1）：跨进程/重启后的重放去重。key 是「会话+工具+规范化参数」的稳定哈希。
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT,
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
  );`,
];

// 常用查询索引（D5 性能包）：CREATE INDEX IF NOT EXISTS 本身幂等，老库升级自动补齐。
// 重点：messages(conversation_id, created_at) 是加载会话历史的热路径，缺它则全表扫描排序。
const INDEX_STMTS = [
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, archived);`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_files_conversation ON files(conversation_id);`,
  `CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);`,
  `CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id);`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_message ON feedback(message_id);`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_kb ON chunks(kb_id);`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_todos_user_status ON todos(user_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_skill_runs_owner ON skill_runs(owner_id);`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_shares_conversation ON session_shares(conversation_id);`,
  `CREATE INDEX IF NOT EXISTS idx_capabilities_connector ON capabilities(connector_id, status);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_capabilities_connector_key ON capabilities(connector_id, key);`,
  `CREATE INDEX IF NOT EXISTS idx_capability_grants_target ON capability_grants(scope, target_id);`,
  `CREATE INDEX IF NOT EXISTS idx_capability_ops_user ON capability_operations(user_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_capability_ops_status ON capability_operations(status, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_capability_ops_created ON capability_operations(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_connectors_name ON connectors(name);`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);`,
  `CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_operation_logs_user ON operation_logs(user_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs(action, created_at);`,
  // V8.10：按 traceId 还原链路。partial 索引——历史行（v8.10 之前）trace_id 全为 NULL，
  // 建进索引只是白占空间，而 WHERE trace_id = ? 这类等值查询照样命中。
  `CREATE INDEX IF NOT EXISTS idx_operation_logs_trace ON operation_logs(trace_id, created_at) WHERE trace_id IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_user_period ON usage(user_id, period);`,
  // 幂等账本的过期清理按 expires_at 扫，没有索引会退化成全表扫描（且这表会持续增长）
  `CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);`,
];

let initPromise: Promise<void> | null = null;

/**
 * 预置模型清单（OpenAI 兼容端点，管理员在后台填 API Key 即用）。
 * 也可在 .env.local 里放对应的环境变量（MINIMAX_API_KEY / ZHIPU_API_KEY / DASHSCOPE_API_KEY /
 * HUNYUAN_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY / SENSENOVA_API_KEY / SILICONFLOW_API_KEY）自动带上密钥。
 * 注意：MiniMax 的向量模型 embo-01 不是 OpenAI 兼容协议，见 lib/ai/embed.ts 的单独适配。
 */
function presetModels() {
  const p = (id: string, provider: string, name: string, baseUrl: string, envKey: string, caps: string[], isDefault: boolean, contextLength: number) => ({
    id,
    provider,
    name,
    baseUrl,
    apiKey: encryptText(process.env[envKey] || ''),
    capabilities: JSON.stringify(caps),
    visibleRoles: JSON.stringify(['admin', 'member']),
    isDefault,
    contextLength,
  });
  const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  return [
    // 演示模型：不连外网，回答由 lib/ai/demo.ts 从检索片段里抽取。
    // 刻意不声明 tools 能力——演示模式不做工具调用，声明了只会白白往提示里塞工具说明。
    {
      id: DEMO_MODEL_ID,
      provider: DEMO_PROVIDER,
      name: 'demo-local',
      baseUrl: 'demo://local',
      apiKey: encryptText(''),
      capabilities: JSON.stringify(['chat']),
      visibleRoles: JSON.stringify(['admin', 'member']),
      isDefault: false,
      contextLength: 8192,
    },
    p('m_ollama_llama3_2', 'ollama', 'llama3.2', ollamaBase, 'OLLAMA_API_KEY', ['chat', 'tools'], true, 8192),
    {
      id: 'm_ollama_nomic_embed',
      provider: 'ollama',
      name: 'nomic-embed-text',
      baseUrl: ollamaBase,
      apiKey: encryptText(''),
      capabilities: JSON.stringify(['embedding']),
      visibleRoles: JSON.stringify(['admin']),
      isDefault: false,
      contextLength: 8192,
    },
    p('m_openai_gpt4o_mini', 'openai', 'gpt-4o-mini', 'https://api.openai.com/v1', 'OPENAI_API_KEY', ['chat', 'tools', 'vision'], false, 128000),
    {
      id: 'm_openai_embed',
      provider: 'openai',
      name: 'text-embedding-3-small',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: encryptText(process.env.OPENAI_API_KEY || ''),
      capabilities: JSON.stringify(['embedding']),
      visibleRoles: JSON.stringify(['admin']),
      isDefault: false,
      contextLength: 8192,
    },
    // —— 国产主流模型（均为 OpenAI 兼容端点）——
    p('m_minimax_m2', 'minimax', 'MiniMax-M2', 'https://api.minimax.cn/v1', 'MINIMAX_API_KEY', ['chat', 'tools'], false, 200000),
    p('m_zhipu_glm46', 'zhipu', 'glm-4.6', 'https://open.bigmodel.cn/api/paas/v4', 'ZHIPU_API_KEY', ['chat', 'tools'], false, 128000),
    p('m_qwen_qwen_max', 'qwen', 'qwen-max', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', ['chat', 'tools'], false, 128000),
    p('m_hunyuan_turbos', 'hunyuan', 'hunyuan-turbos-latest', 'https://api.hunyuan.cloud.tencent.com/v1', 'HUNYUAN_API_KEY', ['chat', 'tools'], false, 128000),
    p('m_deepseek_chat', 'deepseek', 'deepseek-chat', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', ['chat', 'tools'], false, 128000),
    p('m_kimi_k2_turbo', 'moonshot', 'kimi-k2-turbo-preview', 'https://api.moonshot.cn/v1', 'MOONSHOT_API_KEY', ['chat', 'tools'], false, 128000),
    p('m_sensenova_sensechat5', 'sensenova', 'SenseChat-5', 'https://api.sensenova.cn/compatible-mode/v2', 'SENSENOVA_API_KEY', ['chat', 'tools'], false, 32768),
    // —— 向量模型（embedding，OpenAI 兼容 /embeddings；仅管理员可见）——
    {
      id: 'm_zhipu_embedding3',
      provider: 'zhipu',
      name: 'embedding-3',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: encryptText(process.env.ZHIPU_API_KEY || ''),
      capabilities: JSON.stringify(['embedding']),
      visibleRoles: JSON.stringify(['admin']),
      isDefault: false,
      contextLength: 2048,
    },
    {
      id: 'm_qwen_embedding_v4',
      provider: 'qwen',
      name: 'text-embedding-v4',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: encryptText(process.env.DASHSCOPE_API_KEY || ''),
      capabilities: JSON.stringify(['embedding']),
      visibleRoles: JSON.stringify(['admin']),
      isDefault: false,
      contextLength: 1024,
    },
    {
      id: 'm_siliconflow_bge_m3',
      provider: 'siliconflow',
      name: 'BAAI/bge-m3',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: encryptText(process.env.SILICONFLOW_API_KEY || ''),
      capabilities: JSON.stringify(['embedding']),
      visibleRoles: JSON.stringify(['admin']),
      isDefault: false,
      contextLength: 1024,
    },
    // MiniMax 向量接口非 OpenAI 兼容（texts/type 字段），由 lib/ai/embed.ts 单独适配。
    // embo-01 输出 1536 维，需同时把 EMBED_DIM 配成 1536。
    {
      id: 'm_minimax_embo01',
      provider: 'minimax',
      name: 'embo-01',
      baseUrl: 'https://api.minimax.cn/v1',
      apiKey: encryptText(process.env.MINIMAX_API_KEY || ''),
      capabilities: JSON.stringify(['embedding']),
      visibleRoles: JSON.stringify(['admin']),
      isDefault: false,
      contextLength: 4096,
    },
  ];
}

/**
 * 预置「内置技能」：随部署幂等注入（ownerId='system' / scope='builtin'）。
 * - 全部步骤只用 llm（planner + worker）或内置 search_knowledge，不依赖外部连接器，开箱即跑；
 * - 末节点固定为 worker，避免以 critic 收尾时最终结果变成校验 JSON；
 * - 内置技能不可被普通用户编辑/删除（/api/skills 的 PATCH/DELETE 按 ownerId 校验天然拦截）。
 */
function presetSkills() {
  const at = Date.parse('2026-01-01T00:00:00Z');
  const mk = (id: string, name: string, description: string, steps: any[]) => ({
    id,
    ownerId: 'system',
    scope: 'builtin',
    projectId: null,
    name,
    description,
    steps: JSON.stringify(steps),
    modelId: null,
    version: 1,
    createdAt: at,
  });
  return [
    mk('skill_builtin_meeting_minutes', '会议纪要整理', '把会议记录/转写整理成结构化纪要：议题、结论、决议、待办（含负责人与截止时间）', [
      { role: 'planner', prompt: '阅读下面的会议记录，判断会议主题，并规划纪要结构（议题、结论、决议、待办）。\n\n{{input}}' },
      {
        role: 'worker',
        prompt:
          '基于会议记录与结构规划，输出结构化会议纪要：\n一、会议主题\n二、议题与讨论要点\n三、主要结论\n四、决议事项\n五、待办清单（事项｜负责人｜截止时间；缺失处标注“待补充”）\n\n要求：只依据原文，不编造未出现的信息。\n\n会议记录：\n{{input}}\n\n结构规划：\n{{prev}}',
      },
    ]),
    mk('skill_builtin_doc_summary', '长文档摘要', '提炼长文档的 TL;DR、核心要点与关键数据', [
      { role: 'planner', prompt: '通读下面的长文档，判断文档类型与摘要重点（结论、数据、风险）。\n\n{{input}}' },
      {
        role: 'worker',
        prompt:
          '输出长文档摘要：\n① 一句话 TL;DR\n② 5-8 条核心要点\n③ 关键数据与结论（仅原文出现过的）\n④ 仍待确认的问题\n\n要求：忠于原文，不臆造。\n\n文档：\n{{input}}\n\n摘要重点规划：\n{{prev}}',
      },
    ]),
    mk('skill_builtin_weekly_report', '周报生成', '把本周工作流水整理成结构化周报：进展、成果、风险、下周计划', [
      { role: 'planner', prompt: '根据本周工作流水，判断汇报对象与重点（进展、成果、风险、计划）。\n\n{{input}}' },
      {
        role: 'worker',
        prompt:
          '输出结构化周报：\n一、本周进展（分项目/事项）\n二、关键成果与数据\n三、风险与阻塞\n四、下周计划\n\n语言简洁，面向团队负责人；无数据的事项不要编造数字。\n\n工作流水：\n{{input}}\n\n规划：\n{{prev}}',
      },
    ]),
    mk('skill_builtin_data_analysis', '数据分析与结论', '对给定的表格/日志/文本数据做分析，给出可执行结论', [
      { role: 'planner', prompt: '判断给出的数据类型（表格/日志/文本）与分析目标。\n\n{{input}}' },
      {
        role: 'worker',
        prompt:
          '对给定数据做分析，输出：\n① 数据概览（规模/字段/时间范围）\n② 趋势、分布与异常（有依据才写）\n③ 3-5 条可执行结论与建议\n④ 为得出更可靠结论还需补充的数据\n\n要求：计算过程可复核，禁止编造数值。\n\n数据：\n{{input}}\n\n分析规划：\n{{prev}}',
      },
    ]),
    mk('skill_builtin_kb_research', '知识库调研', '先检索团队知识库，再基于命中片段给出带来源的调研结论', [
      { role: 'worker', type: 'tool', tool: 'search_knowledge', prompt: '{{input}}' },
      {
        role: 'worker',
        prompt:
          '基于检索到的知识库片段回答问题并给出结论，列出来源；片段不足时明确指出缺失，不要编造。\n\n问题：\n{{input}}\n\n检索片段：\n{{prev}}',
      },
    ]),
    mk('skill_builtin_rewrite', '内容润色改写', '按目标风格润色/改写文本，保留原意并给出修改说明', [
      { role: 'planner', prompt: '判断这段文本的用途与目标风格（正式/口语/精简/扩写）。\n\n{{input}}' },
      {
        role: 'worker',
        prompt:
          '按要求改写文本，保持原意与事实不变。输出：\n① 改写后的正文\n② 三条主要修改说明\n\n原文：\n{{input}}\n\n改写目标：\n{{prev}}',
      },
    ]),
    mk('skill_builtin_code_review', '代码审查与解释', '解释代码作用并审查潜在缺陷、性能与安全问题', [
      { role: 'planner', prompt: '判断代码语言与审查重点（正确性、性能、可读性、安全）。\n\n{{input}}' },
      {
        role: 'worker',
        prompt:
          '输出代码审查结果：\n① 代码作用概述\n② 潜在缺陷/风险（尽量给片段定位）\n③ 可读性与性能建议\n④ 关键修改建议（附示例）\n\n要求：不要臆测未提供的上下文。\n\n代码：\n{{input}}\n\n审查重点：\n{{prev}}',
      },
    ]),
  ];
}

export function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      // 尝试启用 pgvector 扩展（矢量检索）。无权限/无扩展时静默降级为内存 JSON 余弦。
      await client.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {});
      try {
        await client.unsafe(`SELECT '[1,2,3]'::vector`);
        vectorSupported = true;
      } catch (e: any) {
        vectorSupported = false;
        // 记下原因：诊断接口要能区分「环境没装扩展」和「装了但用不了」，
        // 否则遇到后者只会看到一句「不支持」，无从下手。
        vectorError = String(e?.message || e).slice(0, 200);
      }

      for (const stmt of CREATE_STMTS) {
        await client.unsafe(stmt);
      }

      // 下面两类语句全部是 IF NOT EXISTS 幂等写法，**本不该失败**。
      // 原来每条都 `.catch(() => {})`，把「迁移失败」变成「什么都没发生」：
      // 少了字段、缺了索引，系统照跑，等到某个功能莫名不对时已经查不出原因。
      // 改为收集后汇总一条启动警告——不逐条刷屏，但不再无声。
      const failed: string[] = [];
      const remember = (stmt: string, e: any) => {
        const head = stmt.replace(/\s+/g, ' ').slice(0, 90);
        failed.push(`${head} → ${String(e?.message || e).slice(0, 120)}`);
      };

      for (const stmt of ALTER_STMTS) {
        await client.unsafe(stmt).catch((e) => remember(stmt, e));
      }
      for (const stmt of INDEX_STMTS) {
        await client.unsafe(stmt).catch((e) => remember(stmt, e));
      }
      if (failed.length) {
        const shown = failed.slice(0, 5).map((f) => `\n  - ${f}`).join('');
        console.warn(
          `[db] ${failed.length} 条结构语句未执行成功，相关字段/索引可能缺失：${shown}` +
            (failed.length > 5 ? `\n  …另有 ${failed.length - 5} 条，详见 /api/health/retrieval` : ''),
        );
        schemaIssues = failed;
      }

      // 早期知识库的 embedding_model 是无效的占位值（'lexical'/空），统一归一为「自动」。
      await client
        .unsafe(
          `UPDATE knowledge_bases SET embedding_model = 'auto'
            WHERE embedding_model IS NULL OR TRIM(embedding_model) = '' OR LOWER(embedding_model) = 'lexical'`,
        )
        .catch(() => {});

      // 向量列必须在 chunks 建表之后处理（旧代码在建表前 ALTER，新库永远建不出该列）。
      if (vectorSupported) await ensureVectorColumn();

      const rows = presetModels();
      // 按 id 幂等补齐：老库升级后自动获得新增预设；已存在的预设不会被覆盖
      await db.insert(models).values(rows).onConflictDoNothing();
      await syncPresetKeys(rows);
      // 内置技能：按固定 id 幂等注入（用户可运行，但不可编辑/删除）
      await db.insert(skills).values(presetSkills()).onConflictDoNothing();

      // 演示模式：知识库里没有任何可检索片段时，注入一份虚构示例文档，保证 clone 后登录就有东西可问。
      // 判据用 chunks 而不是 knowledge_bases——空知识库很常见（建了没用、清过文档），
      // 只判 knowledge_bases 会让「有库但无内容」的环境静默跳过注入，用户打开就是一片空白。
      // 这里用原生 SQL 而非 drizzle，是为了避免 db.ts → providers.ts → db.ts 的循环依赖。
      if (demoModeFlag() !== false) {
        try {
          const cnt = await client.unsafe(`SELECT count(*)::int AS c FROM chunks`);
          if (Number((cnt as any)[0]?.c ?? 0) === 0) {
            const now = Date.now();
            const cs = demoChunks();
            await client.unsafe(
              `INSERT INTO knowledge_bases (id, name, scope, owner_id, project_id, embedding_model, created_at)
               VALUES ($1, $2, 'team', NULL, NULL, 'auto', $3) ON CONFLICT (id) DO NOTHING`,
              [DEMO_KB_ID, DEMO_KB_NAME, now],
            );
            await client.unsafe(
              `INSERT INTO documents (id, kb_id, filename, status, chunk_count, created_at)
               VALUES ($1, $2, $3, 'indexed', $4, $5) ON CONFLICT (id) DO NOTHING`,
              [DEMO_DOC_ID, DEMO_KB_ID, DEMO_DOC_NAME, cs.length, now],
            );
            for (const ch of cs) {
              // embedding 留空：演示模式没有向量模型，检索自动走词法腿
              await client.unsafe(
                `INSERT INTO chunks (id, doc_id, kb_id, content, idx, embedding, embedding_model)
                 VALUES ($1, $2, $3, $4, $5, NULL, NULL) ON CONFLICT (id) DO NOTHING`,
                [`chk_demo_${ch.idx}`, DEMO_DOC_ID, DEMO_KB_ID, ch.content, ch.idx],
              );
            }
            console.log(`[demo] 已注入示例知识库「${DEMO_KB_NAME}」，共 ${cs.length} 个片段`);
          }
        } catch (e: any) {
          // 注入失败不该阻断启动：用户仍可手工建库上传
          console.warn(`[demo] 示例知识库注入失败（不影响使用）：${String(e?.message || e).slice(0, 160)}`);
        }
      }

      // 审计日志留存：后台异步裁剪，不阻塞启动（详见 trimOperationLogs）
      trimOperationLogs().catch(() => {});
    })().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

/**
 * 保证 chunks.embedding_vec 存在且维度等于 EMBED_DIM。
 * 维度变化时重建列、清空旧向量并把文档退回「待索引」，避免新维度下检索静默命中旧向量。
 */
async function ensureVectorColumn(): Promise<void> {
  try {
    const want = `vector(${EMBED_DIM})`;
    const cur = (await client.unsafe(
      `SELECT format_type(atttypid, atttypmod) AS t
         FROM pg_attribute
        WHERE attrelid = 'chunks'::regclass AND attname = 'embedding_vec' AND NOT attisdropped`,
    )) as unknown as { t: string }[];
    const exists = !!cur?.[0]?.t;
    const changed = exists && cur[0].t !== want;

    if (changed) {
      // 不直接 DROP：改一次 EMBED_DIM 就会销毁全部历史向量，且没有备份余地。
      // 改为重命名保留（列名由 Date.now() 生成，不含外部输入），人工确认后再删。
      // 必须先删索引：RENAME COLUMN 会让 PostgreSQL 自动把 idx_chunks_vec 跟到备份列上，
      // 随后 `CREATE INDEX IF NOT EXISTS` 会因为同名索引已存在而跳过，新列就永远没有索引
      // —— 表现为检索「能出结果但慢几十倍」，且不报错。
      const bak = `embedding_vec_bak_${Date.now()}`;
      await client.unsafe(`DROP INDEX IF EXISTS idx_chunks_vec`).catch(() => {});
      await client.unsafe(`ALTER TABLE chunks RENAME COLUMN embedding_vec TO "${bak}"`);
      await client.unsafe(`ALTER TABLE chunks ADD COLUMN embedding_vec ${want}`);
      await client.unsafe(`UPDATE chunks SET embedding = NULL, embedding_model = NULL`);
      await client.unsafe(`UPDATE documents SET status = 'ready' WHERE status = 'indexed'`);
      console.warn(
        `[db] EMBED_DIM 变化，旧向量列已重命名为 ${bak}（未删除）。` +
          `确认新维度索引重建完成后可手动 DROP COLUMN ${bak}，否则它会长期占用存储。`,
      );
    } else if (!exists) {
      await client.unsafe(`ALTER TABLE chunks ADD COLUMN embedding_vec ${want}`);
    }

    // —— 存量 JSON 向量回填（2026-11-09 实测缺口）——
    // 装好 pgvector 后第一次启动会建出空的 embedding_vec 列，但历史切片的向量只在
    // embedding(text) 里。只要还有一行 embedding_vec IS NULL，retrieval-path 就判定
    // jsonOnlyChunks > 0，<=> 快路径永远不执行 —— 看起来「装好了」，实际仍全程内存余弦。
    // 因此每次启动都幂等回填：只认维度严格等于 EMBED_DIM 且元素均为有限数值的行；
    // 维度不符（换过 embedding 模型 / 改过 EMBED_DIM）的跳过，交给重新索引，绝不混算。
    try {
      const pending = (await client.unsafe(
        `SELECT id, embedding FROM chunks
          WHERE embedding IS NOT NULL AND embedding_vec IS NULL
          LIMIT 5000`,
      )) as unknown as { id: string; embedding: string }[];
      let filled = 0;
      let skipped = 0;
      for (const row of pending) {
        let vec: number[] | null = null;
        try {
          const parsed = JSON.parse(row.embedding);
          if (Array.isArray(parsed)) vec = parsed;
        } catch {
          /* 历史脏数据：跳过，不影响其它切片 */
        }
        if (!vec || vec.length !== EMBED_DIM || vec.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
          skipped++;
          continue;
        }
        await client.unsafe(`UPDATE chunks SET embedding_vec = $1::vector WHERE id = $2`, [
          toVectorLiteral(vec),
          row.id,
        ]);
        filled++;
      }
      if (pending.length) {
        console.log(`[db] pgvector 存量向量回填：${filled} 条写入，${skipped} 条维度/格式不符跳过`);
      }
      if (skipped) {
        schemaIssues.push(
          `有 ${skipped} 个切片的 JSON 向量维度不是 ${EMBED_DIM}（或格式非法），未回填向量列；请重新索引这些文档`,
        );
      }
    } catch (e: any) {
      schemaIssues.push(`存量向量回填失败 → ${String(e?.message || e).slice(0, 120)}`);
    }

    // HNSW 需要 pgvector >= 0.5；失败（旧版本）不影响 JSON 降级检索，
    // 但「索引没建成」会让向量检索退化成全表扫描——慢而不报错，所以留痕。
    await client
      .unsafe(`CREATE INDEX IF NOT EXISTS idx_chunks_vec ON chunks USING hnsw (embedding_vec vector_cosine_ops)`)
      .catch((e: any) => {
        schemaIssues.push(`向量索引未建成 → ${String(e?.message || e).slice(0, 120)}`);
      });
  } catch (e: any) {
    vectorSupported = false; // 建列失败视为不可用，整体退回 JSON 检索
    vectorError = `建向量列失败：${String(e?.message || e).slice(0, 200)}`;
  }
}

/**
 * 预置模型 Key 同步：早期启动时 .env.local 还没有 Key，会把「空 Key」加密后写进库；
 * 之后补了环境变量，onConflictDoNothing 也不会更新，界面上却显示已配置。
 * 这里只在「库里解密为空 / 解不开」且「env 现在有值」时补写，不覆盖后台手填的 Key。
 */
async function syncPresetKeys(rows: { id: string; apiKey: string }[]): Promise<void> {
  if (!rows.length) return;
  const existing = await db.select({ id: models.id, apiKey: models.apiKey }).from(models);
  const byId = new Map<string, string | null>(existing.map((r) => [r.id, r.apiKey]));
  for (const r of rows) {
    const plain = safeDecrypt(r.apiKey);
    if (!plain) continue; // 环境变量没配
    if (!byId.has(r.id)) continue;
    if (safeDecrypt(byId.get(r.id))) continue; // 已有可用 Key，不覆盖
    await db.update(models).set({ apiKey: r.apiKey }).where(eq(models.id, r.id));
  }
}

/**
 * 审计日志留存（V6）：`logLlm` / `logAction` 每次 LLM 调用与操作都会落一行 operation_logs，
 * 生产环境长期运行会无限膨胀，反过来拖慢 `cacheStats` 与管理后台日志查询。
 * 本函数 best-effort 删除「早于 olderThanDays 天」或「超过 maxRows 条中最旧的」记录，保持表有界。
 * 只在进程启动 / 定时维护时触发（fire-and-forget），失败不影响主流程。
 */
export async function trimOperationLogs(opts?: { maxRows?: number; olderThanDays?: number }): Promise<void> {
  const maxRows = opts?.maxRows ?? 200_000;
  const olderThanDays = opts?.olderThanDays ?? 90;
  try {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    await db.delete(schema.operationLogs).where(
      sql`${schema.operationLogs.createdAt} < ${cutoff} OR ${schema.operationLogs.id} IN (
        SELECT ${schema.operationLogs.id} FROM ${schema.operationLogs}
        ORDER BY ${schema.operationLogs.createdAt} DESC OFFSET ${maxRows}
      )`,
    );
  } catch {
    /* 维护操作失败不影响主流程 */
  }
}
