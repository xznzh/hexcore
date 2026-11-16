# 变更记录

> 回答一个问题：**从上一版到现在，用这个平台的人需要知道什么、要做什么。**
> 版本号与发布节奏的规则见 [`docs/04-规范/Git分支与发布规范.md`](docs/04-规范/Git分支与发布规范.md) §5。

## 怎么读

| 分组 | 含义 |
|---|---|
| **新增** | 多了什么能力，谁能用上 |
| **修复** | 原来哪里是错的，错的表现是什么 |
| **要做的** | 升级后需要你执行的动作；写「无」就是不用管 |

---

## 未发布

**开箱体验与部署可靠性收口**

### 修复

- **工作台输入框的提示与实际行为不符**：placeholder 与副标题都写着「Enter 发送」，
  但实际行为是「带着问题跳到对话页并预填，由你在那边确认后才发送」。这不是 bug
  （草稿要经用户确认才发出是刻意的），但提示语让人以为已经发出去了——按下 Enter 后
  看到输入框清空、页面跳转，很容易以为在等回答。文案已改为「Enter 带入对话页，确认后发送」。
- **数据库配错时只报「服务器内部错误」，且没有任何可操作的线索**：首次部署最常见的三种
  失败（库没建、主机/端口不对、密码错）此前一律落成一句 500，用户会怀疑是自己填错了表单。
  现在启动时先做一次 `SELECT 1` 自检，失败则把「标题 + 修复建议 + 连接目标」打到日志最前面；
  API 层识别为数据库故障时返回 503 `DB_UNAVAILABLE` 并在日志里追加同一条建议。
  **判定只依赖错误码（`3D000` / `28P01` / `ECONNREFUSED`），不解析错误消息原文**——
  中文 Windows 上的 PostgreSQL 默认 `lc_messages` 是 GBK，错误文本经 UTF-8 通道传出来是乱码
  （`���ݿ� "x" ������`），任何依赖原文的翻译在中文环境里都会失效。
- **熔断器在多副本下等于没有**：失败计数挂在 `globalThis` 的 `Map` 上，A 副本已熔断、
  B 副本一无所知，仍然把请求打向同一个死上游——副本数 N 就放大 N 倍，而它保护的
  恰恰是外部依赖。现在 Redis 为权威源（`breaker:<key>` 哈希，TTL 为冷却期两倍）、
  进程内 Map 作镜像与降级，读取时合并取失败数更大者；未配置 Redis 时退回单机语义，功能不丢。
  `guardCircuit` / `markCircuitFailure` 等因此改为 async。
- **演示模式下第一句话就失败**：前端会把上次选中 / 种子数据里的默认模型 id 传给后端，
  而这些预设多半没有 Key，请求直接打到不存在的端点，绕过整条降级链。
  现在服务端在 `DEMO_MODE=1` 时忽略客户端传入的 modelId，`/api/models` 也会把
  演示模型标成默认项，并给未配置 Key 的模型打上「未配置」标记。
- **模型报错直接以英文原文进气泡**：`Failed after 3 attempts. Cannot connect to API...`
  这类上游原文现在统一归类为中文说明（连不上 / 鉴权 / 限流 / 模型不存在 / 超时 / 上下文超限），
  原始错误只进服务端日志；失败回答不再追加「参考来源」，并用警示气泡与正常回答区分。
- **纯 HTTP 内网部署登录静默失败**：生产环境默认给会话 Cookie 加 `Secure`，
  浏览器在 `http://<IP>` 上会直接丢弃，表现为「输完密码又回登录页」且无任何提示。
  `docker-compose.yml` 现在默认 `COOKIE_SECURE=0`，启动日志也会给出明确提示。
- **移动端对话页不可用**：会话列表与对话区原先上下堆叠，390px 下两块都被压扁。
  改为覆盖式抽屉（对话区独占整屏，列表点开即用、选中自动收起）。
- **`TrendChart` 条件调用 Hook**：`React.useId()` 在提前 return 之后执行，
  数据从「有」变「空」时会抛 "Rendered fewer hooks than expected"。
- **React 19 下展开携带 key 的 props 会失效**：MCP 工具参数表单与能力 chip 改为显式 `key`。
- **点「新建对话」后发第一条消息，标题永远停在「新对话」**：服务端在首条消息到达时补齐标题，
  前端同步更新，会话列表不再出现多条同名条目。
- **`pnpm-lock.yaml` 中 16 处 integrity 哈希被污染**（混入非 ASCII 字符），
  `pnpm install --frozen-lockfile` 会在这些包上校验失败——CI 与 Docker 构建都会中招。
- 新增模型下拉的「未配置」提示，避免选中必然失败的模型后才发现。
- **开启 `strictNullChecks`，查出 16 处真实类型隐患**，逐处修正而非加 `!` 断言：
  - `withTimeout` 的定时器句柄在闭包里赋值，`finally` 里的 `clearTimeout` 拿到的可能是未赋值变量
    （现在显式允许 `undefined` 并收窄，而不是硬断言）；
  - `parseHeaders` / `parseQuery` 声明返回 `Record<string,string> | undefined`，实际在 catch 里
    `return null`，调用方的 `=== null` 判断在类型上根本不成立——返回类型补齐三态；
  - `resolveModelWithFallback(s.modelId)` 把 `string | null` 传进 `modelId?: string`；
  - `logAction(null, …)` 与 `logAction(userId: string | undefined, …)` 签名不一致；
  - `const conds = []` 推成 `never[]`，Drizzle 的 `and(...conds)` 条件全部报错；
  - 测试里 `meta?.detail`：第 4 个参数在签名上可选，改用可选链后「没传」会正常判为失败用例。
