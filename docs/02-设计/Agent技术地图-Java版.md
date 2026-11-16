# Agent 技术地图（Java 版）

> **本文档要解决什么问题**：本项目（Next.js + TypeScript）已落地的 33 条 Agent 工程能力，如果换成 Java 技术栈重做一遍，
> 每一条该落在哪个组件上、哪些框架直接给、哪些必须自己写。
>
> **本文档不是什么**：不是 Spring AI 的使用手册，也不是把 TypeScript 逐行翻译成 Java。
> 语言换了，能复用的是**抽象和踩坑判断**，不能复用的是调用细节。
>
> **基准来源**：[`Agent能力矩阵.md`](Agent能力矩阵.md)（33 条清单 → 文件级落点）、[`技术说明-学习版.md`](技术说明-学习版.md)（原理与踩坑）。
> 本文每条映射都能回溯到那两份文档里的具体条目，不新增无出处的说法。
>
> 编写时间：2026-10-30。**框架版本与 Maven 坐标以官方 BOM 为准**，本文只锁定「能力边界」，不锁版本号。

---

## 0. 一句话结论

**Java 生态在「跑通一个 Agent Demo」上比 Python 慢，在「把它做成生产系统」上比 Python 快。**
Spring AI 给你的是**零件库**（模型抽象、向量库适配、文档 ETL、MCP 客户端），不是**方案**。
本项目踩过的 33 个坑里，框架现成覆盖的不到三分之一，剩下的全是业务语义——而这部分恰恰是 Java 工程师的强项。

所以 Java 版的正确姿势是：**用 Spring AI 做地基，用工程化补天花板**，而不是找一个「Java 版 LangChain」去套。

---

## 1. 先看清生态供给：三分法

选型前必须先分清一件事：一个能力是「框架白给」「半成品」还是「必须自研」。
把半成品当白给，会在上线后才发现缺的那一半正好是要命的那一半。

| 能力 | 生态供给 | 说明 |
|---|---|---|
| 模型接入（OpenAI 兼容） | 🟢 白给 | `ChatModel` / `EmbeddingModel` 抽象 + starter 自动配置 |
| 流式返回 | 🟢 白给 | `ChatClient.stream()` → `Flux<String>`，WebFlux 直出 |
| 多 provider 切换 | 🟢 白给 | 换 starter + 换配置 |
| 文档解析（pdf/docx/xlsx） | 🟢 白给 | Tika / POI 走 ETL Pipeline |
| 向量存储与相似度检索 | 🟢 白给 | `VectorStore` + PgVectorStore / Chroma 适配 |
| MCP 客户端 | 🟡 半成品 | 官方 starter 有，但工具命名冲突、健康检查要自己补 |
| 工具调用（Function Calling） | 🟡 半成品 | `@Tool` 能跑，但**权限、审批、审计、动态注册**全缺 |
| 文本分块 | 🟡 半成品 | `TokenTextSplitter` 只按 token 切，中文与小数会切坏 |
| 对话记忆 | 🟡 半成品 | `ChatMemory` 是窗口缓冲，不是「可检索的长期记忆」 |
| RAG 编排 | 🟡 半成品 | `QuestionAnswerAdvisor` 是一条直线，没有闸门 |
| 相关性闸门 | 🔴 自研 | 分数阈值 + 中文词面重合双条件 |
| 跨 embedding 模型隔离 | 🔴 自研 | 不隔离就会拿两套不可比的向量算相似度 |
| 工具注册表（四段式） | 🔴 自研 | 权限 → 审批 → 超时 → 审计 |
| 双中止源 | 🔴 自研 | 客户端断开 + 服务端超时，任一触发即断流且保证落库 |
| 声明式编排 + 暂停续跑 | 🔴 自研 | 框架的状态图反而让「从第 N 步续跑」更难写 |
| Critic 结构化判定 | 🔴 自研 | 必须 fail-closed，不能让模型自然语言决定通过与否 |
| SSRF 三层防护 | 🔴 自研 | 只要服务端替用户发请求就必须有 |
| 全链路 traceId | 🟡 半成品 | Micrometer + context-propagation 能透传，埋点语义要自己定 |
| 熔断 / 重试 / 限流 | 🟢 白给 | Resilience4j 全套 |
| 异步队列 | 🟢 白给 | Spring 的 `@Async` + 虚拟线程，或接 MQ |
| 单测 / 集成测试 | 🟢 白给 | JUnit 5 + Testcontainers + WireMock + Awaitility |

