import { pgTable, text, integer, bigint, boolean } from 'drizzle-orm/pg-core';

// 用户
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('member'), // 'admin' | 'member' | 'guest'
  status: text('status').notNull().default('active'), // 'active' | 'disabled'
  monthlyLimit: integer('monthly_limit').notNull().default(1000000),
  storageQuota: integer('storage_quota').notNull().default(1073741824), // 默认 1GB（字节）
  overQuotaAction: text('over_quota_action').notNull().default('block'), // 'block' | 'downgrade' | 'warn'
  alertThreshold: integer('alert_threshold').notNull().default(80), // 额度告警阈值(%)
  // 会话版本号：管理员重置密码/禁用账号时 +1，使此前签发的 JWT 立即失效
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 模型配置
export const models = pgTable('models', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  apiKey: text('api_key'), // 加密存储
  capabilities: text('capabilities').notNull().default('[]'), // json 数组：chat/tools/vision/embedding/rerank
  visibleRoles: text('visible_roles').notNull().default('["admin","member"]'), // json 数组
  isDefault: boolean('is_default').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  priceIn: integer('price_in').notNull().default(0), // 计费：输入单价（分/千token，示意）
  priceOut: integer('price_out').notNull().default(0), // 计费：输出单价
  contextLength: integer('context_length').notNull().default(8192),
});

