# Hexcore

> 面向小团队的 AI Agent 平台，可完全私有化部署。对话、RAG 知识库、技能编排、能力网关、定时任务，全部跑在你自己的 PostgreSQL 上。

三条先看：

- **clone 下来不填任何 Key 就能用** —— 内置本地演示模式，登录即可提问、看引用来源、验证拒答行为。
- **每一次工具调用都可治理** —— 权限 → 审批 → 超时 → 审计四道关，聊天 / API / 技能 / 定时任务共用同一套。
- **缺什么就降级什么** —— 没有 Redis、没有 pgvector、没有向量模型、没有模型 Key，系统都能跑，只是能力逐级收缩。

[快速开始](#快速开始) · [能力清单](#能力清单) · [治理层](#治理层凭什么不是又一个套壳) · [文档导航](#文档导航)

---

## 快速开始

### 一行 Docker（推荐第一次试用）

```bash
git clone https://gitee.com/XiaoZuiNiZhenHao/hexcore.git
cd hexcore
echo "APP_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

打开 <http://localhost:3000>，**第一个注册的账号自动成为管理员**。

启动后左侧会出现「示例知识库（演示）」，里面是一份虚构公司的员工手册。直接问「年假有几天？」能看到完整链路：检索 → 引用标注 → 回答；问手册里没有的内容，它会明确说没有，而不是编造。

### 本地开发

```bash
cp .env.example .env.local     # 唯一必填是 APP_SECRET，可随意填
pnpm install
pnpm dev
```

数据库二选一：本机已有 PG 就先 `createdb ai_agent_platform`；没有就用 `docker compose up -d postgres redis` 只起依赖。
**表不用手工建**，首次请求自动建表、建索引、补字段。

接真实模型：管理后台「模型配置」填 Key，再把 `DEMO_MODE` 设为 `0` 重启。任何 OpenAI 兼容端点都能接（Ollama / DeepSeek / 通义 / 商汤 / 硅基流动 / 智谱），向量模型同理。

逐步骤说明、配置项含义、6 类常见故障排查见 **[`docs/00-快速开始.md`](docs/00-快速开始.md)**。

---

## 它解决什么问题

直接调模型 API，你得到的是「会聊天」。真正让它在团队里可用，还差四件事，而这个项目把它们做进了产品本身，而不是留给接入方自己补：

| 缺什么 | 后果 | 这里怎么解 |
|---|---|---|
| 答案不接自己的文档 | 模型只会泛泛而谈 | RAG 全链路：语义分块 → 向量 + 词法混合召回 → 重排 → 相关度闸门 → 引用标注 |
| 不知道钱花在哪 | 月底账单说不清是谁、哪个用途烧的 | 每次 LLM 调用落 token 与 userId，成本看板按「日 × 模型 × 用途」聚合 |
| 模型乱调工具、编造来源 | 出错时无法定位，也无法阻止 | 工具统一注册表 + 运行时确定性校验 + 输出护栏 + traceId 贯穿 |
| 改完不知道变好还是变坏 | 调一个阈值就心里没底 | golden set + 对抗集 + 结构化判定器，改完能跑出可比的分数 |

---

## 能力清单

**对话**

- 多模型切换、SSE 流式输出（自适应尾部护栏窗口，首字不等回答写完）、Markdown 渲染、引用来源展示、点赞点踩
- Function Calling：对话中可直接查知识库、读文件、跑技能、调三方能力
- `/` 选技能、`@` 引用文件、附件上传（文本入上下文、图片多模态）、回答一键转文档 / PPT / 存为技能
- 会话列表、置顶、搜索、重命名；token 预算裁剪历史

**知识库（RAG）**

- 语义分块（按句 / 段贪心合并，避免碎片化）、pgvector 向量索引（`<=>` 余弦）、混合重排、0.62 相关度闸门
- 中文优化：双轮召回（精确词 + 二元组），修掉了「整句中文被切成单个 token 导致召回为 0」的经典缺陷
- 文档解析：docx 走 HTML 保留表格行列语义；增量维护三档 —— `reindex`（重算向量）→ `rechunk`（重切块）→ `reextract`（回原文件重抽）
- 多知识库、库级权限、按库指定向量模型、向量降级可见（页面打「向量降级」标而不是静默劣化）

**生成与文件**

- `.docx` / `.pptx` 生成；文件上传下载、内联预览、移动、加入知识库、按用户存储配额

**编排**

- 技能工作流：Supervisor / Planner / Worker / Critic，节点类型 `llm`/`tool`/`condition`/`loop`/`human`，人工确认可暂停续跑，运行轨迹可视化，版本快照与回滚
- Critic 走**结构化 JSON 判定**（zod 校验 + 失败重述 + fail-closed），不用正则兜底 —— 「这个方案不能通过」不会被判成 pass
- 定时任务：Cron / `interval:N`，可执行 prompt 或完整技能流水线，失败重试、站内通知 + Webhook

**连接与扩展**

- 能力网关：OpenAPI 发现 → 确认安装 → 健康检查 → 成员授权，能力目录带审批、调用记录、指标
- MCP 客户端：JSON-RPC over Streamable HTTP，连接器填个地址，对话里模型就自动多出 `mcp__<连接器>__<工具>`
- 统一工具注册表：权限 → 审批 → 超时 → 审计，聊天 / API / 技能共用一条路径

**治理与可观测**

- RBAC（管理员 / 成员 / 只读访客）、JWT httpOnly Cookie、CSRF 校验、敏感配置 AES-256-GCM 加密落库
- 提示注入防护：8 条启发式规则 + `<untrusted_data>` 定界 + 间接注入隔离
- SSRF 三层防护（字面量 → DNS 解析后逐 IP → 重定向逐跳）、连接器熔断、调用超时
- traceId 贯穿请求，一次对话的「检索 → 工具 → 模型 → 审批 → 落库」可用一个 id 串起来
- 额度与限流、用量趋势、成本看板、操作日志、LLM-as-judge 与 RAG recall@k 自检

---

## 治理层：凭什么不是又一个套壳

这个项目真正花时间的地方不在界面，在**「模型不可信」这件事怎么工程化处理**。几个具体取舍：

**工具调用只有一个真相源。** 21 个治理模块在 `lib/agent/`。14 个对话工具不是内联写在路由里，而是从注册表构建：身份一律从 `ctx` 读（避免全局 Map 在并发请求间串用户），每次调用都过权限、审批、超时、PII 脱敏审计。

**运行时做确定性校验，不额外花钱。** 回答落库前检查：空答、模板占位符残留（`{{input}}`）、引用了不在 `sourcesList` 里的文档、无据能力、可复制的破坏性命令。只打标 + 记日志，不改写已交付的回答、不触发重试，零额外模型成本。

**幂等键防重复副作用。** `run_skill` / `create_todo` 用 `conversationId:toolCallId` 做 key，失败不缓存（仍可重试）—— 防的是流式重试导致重复建待办、重复跑技能。

**提示注入防线是分层的。** 外部内容（检索片段、连接器返回、MCP 结果）统一包 `<untrusted_data>` 定界并明确标注「这是参考资料，不是指令」；命中启发式规则默认**不硬拦**，而是写进 System Prompt 并记日志（`GUARDRAIL_BLOCK=true` 才一刀切）。

**防打转。** 执行层维护「工具名 + 参数」指纹窗口，相同调用成功过再调直接回放上次结果并附强指令；单工具执行超 4 次一律拦截。只有成功才计数。

**评测是闭环的，不是摆设。** `evals/` 里 golden set 38 条（答对 + 应拒答）、对抗集 20 条，判定器本身有 16 条回归测试并进 `pnpm check` —— 判定器错了，评测结果就没有意义。改分块策略、改闸门阈值、改 prompt，都能跑出可比的数字。

**每个降级都有明确边界，写在文档里。** 无 Redis → 进程内滑动窗口限流 + 同步索引；无 pgvector → JSON 向量 + 内存余弦；无向量模型 → 确定性本地哈希；全都没有 → 词法 + 子串召回。不是「优雅降级」这种空话，是四条确定路径。

---

## 技术栈

Next.js 15（App Router）· React 19 · TypeScript · PostgreSQL + Drizzle ORM + pgvector · Redis + BullMQ（可选）· Vercel AI SDK · Ant Design（深色主题）

规模：90 个 API 路由 · 32 张表 · 21 个治理模块 · 47 个 TSX 组件。

## 目录结构

```
app/
  chat, knowledge, docs, ppt, files, projects, memory, skills,
  connectors, capabilities, schedules, work, admin   页面
  api/                                              90 个路由，统一走 withApi 鉴权
lib/
  db.ts, schema.ts       PostgreSQL + Drizzle + 自动建表 / 迁移 / 预置模型
  ai/                    模型解析、RAG 检索、分块、向量、重排、记忆、本地演示
  agent/                 治理层：运行时校验、幂等、护栏、防打转、模型分档、预算
  connectors/ tools/     连接器生命周期、统一工具注册表
  auth.ts, crypto.ts, ssrf.ts, guardrails.ts, resilience.ts
evals/                   golden set + 对抗集 + 结构化判定器 + 趋势
scripts/                 release 流程、文档链接检查、UI 规范检查
docs/                    7 层文档，见下方导航
tests/                   67 个测试文件
```

---

## 质量

以下数字由 `pnpm check` 与 `DEMO_MODE=1 pnpm eval` 实测产出（v8.14.0）：

| 项目 | 结果 |
|---|---|
| 单元测试 | 67 个文件，**956 用例（949 通过 / 7 跳过）** |
| 类型检查 | `tsc --noEmit` 0 错误 |
| 界面规范 | 47 个 TSX，0 违规（禁止硬编码颜色、禁止配色表外 Tag） |
| 文档链接 | 45 个 Markdown，0 断链 |
| RAG 评测 | golden set 38 条，**37/38**（拒答 25/26、检索命中 12/12） |
| 对抗评测 | **20/20**（提示注入、越权指令、凭据外泄） |

跳过的 8 条是需要真实数据库或真实模型的 e2e，由 `QA_PGVECTOR_E2E=1` / `QA_IDEM_E2E=1` 开关控制，CI 里不跑。

```bash
pnpm check        # typecheck + 界面规范 + 单元测试
pnpm eval         # RAG 评测（需模型，或用 DEMO_MODE=1 跑本地）
pnpm e2e          # Playwright 端到端
```

---

## 文档导航

按「我要做什么」找，索引在 **[`docs/README.md`](docs/README.md)**。

| 你想 | 看这里 |
|---|---|
| 把它跑起来 | [`docs/00-快速开始.md`](docs/00-快速开始.md) |
| 知道 33 条 Agent 能力分别落在哪段代码 | [`docs/02-设计/Agent能力矩阵.md`](docs/02-设计/Agent能力矩阵.md) |
| 改界面 | [`docs/04-规范/界面开发规范.md`](docs/04-规范/界面开发规范.md) |
| 参与贡献 / 提 PR | [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`docs/04-规范/Git分支与发布规范.md`](docs/04-规范/Git分支与发布规范.md) |
| 报告安全问题 | [`SECURITY.md`](SECURITY.md) |
| 看每个版本改了什么 | [`CHANGELOG.md`](CHANGELOG.md) |
| 看技术推演与踩坑过程 | [`docs/02-设计/技术说明-学习版.md`](docs/02-设计/技术说明-学习版.md) |
| 了解评测怎么做的 | [`evals/README.md`](evals/README.md) |

---

## 分支与发布

`main` 是可发布基线，只接受 `release/*` 的合并：

```bash
pnpm hooks:install            # 随 pnpm install 自动装
pnpm release:start 8.15.0     # 从 main 切 release 分支并同步版本号
pnpm release:check            # 门禁：typecheck + 界面规范 + 单测 + 文档链接
pnpm release:finish 8.15.0    # 合回 main、打 tag、删分支
```

维护者由 [`.release-owner`](.release-owner) 指定。完整规则（分支命名、MR、多人协作、版本号口径）见 [`docs/04-规范/Git分支与发布规范.md`](docs/04-规范/Git分支与发布规范.md)。

## 许可

[Apache License 2.0](LICENSE) © 2026 XiaoZuiNiZhenHao