> 判断依据：本项目在 `lib/` 下 45 个文件里，**有 21 个是在补上面标 🔴 的部分**。
> 这不是「重复造轮子」，而是框架的抽象层级到不了业务语义层。

---

## 2. 选型总表（按层）

| 层 | 职责 | Java 选型 | 关键取舍 |
|---|---|---|---|
| **L1 接入层** | 模型、Embedding | Spring AI `ChatModel` / `EmbeddingModel` | 走 OpenAI 兼容协议，不为每家厂商单独适配 |
| **L2 上下文层** | 分块、检索、闸门、记忆 | 自研编排 + Spring AI `VectorStore` | 向量库用 pgvector 而非独立向量服务 |
| **L3 执行层** | 工具注册、调用、审计 | 自研 `ToolRegistry` 包一层 `@Tool` | 不直接用注解做唯一入口 |
| **L4 编排层** | 多角色、多节点、暂停续跑 | 自研状态机（不用 LangGraph4j） | 需求是线性的，状态图是过度抽象 |
| **L5 流式层** | 事件协议、中断 | WebFlux `Flux` + 自定义事件类型 | 不用 SSE 默认 `data:` 单通道 |
| **L6 韧性层** | 重试、熔断、限流、缓存、队列 | Resilience4j + Redis + 虚拟线程 | 4xx 不计入熔断失败 |
| **L7 安全层** | SSRF、密钥、越权、注入 | 自研校验器 + JCE AES-GCM | 密钥进库前加密，不进配置文件 |
| **L8 观测层** | trace、用量、成本 | Micrometer + MDC + context-propagation | 不引 OpenTelemetry 也能先跑通 |

---

## 3. 逐层映射

### 3.1 L1 接入层：模型接入与能力标记

**本系统怎么做**（`lib/llm.ts`、`lib/ai/providers.ts`）

- 模型配置入库（`models` 表），后台可视化新增，换模型不发版；
- `capabilities` 标记 `chat / tools / vision / embedding`；
- `resolveModelWithFallback()` 做失效降级 + 30 秒内存缓存；
- `withRetry()` 只重试瞬时错误（429 / 5xx / 网络），4xx 不重试；
- **动态 `maxTokens`**：`ctxLen/2` 夹在 2048–8192 之间。

**Java 版怎么做**

```
ChatClient.builder(chatModel)
    .defaultAdvisors(...)
    .build()
```

模型元数据**不要放在 `application.yml`**，要建表。原因很实际：换模型、加模型是运维动作而不是发版动作，写进配置文件意味着每次都要走一次发布流程。

**必须自研的两件事**：

1. **能力标记**。Spring AI 按模型类型区分（`ChatModel` / `EmbeddingModel`），但**不告诉你这个模型支不支持 tool calling**。
   把工具硬塞给不支持 tools 的模型，现象是「模型反复调工具却不出正文」——本项目踩过，排查花了很久。
   做法：模型表里加 `capabilities` 数组，调用前判 `supportsTools`。
2. **动态 `maxTokens`**。Spring AI 的 `ChatOptions` 是静态的。思考型模型（reasoning 类）的推理 token 先吃预算，
   固定值会导致「想了 30 秒，正文一个字没有」。必须按输入上下文长度动态算，并在观察到空正文时重试。

**重试的边界**：`Resilience4j` 的 `retry` 默认对所有异常生效，这在本场景是错的。
参数错误（400）重试 3 次 = 白烧 3 倍 token 且把错误延迟放大 3 倍。必须写自定义 `RetryConfig` 的 `retryExceptions` 白名单。

---

### 3.2 L2 上下文层：RAG 是重点，也是框架帮助最小的地方

这一层是全部 8 层里**框架供给最弱、自研量最大**的。Spring AI 能给你 `VectorStore.similaritySearch()`，
但生产环境里真正决定效果的四件事它都不管。

#### ① 语义分块

**本系统的教训**：`splitText()` 被改过三轮。

| 版本 | 问题 | 后果 |
|---|---|---|
| v1 固定 800 字硬切 | 把一句话劈成两半 | embedding 语义失真，召回质量差 |
| v2 按句末标点切 | **把 ASCII `.` 一律当句末** | `T2.5` → `T2.\n5`，一篇周报 108 处 |
| v3 当前 | 段落 → 句子 → 硬截断 + 重叠，且保护数字 | — |

