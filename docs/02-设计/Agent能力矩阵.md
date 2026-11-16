# Agent 能力矩阵（清单 → 代码 → 讲解要点）

> 基准文档：[`../01-需求/Agent Studio 原型 → 工业级项目改造任务清单.md`](../01-需求/Agent%20Studio%20原型%20→%20工业级项目改造任务清单.md)
> 本页只做一件事：**把清单里每一条落到具体文件与行号级位置**，并写清「解决什么坑、怎么讲清楚」。
> 审计时间：2026-10-28；对照方式：逐条读代码 + 跑 `npm run check`，不靠记忆。

## 0. 一句话结论

清单 33 条中 **28 条已落地**、**5 条本轮补齐**（SSRF / MCP / Guardrails / traceId / Critic 严格 JSON），**0 条空白**。
其中「不建议做」里的多角色权限、UI-spec Lint 属产品化范畴，本项目已顺带实现。

## 1. 必做（Agent 高频踩坑）

| # | 清单要求 | 状态 | 落地位置 | 解决的真实坑 |
|---|---|---|---|---|
| 1.1 | AbortSignal 合并「客户端断开 + 超时」双中止源 | ✅ | `app/api/chat/route.ts` `abortOnDisconnect()` | 用户关页面后上游仍在烧 token；部分国产端点挂起不返回导致永远转圈 |
| 1.2 | 流 cancel 后禁止重复 enqueue、异常吞掉但日志仍落库 | ✅ | 同上 `clientGone` 标记 + `send()` 守卫 + `cancel()` | cancel 后 enqueue 抛错会连带打断收尾落库，导致「半截回答 + 用量」全丢 |
| 1.3 | 自定义事件独立输出 think / tool_call / tool_result | ✅ | 同上 NDJSON `{t:'think'\|'tool_call'\|'tool_result'\|'ids'\|'trace'\|'done'}` | 思考型模型的推理 token 混进正文会污染回答；工具调用过程需要可回放 |
| 2.1 | 语义分块降级策略（段落→句子→硬截断 + 重叠） | ✅ | `lib/ai/rag.ts` `splitText()` | 固定 800 字硬切会把一句话劈两半，embedding 语义失真、召回质量差 |
| 2.2 | 相关度闸门（分低且无词面重合直接丢弃） | ✅ | `lib/ai/rag.ts` `filterRelevantHits()`（中文二元组重合 ≥0.1 或分数 ≥0.62） | 国产 embedding 余弦基线偏高，`score>0` 等于「问啥都召回」，每条回答都被迫带来源 |
| 2.3 | 按 `embedding_model` 分组，禁止跨模型算相似度 | ✅ | `lib/ai/rag.ts` `retrieve()` 分组 + 单模型才走 `<=>` 快路径 | 换过 embedding 模型后新旧向量混算，相似度完全不可比，召回错乱且无报错 |
| 2.4 | 向量双写（pgvector 二进制 + JSON 备份） | ✅ | `chunks.embedding` / `chunks.embedding_vec` + `isVectorSupported()` | pgvector 扩展缺失/维度不一致时不能崩，要能退回 JSON 内存余弦 |
| 3.1 | 统一工具注册表 name/description/parameters/timeoutMs/invoke | ✅ | `lib/tools/registry.ts` `registerTool()` | 工具定义散落在各路由，加一个工具要改三处，权限/审计无法统一 |
| 3.2 | 每个工具统一 `withTimeout` | ✅ | 同上 `withTimeout()` | 下游卡死会阻塞整个 Agent 循环，用户看到「一直转」而不是明确失败 |
| 3.3 | 审计：入参、返回、耗时、是否失败 | ✅（本轮补全） | 同上 `invokeRegisteredTool()`；本轮补 `入参` 并做 PII 脱敏 | 原来只记返回，出问题无法复现「当时传了什么参数」 |
| 3.4 | 双约束：`maxSteps` 硬上限 + System Prompt 软纪律 | ✅ | `chat/route.ts` `maxSteps: 5` + `TOOL_DISCIPLINE` | 思考型模型会无限检索、迟迟不出正文 |
| 4.1 | 记忆抽取 fire-and-forget | ✅ | `lib/ai/memory.ts`，调用侧 `extractMemories(...).catch()` | await 记忆抽取等于把一次额外 LLM 调用挂在首字路径上 |
| 4.2 | 记忆检索前置词面预筛（ILIKE） | ✅ | `lib/ai/memory.ts` `retrieveMemories()` + `MEMORY_CANDIDATE_CAP=500` | 全表加载再内存排序，记忆一多就 O(n) 雪崩甚至 OOM |
| 5.1 | 重试只对瞬时错误（429/5xx/网络），4xx 不重试 | ✅ | `lib/llm.ts` `withRetry()` transient 正则 | 参数错误重试 3 次 = 白白烧 3 倍 token，还把错误延迟放大 |
| 5.2 | 动态 maxTokens（防思考型模型「想完就停」） | ✅ | `chat/route.ts` `ctxLen/2` 夹在 2048–8192 | 固定 2048 时推理 token 先耗尽预算，正文一个字没输出 |