// 会话
export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull().default('新对话'),
  pinned: boolean('pinned').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  projectId: text('project_id'),
  summary: text('summary'), // 短期记忆压缩摘要
  // V8.3 · W3：摘要水位线——已摘要进 summary 的最后一条消息的 createdAt。
  // 没有它就无法做增量：每次只能把「所有被挤出窗口的消息」重新压缩一遍，
  // 于是长对话里每轮都要付一次摘要 LLM 调用（且串行阻塞首字）。
  summaryUpto: bigint('summary_upto', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 消息
export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  modelId: text('model_id'),
  tokens: integer('tokens').notNull().default(0),
  sources: text('sources'), // json 数组：[来源文档名]
  trace: text('trace'), // json 数组：工具调用轨迹
  meta: text('meta'), // json：本轮关联的技能/能力等元数据（不污染正文）
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 消息反馈
export const feedback = pgTable('feedback', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  userId: text('user_id').notNull(),
  rating: text('rating').notNull(), // 'up' | 'down'
  comment: text('comment'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 知识库
export const knowledgeBases = pgTable('knowledge_bases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  scope: text('scope').notNull().default('team'), // 'personal' | 'team'
  ownerId: text('owner_id'),
  projectId: text('project_id'), // 归属项目（可选）
  embeddingModel: text('embedding_model').notNull().default('auto'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 文档
export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  kbId: text('kb_id').notNull(),
  filename: text('filename').notNull(),
  status: text('status').notNull().default('ready'), // 'parsing' | 'ready' | 'indexed' | 'failed'
  chunkCount: integer('chunk_count').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 切片
export const chunks = pgTable('chunks', {
  id: text('id').primaryKey(),
  docId: text('doc_id').notNull(),
  kbId: text('kb_id').notNull(),
  content: text('content').notNull(),
  idx: integer('idx').notNull().default(0),
  embedding: text('embedding'), // json 数组 number[]（无则为 null，回退词法）
  embeddingModel: text('embedding_model'), // 产出该向量的模型 id / 'local'；null = 历史未记录
});

// 文件
export const files = pgTable('files', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  scope: text('scope').notNull().default('personal'), // 'personal' | 'project'
  projectId: text('project_id'),
  conversationId: text('conversation_id'), // 绑定到某个会话（工作空间文件栏）
  filename: text('filename').notNull(),
  path: text('path').notNull(), // 服务器存储相对路径
  size: integer('size').notNull().default(0),
  mime: text('mime'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 定时任务
export const schedules = pgTable('schedules', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  scope: text('scope').notNull().default('personal'), // 'personal' | 'team'
  projectId: text('project_id'), // 归属项目（可选）
  name: text('name').notNull(),
  cron: text('cron').notNull(), // cron 表达式，或 "interval:N"（每 N 分钟）
  target: text('target').notNull(), // 'prompt' | skillId
  prompt: text('prompt'),
  skillId: text('skill_id'),
  modelId: text('model_id'),
  notify: text('notify').notNull().default('none'), // 'none' | 'webhook'
  webhookUrl: text('webhook_url'),
  enabled: boolean('enabled').notNull().default(true),
  lastRunAt: bigint('last_run_at', { mode: 'number' }),
  lastStatus: text('last_status'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 项目
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  ownerId: text('owner_id').notNull(),
  visibility: text('visibility').notNull().default('team'), // 'personal' | 'members' | 'team'
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const projectMembers = pgTable('project_members', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  userId: text('user_id').notNull(),
});

// 记忆
export const memories = pgTable('memories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  scope: text('scope').notNull().default('personal'), // 'personal' | 'team'
  projectId: text('project_id'), // 归属项目（可选）
  type: text('type').notNull().default('fact'), // 'fact' | 'episodic'
  content: text('content').notNull(),
  embedding: text('embedding'), // json 数组 number[]
  // V8 · 记忆治理：可信度 / 来源 / 证据版本 / 失效时间
  credibility: text('credibility').notNull().default('low'), // 'low' | 'medium' | 'high'
  sourceType: text('source_type').notNull().default('extracted'), // 'extracted' | 'confirmed' | 'imported'
  evidenceVersion: text('evidence_version'), // 关联证据/来源版本，版本变更即失效
  expiresAt: bigint('expires_at', { mode: 'number' }), // 失效时间戳（null=不过期）
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 技能（声明式多 Agent 工作流）
export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  scope: text('scope').notNull().default('personal'), // 'personal' | 'team'
  projectId: text('project_id'), // 归属项目（可选）
  name: text('name').notNull(),
  description: text('description'),
  // 步骤：[{ role, type, prompt, ... }]，type 支持 llm | tool | condition | loop | human
  steps: text('steps').notNull().default('[]'),
  modelId: text('model_id'),
  version: integer('version').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 技能安装提议（对话内「安装技能」→ 人工确认 → 入库）
export const skillProposals = pgTable('skill_proposals', {
  id: text('id').primaryKey(),
  ref: text('ref').notNull(), // 原始引用，如 @handle/slug
  source: text('source').notNull(), // 'skillhub' | 'github'
  sourceLabel: text('source_label'),
  name: text('name').notNull(),
  description: text('description'),
  version: text('version'),
  author: text('author'),
  security: text('security').notNull().default('[]'), // json 数组：安全扫描报告
  files: text('files').notNull().default('[]'), // json 数组：文件清单
  scriptFiles: text('script_files').notNull().default('[]'), // json 数组：附带脚本（本平台不执行）
  bodyPreview: text('body_preview'), // 正文预览（供确认时查看）
  body: text('body').notNull(), // SKILL.md 正文（确认后写入技能的提示词）
  status: text('status').notNull().default('pending'), // 'pending' | 'installed' | 'dismissed'
  requestedBy: text('requested_by').notNull(),
  confirmedBy: text('confirmed_by'),
  skillId: text('skill_id'), // 确认后生成的技能 id
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  confirmedAt: bigint('confirmed_at', { mode: 'number' }),
});

// 技能运行实例
export const skillRuns = pgTable('skill_runs', {
  id: text('id').primaryKey(),
  skillId: text('skill_id'),
  ownerId: text('owner_id').notNull(),
  input: text('input').notNull(),
  trajectory: text('trajectory').notNull().default('[]'), // json 数组：步骤过程
  result: text('result'),
  status: text('status').notNull().default('done'), // 'done' | 'paused' | 'error'
  resumeIndex: integer('resume_index').notNull().default(0),
  resumePrev: text('resume_prev'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 技能版本快照：每次更新 steps 时把旧版本落库，支持一键回滚到历史版本
export const skillVersions = pgTable('skill_versions', {
  id: text('id').primaryKey(),
  skillId: text('skill_id').notNull(),
  version: integer('version').notNull(),
  steps: text('steps').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  createdBy: text('created_by'),
});

// 连接器
export const connectors = pgTable('connectors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'http' | 'builtin:file' | 'mcp'
  config: text('config').notNull().default('{}'), // json
  enabled: boolean('enabled').notNull().default(true),
  visibleRoles: text('visible_roles').notNull().default('["admin","member"]'),
  status: text('status').notNull().default('active'), // 'active' | 'revoked'
  specUrl: text('spec_url'), // OpenAPI 文档地址（发现能力用）
  baseUrl: text('base_url'), // 接口基地址（能力调用用）
  healthStatus: text('health_status').notNull().default('unknown'), // 'unknown' | 'ok' | 'error'
  healthAt: bigint('health_at', { mode: 'number' }),
  lastError: text('last_error'),
  /**
   * MCP 工具的审批策略（V8.5）：'auto' | 'always' | 'never'
   *
   * 为什么放在连接器上而不是全局：审批的取舍取决于这个服务能干什么。
   * 一个只读的文档检索服务和一台能重启机器的运维服务，不该共用同一个开关。
   */
  mcpApproval: text('mcp_approval').notNull().default('auto'),
  discoveredAt: bigint('discovered_at', { mode: 'number' }),
  revision: integer('revision').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 能力：连接器 OpenAPI 操作解析后落地的可调用工具，也可承载内置能力
export const capabilities = pgTable('capabilities', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id'), // null = 内置能力
  key: text('key').notNull(), // 连接器内唯一标识（operationId 或 method_path）
  name: text('name').notNull(), // 展示名 / 调用名
  description: text('description'),
  method: text('method').notNull().default('GET'),
  path: text('path').notNull().default('/'),
  parameters: text('parameters').notNull().default('[]'), // json：参数清单
  inputSchema: text('input_schema').notNull().default('{}'), // json schema（给模型看）
  responseMapping: text('response_mapping').notNull().default('{}'), // json：extract/pick/limit
  minRole: text('min_role').notNull().default('member'), // 'admin' | 'member' | 'guest'
  requiresApproval: boolean('requires_approval').notNull().default(false),
  timeoutMs: integer('timeout_ms').notNull().default(30000),
  status: text('status').notNull().default('active'), // 'active' | 'disabled' | 'revoked'
  fingerprint: text('fingerprint'), // spec 指纹，用于 refresh 差异比对
  meta: text('meta').notNull().default('{}'), // 协议扩展元数据，不含密钥
  createdBy: text('created_by'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// 能力/连接器授权：scope='connector' 时 targetId 为连接器 id
export const capabilityGrants = pgTable('capability_grants', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull().default('capability'), // 'connector' | 'capability'
  targetId: text('target_id').notNull(),
  subjectType: text('subject_type').notNull().default('user'), // 'user' | 'role'
  subjectId: text('subject_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 能力调用实例：同步调用 / 异步任务 / 待审批统一落这里，指标由此聚合
export const capabilityOperations = pgTable('capability_operations', {
  id: text('id').primaryKey(),
  capabilityId: text('capability_id'),
  connectorId: text('connector_id'),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('running'), // 'pending_approval' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  mode: text('mode').notNull().default('sync'), // 'sync' | 'async'（长任务后台执行）
  input: text('input'),
  output: text('output'),
  error: text('error'),
  source: text('source').notNull().default('api'), // 'chat' | 'api' | 'skill' | 'schedule'
  conversationId: text('conversation_id'),
  approvedBy: text('approved_by'),
  approvedAt: bigint('approved_at', { mode: 'number' }),
  durationMs: integer('duration_ms'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  startedAt: bigint('started_at', { mode: 'number' }),
  finishedAt: bigint('finished_at', { mode: 'number' }),
});

// 用量（按月）
export const usage = pgTable('usage', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  period: text('period').notNull(), // yyyy-mm
  tokensUsed: integer('tokens_used').notNull().default(0),
});

// 操作日志
export const operationLogs = pgTable('operation_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  action: text('action').notNull(),
  /**
   * 人类可读的一句话摘要，**不再承担结构化职责**（V8.10）。
   *
   * 历史上它是唯一的载体：`${model} | ${label} | OK | 1200ms`，成本看板用
   * `split_part(target,' | ',n)` 反解。模型名里带一个 ` | ` 就整体错位，
   * 而错位不会报错——只会让成本和用量在没人察觉时算到错的模型头上。
   * 现在结构化字段落真列，target 只留作展示与人眼检索。
   */
  target: text('target'),
  status: text('status'), // 'ok' | 'error' | 'pending_approval' | 'cancelled'
  durationMs: integer('duration_ms'),
  detail: text('detail'),
  tokens: integer('tokens'),
  /** 请求级链路 id：一次对话里的检索/工具/审批/落库多行日志靠它串起来（V8.10 起独立成列） */
  traceId: text('trace_id'),
  /** 以下四列只对 action='llm_call' 有值；其余日志为 null */
  model: text('model'),
  label: text('label'),
  /** 成败：null 表示「这次操作没有成败概念」（如缓存命中计数） */
  ok: boolean('ok'),
  /** 输入/输出分开记：单价不同，合成一个总 token 只能算出一个近似值 */
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

/**
 * 工具幂等账本（V8.2 · C1）。
 *
 * 为什么不复用 operation_logs：审计日志是「发生过什么」的追加流水，永不改写；
 * 幂等账本是「这件事只能做一次」的可变锁，要 UPDATE 状态、要按过期时间清理。
 * 两者生命周期和读取模式都不同，混在一张表里会让审计统计被 running 态污染，
 * 也会让清理逻辑误删审计记录。所以单独一张小表。
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  status: text('status').notNull(), // 'running' | 'done'
  /** 成功结果（JSON 文本）；running 态为 null */
  result: text('result'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  /** 过期时间戳（ms）；过期后可被重新占用 */
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

// 平台设置（key/value）
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// 邀请码
export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  role: text('role').notNull().default('member'), // 'admin' | 'member' | 'guest'
  used: boolean('used').notNull().default(false),
  usedBy: text('used_by'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 定时任务执行历史
export const scheduleRuns = pgTable('schedule_runs', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id').notNull(),
  status: text('status').notNull(), // 'ok' | 'error'
  result: text('result'),
  error: text('error'),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  finishedAt: bigint('finished_at', { mode: 'number' }),
});

// 站内通知
export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id'), // null = 广播
  title: text('title').notNull(),
  body: text('body'),
  read: boolean('read').notNull().default(false),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 会话分享 / 交付
export const sessionShares = pgTable('session_shares', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  ownerId: text('owner_id').notNull(),
  token: text('token').notNull().unique(),
  visibility: text('visibility').notNull().default('link'), // 'link' | 'user'
  sharedWith: text('shared_with'), // 指定接收者（邮箱）
  title: text('title'),
  revoked: boolean('revoked').notNull().default(false),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 待办收件箱（WorkBuddy 闭环：AI 产出 → 行动项 → 完成）
export const todos = pgTable('todos', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  scope: text('scope').notNull().default('personal'), // 'personal' | 'team'
  projectId: text('project_id'), // 归属项目（可选）
  title: text('title').notNull(), // ≤120 字
  detail: text('detail'), // 详细说明（可选）
  status: text('status').notNull().default('open'), // 'open' | 'done' | 'dismissed'
  source: text('source').notNull().default('manual'), // 'manual' | 'chat' | 'skill' | 'schedule'
  sourceRef: text('source_ref'), // json：{conversationId?, messageId?, skillRunId?, scheduleRunId?}
  dueDate: bigint('due_date', { mode: 'number' }), // 到期时间（可选）
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  completedAt: bigint('completed_at', { mode: 'number' }),
});

// 今日简报（每用户每日缓存一份，工作台展示）
export const briefings = pgTable('briefings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  date: text('date').notNull(), // yyyy-mm-dd
  items: text('items').notNull().default('[]'), // json 数组：简报要点
  modelUsed: text('model_used'), // 生成所用模型（null = 模板降级）
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 产物（文档/PPT 归档）
export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  projectId: text('project_id'),
  conversationId: text('conversation_id'),
  type: text('type').notNull(), // 'doc' | 'ppt'
  title: text('title'),
  filename: text('filename').notNull(),
  path: text('path').notNull(),
  size: integer('size').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});