`TokenTextSplitter` 属于 v1 那一档。**必须自己写分块器**，核心是两个正则约束：

- 句末判定只能认全角标点（`。！？；`）和「后面跟空白」的半角标点；
- 切完之后要断言「不产生 `数字.换行 数字` 这种断裂」。

#### ② 相关性闸门（最关键的一环）

本系统的真实故障：「问『你好』也返回三条参考来源」。

原因是国产 embedding 的余弦基线偏高，`score > 0` 等于**问什么都召回**。只看向量分数是不可靠的。

```java
// 双条件闸门：分数够高 或 词面有实质重合
boolean keep = hit.score() >= 0.62
            || zhBigramOverlap(question, hit.text()) >= 0.1;
```

`zhBigramOverlap` 是中文二元组重合率。为什么不用分词？因为中文分词要引入词典 + 分词的歧义处理，
而这里只需要「能不能对上字」，二元组足够且零依赖。

**这是本层最该抄的一条**：任何 RAG 系统只要没做闸门，它的「参考来源」基本都是装饰。

#### ③ 跨模型向量隔离

换过 embedding 模型之后，新旧向量**不可比**。混在一起算余弦相似度，结果完全无意义，而且**不报错**。

做法：按 `embedding_model` 分组检索，只有单模型时才走向量索引快路径；多模型时分别算再合并。

#### ④ 向量存储选型：pgvector vs 独立向量服务

| 方案 | 优点 | 代价 |
|---|---|---|
| **pgvector**（本项目） | 少一个运维组件；向量和业务数据同库同事务 | 向量计算吃主库 CPU；大规模要调 `ivfflat` / `hnsw` 参数 |
| **Chroma / Milvus**（你的生产项目） | 向量检索专用，水平扩展容易 | 多一次网络跳；多一套备份与权限；跨库无法事务 |

**给一个判断线**：单表切片数 10 万以内、QPS 不高，pgvector 够用且省心；超过这个量级或需要多副本读写分离，再拆独立服务。
不要一开始就拆——本项目的 `isVectorSupported()` + JSON 内存余弦降级路径，就是为了「没装 pgvector 扩展也能跑起来」，
避免演示环境直接 500。

#### ⑤ 一个容易忽略的工程点：`VectorStore` 没有「只补空向量」的语义

后台重建索引时，如果只处理「没有向量」的行，那么**之前降级成低维向量的行永远不会被重算**，
文档状态还显示「已索引」。这是本项目真实踩过的坑。

Java 版对应做法：重建前先把 `embedding` 置空，或者额外维护一个 `embedding_model` 字段做版本比对。
同时接口要返回 `degraded` 标记，界面上打「向量降级」标签——**不然用户永远不知道自己查到的是降级结果**。

---

### 3.3 L2 记忆层：`ChatMemory` 不是长期记忆

Spring AI 的 `ChatMemory`（窗口缓冲 + 持久化）解决的是「本次对话的上下文不丢」，
不是「跨会话记住用户偏好」。

本项目把它们分成两套（`lib/ai/memory.ts`）：

| | 会话记忆 | 长期记忆 |
|---|---|---|
| 载体 | 消息表 | `memories` 表 |
| 生命周期 | 一次会话 | 长期，可检索 |
| 生成方式 | 直接读 | 对话后 **fire-and-forget** 抽取 |
| 检索方式 | 按会话 id | 词面预筛 + 向量排序 |

两个必须自己做的判断：

1. **抽取必须异步**。`await extractMemories()` 等于在首字路径上挂一次额外的 LLM 调用，首字延迟直接翻倍。
   Java 版用 `@Async` + 虚拟线程即可，但**必须吞掉异常**——记忆抽取失败不能影响主流程。
2. **检索必须先做词面预筛**。全表加载再内存排序，记忆一多就 O(n) 雪崩。
   本系统的做法是 `ILIKE` 预筛 + 候选上限 500。

---

### 3.4 L3 执行层：工具注册表的价值不在「能调」，在「调得可控」

Spring AI 的 `@Tool` 注解很好用，但它把**定义、实现、暴露**绑死在一个类上。三个后果：

- 加一个工具要改代码 + 发版；
- 无法在运行期做权限判断（谁能调这个工具）；
- 无法在做审计时区分「模型要调」和「实际调了」。

本项目的做法是「注册表包一层」（`lib/tools/registry.ts`），四段式：