## 2. 选做（工程增强）

| # | 清单要求 | 状态 | 落地位置 | 说明 |
|---|---|---|---|---|
| 6.1 | 模型配置入库、后台可视化新增 | ✅ | `models` 表 + `app/api/admin/models` | 换模型不用改代码发版 |
| 6.2 | `capabilities` 标记 chat/tools/vision/embedding | ✅ | `chat/route.ts` `supportsTools/supportsVision` | 不支持 tools 的模型被强塞工具 → 反复调工具却不出文本 |
| 6.3 | failover + 内存缓存 | ✅ | `lib/llm.ts` `resolveModelWithFallback()` + `invalidateModelCache()` | 指定模型失效时自动降级；缓存 30s 且后台改动即时失效 |
| 7.1 | 熔断器（4xx 不计失败） | ✅ | `lib/resilience.ts`、`lib/tools.ts` 只在 5xx/429 计失败 | 把「下游活着只是参数错」判成故障，会把连接器误熔断 |
| 7.2 | 单机进程内限流（无 Redis 降级） | ✅ | `lib/redis.ts` `MemoryRateLimiter` + `checkRateLimit()` | 没 Redis 也要能限流，有 Redis 自动切分布式 |
| 7.3 | 向量化后台异步（BullMQ，单机降级） | ✅ | `lib/queue.ts` `enqueueIndex()` | 上传接口阻塞等 embedding，大文件直接超时 |
| 8.1 | Critic 强制结构化 JSON，禁止正则解析自然语言 | ✅（本轮重写） | `lib/agent/verdict.ts` + `lib/agent/engine.ts` `criticVerdict()` | **原实现有 bug**：`/通过/` 正则兜底会把「不能通过」判成 pass，校验形同虚设。现在严格 JSON + 一次带错误原因的重出 + fail-closed |
| 8.2 | 循环硬上限 + 失败记 trace | ✅ | `engine.ts` `maxSteps=20`、`trajectory` 落库 | 死循环；失败无轨迹无法复盘 |
| 9.1 | 密钥 AES-GCM 加密入库 | ✅ | `lib/crypto.ts` `encryptJson/decryptJson` + `scripts/reencrypt-model-keys.mjs` | 明文密钥躺在库里，一次备份泄漏即全线失守 |
| 9.2 | 文件工具路径穿越防护 | ✅ | `lib/storage.ts` `resolveSafe()/safeName()` | `../../etc/passwd` 类路径穿越 |
| 9.3 | CSRF（优先 Sec-Fetch-Site） | ✅ | `middleware.ts` `csrfBlocked()` | 只靠 SameSite 不够，同站子域/老浏览器仍可被利用 |
| 10.1 | LLM 日志 fire-and-forget | ✅ | `lib/observability.ts` `logLlm()` | await 写库直接抬高首字延迟 |
| 10.2 | 用量「预估 + 流结束真实 usage 补全」 | ✅ | `chat/route.ts` `result.usage` 收尾补齐 | 只有估算值，成本看板不准 |

## 3. 高阶（生产系统能力）