- **`withApi` 的返回值签名与 Next 15 的参数校验对齐**：包装器把第二个参数声明成可选，
  而 Next 生成的 `.next/types/**` 用 `SecondArg<>` 取该参数去和必填的 `RouteContext` 比对，
  开启严格模式后 124 个路由的生成校验全部失败、`next build` 直接卡在类型检查。
  现在用两条重载表达（最后一条是两个必填参数），测试仍可只传 `req`。
- `vitest.config.ts` → `vitest.config.mts`（连同两个 eval 配置）：文件用 ESM 语法却按 CommonJS 加载，
  Vite 会警告「未来主版本将强制按 ESM 解析」。改名后把 `__dirname` 换成 `import.meta.dirname`，
  并把 `**/*.mts` 纳入类型检查。

### 新增

- **`GET /api/metrics`（Prometheus 文本格式）**：请求量 / 错误率 / 耗时分布、对话轮次与
  **首字耗时**、模型调用与 token 用量、护栏命中、熔断状态、队列积压、进程内存。
  数据一直是有的（`withApi`、`logLlm`、护栏、熔断），只是没有出口——没有时间序列时，
  HPA 只能按 CPU 扩容，而本系统的瓶颈是首字延迟与 token 吞吐。
  `lib/metrics.ts` 零依赖实现（计数器 / 直方图 / 文本导出），`METRICS_TOKEN` 可选加锁。
  说明见 [`docs/02-设计/可观测性与熔断.md`](docs/02-设计/可观测性与熔断.md)。
- **出口治理收成一个门面**（`lib/agent/channel-governance.ts`）：护栏 → 运行时 V 层 →
  语义抽查原本在 `skills/run` 与 `scheduler` 各装一遍，靠「记得」维持。现在
  `governChannelAnswer()` 是唯一实现，`runSkillGoverned()` 把「运行 + 治理」合成一步；
  `tests/source-guards.test.ts` 在源码层拦住绕过门面的写法（裸 `runSkill(` 需登记白名单）。
- 技能在对话里被调用（`run_skill` 工具）现在也过一次技能通道治理：它的产出会先进模型上下文，
  若不拦，等于绕过了外发前的最后一道闸。
- 指标相关的 4 个测试文件：注册表文本格式与基数封顶、路由标签归一化、熔断集群语义、
  指标端点鉴权与缓存头。
- **ESLint 9 门禁**（`pnpm lint`，flat config）：只启用「会真出错」的规则，当前 0 error。
- **对话主流程的阶段索引**：`handleChat` 一千多行是刻意的（各段之间是顺序耦合 + 共享并发的关系，
  拆开只会让「谁真的在并行」更难确认），改为在函数头用八段索引说明每个阶段与关键约束。
- **favicon 与社交分享图**：`app/icon.png`、`public/og.png`，并补齐 `openGraph` / `twitter` 元信息；
  Dockerfile 增加 `COPY public`（standalone 产物不会自带 public）。
- **README 截图**：工作台、对话、知识库三张，均为 `DEMO_MODE=1` 默认状态实拍。
- 错误归类层 `lib/ai/error-text.ts` 及 9 条单测。
- 启动日志：无 Redis 时明确提示「定时任务没有分布式锁，多副本会重复执行」。

### 要做的

- 用 Docker 部署且走 HTTP 的，确认 `COOKIE_SECURE=0`（compose 已默认）；上 HTTPS 后改回 `1`。
- 拉取后执行一次 `pnpm install`：锁文件的哈希修复需要重新落盘，否则 `--frozen-lockfile` 仍会失败。
- 要接监控：把 `/api/metrics` 加进抓取目标；实例若在公网可达，设置 `METRICS_TOKEN` 并让
  抓取端带 `Authorization: Bearer`。示例与告警建议见 `docs/02-设计/可观测性与熔断.md`。
- **多副本部署建议配置 `REDIS_URL`**：没有它熔断会退回单机语义（每副本各算一份），
  定时任务也会被每个副本各跑一次。单副本无需处理。

---

## v1.0.0 · 2026-11-16

**hexcore 初始版本**

- 对话 / 知识库 RAG / 文件管理 / PPT 生成 / 技能市场 / 连接器 / 定时任务 / 记忆 / 管理后台
- 运行时治理：输出护栏、PII 脱敏、审计日志、可评测
- 全链路降级：无 Redis / 无向量库 / 无模型 Key 也能跑（演示模式）
- 门禁：956 单测 / tsc 0 错误 / UI 规范 / 文档链接校验

详情：[`README`](README.md) · [`00-快速开始`](docs/00-快速开始.md)