```
权限（role >= required）
  → 审批（requiresApproval → 落 operations 表，等人工确认，approved 后不再二次进审批）
  → 超时（withTimeout，默认阈值，防止下游卡死阻塞整个 Agent 循环）
  → 审计（入参 + 返回 + 耗时 + 是否失败，入参做 PII 脱敏）
```

**Java 版落地建议**：

- 保留 `@Tool` 作为「暴露给模型的函数签名」，但**唯一入口走注册表**；
- 注册表存 `name / title / description / parameters / permission / requiresApproval / timeoutMs / invoke`；
- `parameters` 用 JSON Schema 字符串存，不要用反射生成——模型看到的是 JSON Schema，反射生成的经常多出内部字段。

**另外两个真实细节**：

- **`maxSteps` 硬上限 + System Prompt 软纪律，缺一不可**。本项目设 `maxSteps: 5`。
  思考型模型会陷入「检索 → 不满意 → 再检索」的循环，迟迟不出正文。
- **工具返回要定界**。MCP 或三方 API 返回的内容统一包 `<untrusted_data>...</untrusted_data>`，
  否则「文档里埋的指令」会被当成用户指令执行。这是间接提示注入的主要入口。

#### 超时值的确定方法

不要凭感觉。本项目 `withTimeout` 的阈值来自实测：`read_wiki_structure` 一次 625ms，
所以默认给 30s 是充裕的；而健康检查给 5s，因为它只是探测。

---

### 3.5 L4 编排层：为什么不用 LangGraph4j

这是本文档最需要说清的一个取舍。

**需求实际只有这么大**：线性步骤 + 4 种角色 + 4 种控制节点 + 轨迹可视化 + 人审暂停续跑。
本项目用 238 行 TypeScript 写完了（`lib/agent/engine.ts`）。

```
节点类型     llm（角色化生成）/ tool / condition / loop / human
角色         supervisor / planner / worker / critic
步骤串联      {{input}}（原始输入）、{{prev}}（上一步产出）
控制         maxSteps=20 硬上限、maxRetries=2、human 节点落 resume_index 续跑
```

**为什么不用图框架**：状态图抽象是为「任意拓扑 + 并行 + 子图」设计的。
而这个场景的拓扑是线性的，用图的代价是——**「暂停后从第 N 步续跑」在框架里反而更绕**，
因为你要序列化整个图的状态，而线性流程只需要存一个整数下标。

Java 版对应实现：不需要任何框架，一个 `enum NodeType` + `switch` + 一个 `List<Step>` 就够。

**Critic 的结构化判定（必须抄的一条）**

本项目的 critic 改了三版，第二版的 bug 值得所有人看一眼：

```
模型输出："这个方案不能通过，缺少数据"
JSON.parse 失败 → 退回 /pass|通过/ 正则匹配
   → 句子里含"通过" → 判定为 PASS
```

**校验器把「不通过」读成「通过」，比不校验更危险**——因为它给了人「已经把关」的错觉。

正确实现（`lib/agent/verdict.ts`）：

```
只认纯 JSON（允许 ```json 围栏）
  ├─ 合法      → 采用
  ├─ 不合法    → 把具体校验错误回给模型，要求重出一次（仅 1 次）
  └─ 仍不合法  → fail-closed 判 FAIL，原始输出写进轨迹
```

三条原则：**① 不解析自然语言；② 解析失败要带着错误重试，不是猜；③ 判不准时默认拦下。**

**一个设计陷阱**：末步是 critic 时，最终结果会变成 critic 的 JSON。所以内置技能一律 `planner → worker` 收尾，
critic 只放中间。**设计流程时「谁来产出最终交付物」必须显式想清楚**，这在任何语言里都一样。

---

### 3.6 L5 流式层：不要只用 SSE 的单一通道

**本系统的选择**：手写 NDJSON，自定义事件类型。

```jsonl
{"t":"trace","v":"..."}
{"t":"think","v":"..."}
{"t":"tool_call","v":{"name":"...","args":{...}}}
{"t":"tool_result","v":"..."}
{"t":"delta","v":"正文片段"}
{"t":"done","v":{"usage":{...}}}
```

**为什么不用默认流式**：默认只传正文，导致三个东西没地方放——推理过程（混进正文会污染回答）、
工具调用过程（无法回放）、用量（成本算不准）。

Java 版对应：`ChatClient.stream()` 给的是 `Flux<String>`，正好逐段包成自定义事件。
WebFlux 返回 `Flux<ServerSentEvent<MyEvent>>` 或直接 `Flux<DataBuffer>` 写 NDJSON。

**双中止源**（`abortOnDisconnect`）——这条在 Java 里同样必须做：

```
客户端断开（WebFlux 的 doOnCancel）
  +