| # | 清单要求 | 状态 | 落地位置 | 说明 |
|---|---|---|---|---|
| H1 | NDJSON 完整自研流式协议，脱离 AI SDK data-stream | ✅ | `chat/route.ts` 手写 `ReadableStream` + `{t,v}` 事件 | 协议可控才能加 `think`/`trace`/`trace_id` 等自定义事件 |
| H2 | Redis 分布式限流 + 语义缓存（并记录缺陷） | ✅ | `lib/redis.ts`、`lib/cache.ts` | 语义缓存对多轮上下文会串答案，只缓存「单轮 + 无 ⚠️」回答 |
| H3 | BullMQ 队列 | ✅ | `lib/queue.ts` | 文档索引 / 记忆抽取可迁移为持久化任务 |
| H4 | 声明式编排引擎（llm/tool/condition/loop/human + 暂停续跑） | ✅ | `lib/agent/engine.ts` `runSkill()` + `skills/runs` resume | 硬编码 ReAct 无法表达「人工确认后继续」 |
| H5 | 能力网关（OpenAPI 自动生成工具 + 审批流 + SSRF 防护） | ✅（SSRF 本轮补齐） | `lib/capabilities.ts`、`lib/connectors/openapi.ts`、`lib/ssrf.ts` | 用户填的 URL 由服务端代发请求 = 天然 SSRF 入口，能打云元数据；多能力编排靠 description 划边界、不写死流水线（实测「地名解析 → 设备状态」会自适应 1~2 次调用） |
| H6 | 全链路降级（pgvector / Redis / embedding 不可用不崩） | ✅ | `lib/db.ts` `isVectorSupported()`、`lib/ai/embed.ts` `localVector()`、`lib/redis.ts` | 缺基础设施时整站 500 是最常见的「演示环境翻车」 |
| H7 | 单元测试（纯逻辑抽离后 vitest） | ✅ | `tests/` 19 文件 166 例（1 跳过） | 分块/闸门/熔断/签名/协议解析全部可单测 |
| H8 | CSP 响应头 + 完整越权 + 多角色权限 | ✅ | `next.config.mjs` `headers()`、`middleware.ts`、三态 `gate` | 边鉴权 + 服务端会话双校验 |

## 4. 本轮新增（原清单未覆盖或只点名未落地）

### 4.1 `lib/ssrf.ts` — SSRF 三层防护

- **为什么必须有**：连接器 / 能力 / MCP 端点的 URL 都由用户填写，服务端代为请求。不做校验，普通成员填
  `http://169.254.169.254/latest/meta-data/` 就能读云主机凭据，或扫内网。这是「Agent 接外部工具」最典型的越权面。
- **三层**：① 字面量（协议白名单、禁内嵌账号密码、IP 直判私网）→ ② DNS 解析后逐个 IP 校验（防
  `127.0.0.1.nip.io` 绕过）→ ③ 重定向逐跳校验（防「公网 302 到内网」）。
- **接入点**：`lib/tools.ts`（HTTP/MCP 连接器）、`lib/capabilities.ts`（能力调用）、`lib/connectors/service.ts`（健康检查/拉 OpenAPI）、`lib/mcp/client.ts`。
- **本地开发**：`SSRF_ALLOW_PRIVATE=true` 放开（或单次调用传 `allowHosts`）。

### 4.2 `lib/mcp/client.ts` + `lib/tools/mcp-tools.ts` — MCP 客户端与「工具即插即用」

- **协议**：JSON-RPC 2.0 over Streamable HTTP；`initialize → notifications/initialized → tools/list → tools/call`；
  会话走 `Mcp-Session-Id`，协议版本走 `MCP-Protocol-Version`（默认 `2025-06-18`，可用 `MCP_PROTOCOL_VERSION` 覆盖）。
- **响应形态**：同时兼容一次性 JSON 与 SSE（`data:` 帧），批量数组也按 id 命中。
- **产品化**：连接器页填一个 MCP 地址 → 对话里模型自动多出 `mcp__<连接器>__<工具>` 工具，无需写代码。
- **约束**：工具清单缓存 5 分钟；单点失败只跳过自己（`Promise.allSettled`）；返回内容用 `<untrusted_data>` 定界。
- **排障入口**：连接器行内「工具」抽屉（`app/connectors/McpToolPanel.tsx`）看清单 + 按 schema 试调；
  清单第三列直接列出**模型看到的函数名**（`chatName`，由 `/api/mcp` 用 `mcpToolKey()` 算好），被净化过的名字带感叹号提示；
  接口侧 `POST /api/mcp` `{connectorId, action:'tools'|'call'}`。