服务端超时（timeout）
  → 任一触发即取消上游
  → 但落库逻辑必须继续执行（cancel 后的 enqueue 会抛错，要加守卫）
```

踩过的坑：cancel 之后还往流里 `enqueue` 会抛 `ReadableStream is already closed`，
而异常会连带打断收尾落库，结果是「半截回答 + 用量」全部丢失。
Java 版对应现象是 `IllegalStateException: ... has already been closed`（Reactor 侧）或 `AsyncRequestNotUsableException`。
**结论一样：取消流 ≠ 取消业务收尾，两者要分开 try/catch。**

---

### 3.7 L6 韧性层：Resilience4j 好用，但有三个默认值是错的

| 默认行为 | 为什么错 | 改法 |
|---|---|---|
| 熔断把 4xx 也计为失败 | 参数错了说明下游活着，熔断它属于误杀 | 只对 5xx / 429 / IOException 计失败 |
| 重试对 4xx 也生效 | 白烧 3 倍成本 + 错误延迟放大 | 白名单只留瞬时错误 |
| 限流只在单实例内存 | 多副本时实际阈值 = 阈值 × 副本数 | 有 Redis 就上分布式令牌桶，没有则显式接受偏差 |

**降级路径要成体系**，不是补丁：

```
pgvector 缺失 → JSON 向量内存余弦
Redis 缺失   → 进程内限流器 + 内存缓存
Embedding API 挂 → 本地哈希向量（并在界面上标「向量降级」）
```

判断标准只有一条：**任何单一基础设施缺失，整站不能 500**。
本项目的 `isVectorSupported()` / `MemoryRateLimiter` / `localVector()` 三处就是为了这条。

---

### 3.8 L7 安全层 + L8 观测层

#### SSRF（Agent 接外部工具必踩）

只要「用户填 URL，服务端代发请求」，就有 SSRF。本项目三层：

1. **字面量检查**：协议白名单、禁止 URL 内嵌账号密码、IP 直接判私网段；
2. **DNS 解析后逐 IP 校验**：防 `127.0.0.1.nip.io` 这种域名绕过；
3. **重定向逐跳校验**：防「公网地址 302 跳到内网」。

Java 版注意：`HttpClient` 的默认重定向策略会导致你**看不到中间跳转**。
必须设 `Redirect.NEVER` 自己跟，或者在每一跳前校验。
不做的话，第 3 层等于没有。

#### 密钥

AES-GCM 加密入库（JCE 原生够用），不写配置文件。**加密密钥本身走环境变量**，两者不能放在同一个地方。

#### traceId 在 Java 里的真实难点

TypeScript 版用 `AsyncLocalStorage`，异步链路天然透传。Java 有三个断点：

| 场景 | 传递方式 |
|---|---|
| 同步调用 | `MDC`（ThreadLocal） |
| 虚拟线程 | MDC 需手动继承（`InheritableThreadLocal` 或显式传参） |
| Reactor 流 | MDC 无效，要走 `contextWrite` + `Micrometer Context Propagation` |

**这是 Java 版比 TS 版多出来的工作量**，必须算进排期，否则会出现「日志打了 traceId，但流式段全丢」的情况。

---

## 4. 最小骨架：模块划分

```
agent-platform/
├── api/            接口层：Controller + SSE/NDJSON 输出
├── agent/          编排引擎：节点定义、执行器、轨迹、暂停续跑
├── tools/          工具注册表：ToolDef、四段式调用链、内置工具
├── rag/            分块、embedding、检索、闸门、重排
├── memory/         会话记忆 + 长期记忆抽取与检索
├── llm/            模型解析、failover、重试、动态 maxTokens
├── gateway/        能力网关：OpenAPI 发现、审批、SSRF
├── guard/          提示注入检测、PII 脱敏、输出体检
├── obs/            traceId、LLM 日志、用量与成本
└── common/         加解密、限流、熔断配置、util
```

依赖方向单向：`api → agent → tools → gateway`，`rag` / `memory` / `llm` 被上层依赖但不反向依赖。
`guard` 和 `obs` 横向切面，谁都能用。**不允许 agent 直接依赖 api**。

Maven 依赖（坐标以官方 BOM 为准）：

```
spring-boot-starter-webflux          // 流式必须
spring-ai-bom + starter-model-openai // 模型接入
spring-ai-starter-vector-store-pgvector
spring-ai-starter-mcp-client
ai.djl / tika                        // 文档解析
resilience4j-spring-boot3
spring-boot-starter-data-jdbc 或 jOOQ
postgresql + pgvector
spring-boot-starter-data-redis
micrometer + context-propagation
junit5 + testcontainers + wiremock + awaitility  // 测试
```

---

## 5. 三个 Java 特有的坑（TS 版没有）

1. **虚拟线程 ≠ WebFlux 二选一**。现实答案是混合：流式出口用 WebFlux（`Flux` 天然背压），
   业务逻辑用虚拟线程写同步阻塞代码（可读性远好于 `flatMap` 套娃）。
   但**两者之间的边界要清楚**：虚拟线程里不要阻塞 Reactor 的事件循环。

2. **`@Tool` 的反射生成 JSON Schema 经常多字段**。模型看到的工具定义必须和你的 `parameters` 完全一致，
   多余字段会让模型填错参数。宁可手写 Schema。

3. **Tika 解析 docx 表格 = 一格一行**。这是本项目花了整轮才修好的问题：
   `extractRawText` 把表格摊平成「一格一行」，模型只能靠数格子来对齐列。
   正确做法是走 HTML 转换（`convertToHtml`）再自研表格转文本：
   - 单元格数众数 ≤ 2 → 键值对（`请求方式：Get`）
   - ≥ 3 且首行每格都短且不是 URL → 数据网格（`区域: 甲区；电流: 22`），每 15 行重插表头
   - `colspan` **只折叠不展开**——合并单元格是排版，不是语义列

   Java 版对应：`mammoth` 没有官方 Java 版，可以用 Apache POI 读 `XWPFTable`，
   或者 LibreOffice headless 转 HTML 再解析。**别指望 Tika 直接给你表格结构。**

---

## 6. 学习路径（按依赖顺序，8 天）

| 天 | 主题 | 对应本文档 |
|---|---|---|
| 1 | Spring AI 跑通一次流式对话 | §3.1 |
| 2 | 工具注册表 + `@Tool` 包装 + 超时审计 | §3.4 |
| 3 | 分块器（含中文与小数字保护）+ 单测 | §3.2 ① |
| 4 | pgvector 检索 + 相关性闸门 | §3.2 ②③ |
| 5 | 长期记忆（异步抽取 + 词面预筛） | §3.3 |
| 6 | 声明式编排引擎 + critic fail-closed | §3.5 |
| 7 | 双中止源流式 + 自定义事件 | §3.6 |
| 8 | Resilience4j 改造 + SSRF + traceId | §3.7 §3.8 |

**顺序不能乱**：第 2 天的注册表是后面所有工具能力的底座；第 4 天的闸门决定 RAG 是不是装饰。
第 6 天的 critic 一定要在第 5 天之后——先把检索做对，才谈得上校验产出。

---

## 7. 与你生产项目的对照

你线上的方案是 **Spring AI + Chroma + OpenAI Embedding + TDEngine/Doris**。本项目是 pgvector + 多 provider。
两者不是替代关系，是不同规模下的不同选择：

| 维度 | 你的生产 | 本项目 | 差异原因 |
|---|---|---|---|
| 向量库 | Chroma（独立服务） | pgvector（同库） | 生产要独立扩缩容；本项目单机够用 |
| Embedding | OpenAI | 国内厂商 + 本地降级 | 生产可付费；本项目要能离线跑 |
| 时序数据 | TDEngine | 无 | 本项目没有设备数据 |
| 编排 | 未涉及 | 自研声明式引擎 | 生产流程固定，不需要用户自定义 |

**可以直接搬回生产的四条**（与规模无关）：

1. 相关性闸门（双条件）；
2. 跨 embedding 模型隔离；
3. 工具四段式（权限 → 审批 → 超时 → 审计）；
4. critic 的 fail-closed。

**这四条不需要换语言，加在你的 Spring AI 工程里就能用。**

---

## 8. 相关文档

- [`Agent能力矩阵.md`](Agent能力矩阵.md) —— 33 条能力的原始落点（TS 版）
- [`Agent技术地图-Python版.md`](Agent技术地图-Python版.md) —— 同一套能力的 Python 映射
- [`Agent框架架构方案.md`](Agent框架架构方案.md) —— 语言无关的架构设计与核心抽象