- **命名冲突**：净化后不同连接器可能撞成同一个 key，原实现静默丢弃 → 现在补 `mcp_tool_conflict` 审计日志，面板可见。
- **健康检查**：`checkConnectorHealth` / `callConnector` 的 mcp 分支都走真实握手（GET 探测 POST-only 端点会拿 405 被误判）。
- **实测（2026-10-28）**：`https://mcp.deepwiki.com/mcp`（免费免鉴权）握手 → 发现 3 工具 → 模型自主调
  `read_wiki_structure` 625ms 返回真实目录树 → 对话回答主动声明外部来源。已知边界：只在对话链路，技能 `tool` 节点未接。

### 4.3 `lib/guardrails.ts` — 护栏

| 能力 | 做法 | 为什么 |
|---|---|---|
| 提示注入检测 | 8 条启发式规则（忽略指令 / 角色劫持 / 套系统提示词 / 跳过审批 …） | 命中后不硬拦（会误伤正常提问），而是把风险写进 System Prompt + 记 `guardrail_injection` 日志；`GUARDRAIL_BLOCK=true` 才一刀切 |
| 间接注入定界 | RAG 片段、工具返回、MCP 返回统一包 `<untrusted_data>` + 配套规则 | 「文档里埋指令」比「用户直接说」更隐蔽，定界比过滤有效 |
| PII 脱敏 | 手机号/身份证/银行卡/邮箱/API Key | 审计日志不该成为新的泄漏源 |
| 输出体检 | 复读检测、密钥外泄、复述系统提示词 | 只记录不改写（改了用户拿不到已生成内容） |

### 4.4 `lib/trace.ts` — traceId 贯穿全链路

- 中间件为每个请求签发 `x-trace-id`，写回请求头与响应头；`AsyncLocalStorage` 在异步链路里透传；
  `logAction` / `logLlm` 自动在 `detail` 加 `[trace:xxx]` 前缀。
- 效果：一次对话的「检索 → 工具 → 模型 → 审批 → 落库」多行日志可用一个 id 串起来；用户报障贴 id 即可定位。
- 不引 OpenTelemetry 的理由：单机进程内 ALS 足够；将来跨服务只需把 id 塞进 W3C `traceparent`。

### 4.5 `lib/agent/verdict.ts` — Critic 严格结构化判定

原来：`JSON.parse` 失败后用 `/pass|通过/` 正则猜，`"这个方案不能通过"` 被判成 pass。
现在：只认纯 JSON（允许 ```json 围栏）→ zod 校验 → 不合法则**带具体错误原因重出一次** → 仍不合法 fail-closed 并写轨迹。
单测覆盖 9 例，其中一条就是这个回归。

## 5. 讲解要点（每条 30 秒内可讲完）

1. **流式链路**：先说「用户关页面后上游还在烧钱」这个现象 → 我怎么合并双中止源、cancel 后怎么保证落库 → 结果：中止即断流且半截回答不丢。
2. **RAG 闸门**：「问『你好』也返回三条参考来源」→ 为什么只看向量分不行（国产模型基线漂移）→ 词面重合 + 分数双条件 → 附带中文二元组切词的原因。
3. **工具注册表**：先说工具散落的维护成本 → 一张表统一 权限/审批/超时/审计 → 顺手讲「4xx 不计入熔断」这种反直觉细节。
4. **Critic fail-closed**：讲「正则把『不能通过』判成通过」这个自己踩的坑 → 严格 JSON + 带错误重试 + fail-closed。
5. **SSRF**：讲「Agent 接三方工具 = 服务端替用户发请求」→ 元数据地址 → 三层防护 → 为什么不只做域名黑名单。
6. **MCP**：讲协议三方法 + SSE/JSON 双形态 + 会话头 → 落到「填个地址模型就有新工具」。
7. **护栏**：讲直接注入 vs 间接注入，为什么「定界」比「过滤」有效，为什么默认不硬拦。

## 6. 验证基线

```
npm run typecheck   # tsc --noEmit，0 错误
npm run lint:ui     # 43 个 TSX，0 处违规
npm run test        # 19 文件 166 例通过（1 跳过）
node scripts/check-doc-links.mjs   # 19 个 Markdown，链接全部有效
```
