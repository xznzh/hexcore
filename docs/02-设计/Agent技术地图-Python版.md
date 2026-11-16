# Agent 技术地图（Python 版）

> **本文档要解决什么问题**：本项目（Next.js + TypeScript）落地的 Agent 工程能力，换成 Python 技术栈该怎么做。
>
> **与 Java 版的分工**：能力分层、抽象、踩坑结论三份文档共用，**本文只写 Python 不同的那部分**——
> 哪些事 Python 做得比 TypeScript 容易、哪些比 Java 难，以及 Python 生态独有的四个坑。
> 分层定义见 [`Agent技术地图-Java版.md`](Agent技术地图-Java版.md#2-选型总表按层)，不在此重复。
>
> **基准来源**：[`Agent能力矩阵.md`](Agent能力矩阵.md)、[`技术说明-学习版.md`](技术说明-学习版.md)。
> 编写时间：2026-10-30。**框架版本与包名以官方文档为准**，本文只锁能力边界。

---

## 0. 一句话结论

**Python 在「验证一个 Agent 想法」上最快，在「让它长期稳定运行」上最费劲。**

它有三样东西是另外两个生态没有的：**MCP 官方 SDK**、**本地 embedding**、**评测工具链**。
这三样恰好覆盖本系统最费力的三个部分。但它也有一个结构性弱点：**异步传播靠自觉**——
一个 `requests.get` 就能让整站卡住，而编译器不会提醒你。

所以 Python 版的正确姿势是：**用最少的框架，把 async 边界管死**。

---

## 1. 三项独有优势（这是选 Python 的真正理由）

### ① MCP 官方 SDK 最完整

本项目的 MCP 客户端（`lib/mcp/client.ts`）是照着协议手写的：

```
initialize → notifications/initialized → tools/list → tools/call
会话头 Mcp-Session-Id，协议版本头 MCP-Protocol-Version
响应形态同时兼容一次性 JSON 与 SSE（data: 帧），批量数组按 id 命中
```

手写的原因是 TypeScript 侧没有足够成熟的客户端。**Python 侧有官方 SDK**（`mcp` 包，client 与 server 两侧都提供），
上述握手、双形态响应、会话管理都不用自己写。

对本系统的直接收益：`lib/mcp/client.ts` 里最容易出错的两块——**SSE 与 JSON 双形态解析**、**会话 id 续传**——
在 Python 里是 SDK 内部细节。剩下要自己做的只有产品层：工具命名冲突、清单缓存、健康检查。

### ② 本地 embedding 是天生的降级方案

本系统为了「embedding API 挂掉不能整站 500」，自己写了个低维哈希向量（`localVector()`）做兜底。
它只能保证「不崩」，语义质量很差，还要在界面上打「向量降级」标签坦白。

Python 里这件事有正经解法：

```python
from sentence_transformers import SentenceTransformer
model = SentenceTransformer("BAAI/bge-small-zh-v1.5")  # 约百 MB 级，CPU 可跑
```

**本地模型 = 真正的降级路径，不是苟活路径**。API 挂了切本地，检索质量下降但可用，不必向用户坦白「结果不可靠」。

代价要算清楚：首次加载模型有秒级延迟、进程常驻内存、CPU 推理比 API 慢一个数量级。
所以正确做法是「API 优先 + 本地兜底 + 启动时预热」，而不是默认走本地。

> 如果走纯离线的本地文件分析场景（无外部 API，只能靠本地模型），本地 embedding 就是主路径，不存在降级问题。

### ③ 评测工具链现成

本项目的评测是自研的：56 条 golden set + 判定器 + 趋势图（`evals/`）。
Python 侧有 Ragas、DeepEval、promptfoo 可以直接用。

**但这里有个必须做的取舍**：

| 方案 | 成本 | 稳定性 | 适合 |
|---|---|---|---|
| **规则判定**（本项目） | 零 LLM 调用 | 完全确定，可写单测 | 有明确答案的问答（数值、单位、是否拒答） |
| **LLM-as-judge**（Ragas 默认） | 每条一次 LLM 调用 | 有抖动，同输入可能不同结论 | 开放式生成质量（流畅度、完整性） |

本项目的 56 条用例里，判定条件大多是「答案必须包含 64.1 且不得出现 39」这种确定性断言，用规则判定又快又准。
**建议：规则判定做主干，LLM-as-judge 只补充主观项**。反过来会得到一个「每次跑分都不一样」的评测，比没有评测更糟。

本项目判定器踩过的三个坑，Python 版同样会遇到（细节见 `evals/README.md`）：

- `℃` 的 `³`(U+00B3) ≠ `3`，`µ`(U+00B5) ≠ `μ`(U+03BC) → **必须先做 Unicode 归一化再比对**；
- 澄清句「…与 GDP 无关」会被跨逗号的正则抓成编造 → 正则跨度要排除逗号；
- 空模式匹配一切（TS 里是 `new RegExp(undefined)`，Python 里对应 `re.compile("")` 匹配所有）→ 判定条件必须做类型过滤。

---

## 2. 选型总表

| 层 | Python 选型 | 与 Java 的差异 |
|---|---|---|
| **L1 接入** | `openai` SDK（兼容协议）或 **LiteLLM**（统一多 provider） | LiteLLM 比 Spring AI 的模型适配更轻，但少能力标记 |
| **L2 上下文** | 自研分块 + `pgvector` / Chroma + 本地 embedding | 本地 embedding 是 Python 独有 |
| **L3 执行** | 自研注册表 + Pydantic 校验参数 | Python 侧没有 `@Tool` 那种注解绑定，反而更容易做动态注册 |
| **L4 编排** | **LangGraph** 或自研状态机 | 见 §4.1，这是三份文档里唯一分歧点 |
| **L5 流式** | FastAPI `StreamingResponse`（NDJSON）或 `sse-starlette` | 比 WebFlux 简单，但 async 泄漏更致命 |
| **L6 韧性** | `tenacity`（重试）+ `pybreaker`（熔断）+ Redis | 比 Resilience4j 轻，配置项少 |
| **L7 安全** | 自研 SSRF 校验 + `cryptography`（AES-GCM） | 基本相同 |
| **L8 观测** | `structlog` + OpenTelemetry + `contextvars` | `contextvars` 比 MDC 好用，异步天然透传 |

---

## 3. 逐层差异（只写和 Java 不一样的地方）

### 3.1 L1 接入层：LiteLLM 的取舍

Java 侧用 Spring AI 的 `ChatModel` 抽象；Python 侧两条路：

| | 裸 `openai` SDK | LiteLLM |
|---|---|---|
| 多 provider | 每家一个 base_url + key，自己管 | 统一接口，`model="provider/model"` |
| 重试/超时 | 自己写 | 内置 |
| 能力标记 | 完全没有 | 有 model registry，但**不要依赖它判断 tool calling 支持** |
| 额外依赖 | 无 | 一个包，几十个 transitive |

**建议**：provider 少于 3 家就用裸 SDK + 自己封一层，比引 LiteLLM 更可控。
本系统 3 家以内，Java 版走 Spring AI 也是同样理由。

**动态 `maxTokens` 在 Python 里反而更好做**——因为是运行时传参而不是构造 `ChatOptions`。
但要注意：不是所有兼容端点都接受 `max_tokens`，有的叫 `max_completion_tokens`，实际以端点文档为准。

### 3.2 L2 上下文层：分块要自己写，检索可以借力

**分块必须自研**，理由和 Java 一样（`TokenTextSplitter` 那档会切坏中文和小数），Python 侧 `langchain_text_splitters`
同样是按 token / 字符切。本项目 `splitText()` 的三条约束直接可移植：

```
① 段落优先合并短段落，再切（避免切出一堆碎片）
② 句末只认全角标点 + 后半角标点（后面必须跟空白）
③ 切完断言不产生「数字.换行数字」
```

判断标准：**改完分块器必须写单测断言 `re.search(r"\d\.\n\d", text)` 为空**。这条比读代码有用。

**检索可以借力 LlamaIndex**：它的 `VectorStoreIndex` + `retriever` 比 LangChain 专注，文档也清楚。
但注意——**闸门还是得自己写**，LlamaIndex 的 `similarity_top_k` 只管取几条，不管「该不该取」。

Python 侧写闸门比 TS 更短：

```python
def keep(hit, question):
    return hit.score >= 0.62 or bigram_overlap(question, hit.text) >= 0.1

def bigram_overlap(q, t):
    qb = {q[i:i+2] for i in range(len(q)-1) if _is_cjk(q[i])}
    tb = {t[i:i+2] for i in range(len(t)-1) if _is_cjk(t[i])}
    return len(qb & tb) / len(qb) if qb else 0.0
```

**中文二元组不用引入 jieba**——分词要词典、有歧义、多一个依赖，而这里只需要「字能对上」。

### 3.3 L3 执行层：Pydantic 是隐性优势

Java 版建议「手写 JSON Schema，别用反射生成」。Python 侧恰好相反：**用 Pydantic 生成 Schema 是对的**。

```python
class SearchInput(BaseModel):
    query: str = Field(description="检索关键词")
    top_k: int = Field(default=5, ge=1, le=20)
```

`model_json_schema()` 生成的 Schema 干净、无内部字段。Java 反射生成的问题（多出 `class`、`declaringClass` 之类）
在 Pydantic 里不存在。

**四段式调用链在 Python 里更好写**，因为 `**kwargs` + 装饰器组合天然适合包一层：

```
权限检查 → 审批（落库，approved 后跳过）→ asyncio.wait_for 超时 → 审计日志（入参 PII 脱敏）
```

超时用 `asyncio.wait_for`，比 Java 的 `CompletableFuture.orTimeout` 直观。但**必须记住**：
`asyncio.wait_for` 取消的是协程，不是底层 socket——同步库（如 `requests`）根本取消不掉。这就是 §5.1 的坑。

### 3.4 L4 编排层：这里我建议用 LangGraph（与 Java 版结论不同）

**这是三份文档里唯一一个明确分歧，值得单独说明。**

Java 版建议自研 238 行状态机，因为 Java 侧没有成熟的图框架，用 Spring 的 `@Bean` 链写反而更绕。
Python 侧情况相反：**LangGraph 已经足够成熟，且它解决的正是自研最麻烦的那部分**。

| | 自研状态机（本项目做法） | LangGraph |
|---|---|---|
| 线性流程 + 4 种节点 | 238 行，完全可控 | 更短，但要学它的 State 抽象 |
| **暂停续跑（人审）** | 存一个下标 `resume_index` | 内置 checkpointer，天然支持 |
| 并行分支 / 子图 | 要自己加，会变复杂 | 原生支持 |
| 调试 | `print` 轨迹 | 有可视化 |
| 依赖风险 | 无 | 版本变动、抽象泄漏 |

**判断线**：

- 流程是**线性 + 人审暂停** → 自研更省心（本项目的选择，因为暂停续跑只需存一个整数下标）；
- 需要**并行分支、子图、循环嵌套、断点恢复到任意节点** → 用 LangGraph，别自己造。

**无论选哪个，critic 的判定逻辑必须自己写且 fail-closed**（本项目三版演进见
[`Agent技术地图-Java版.md`](Agent技术地图-Java版.md#35-l4-编排层为什么不用-langgraph4j)）：
不能靠正则去猜模型那句自然语言是「通过」还是「不通过」。

### 3.5 L5 流式层：比 Java 简单，但有一个致命细节

FastAPI 里返回 NDJSON 只需要：

```python
async def gen():
    async for chunk in agent_stream(...):
        yield json.dumps({"t": "delta", "v": chunk}, ensure_ascii=False) + "\n"

return StreamingResponse(gen(), media_type="application/x-ndjson")
```

比 WebFlux 简单得多。但有三个细节决定它是不是真的能用：

1. **生成器里任何同步阻塞都会冻结整个事件循环**（不只是这一个请求）——见 §5.1；
2. **客户端断开要能感知**：`await request.is_disconnected()` 或用 `BackgroundTasks` 收尾。
   本项目踩过的坑是「取消流之后还往流里写，异常连带打断落库」→ 取消 ≠ 取消业务收尾；
3. **`ensure_ascii=False`**：不设会输出 `\u4e2d\u6587`，前端多一次解析且体积翻三倍。

### 3.6 L6 韧性层：轻，但默认值同样有坑

`tenacity` 做重试要显式指定异常类型：

```python
@retry(retry=retry_if_exception_type((httpx.TimeoutException, RateLimitError)),
       stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=8))
```

**默认 `retry=retry_if_exception_type(Exception)` 会把 4xx 也重试**——和 Java 版同一个坑，
只是 Java 需要改 `RetryConfig`，Python 需要改装饰器参数。

`pybreaker` 的默认也是「任何异常都计失败」，同样要显式排除客户端错误。

**降级三件套**（和 Java 版一致）：

```
pgvector 未装 → numpy 内存余弦
Redis 未连   → 进程内令牌桶
Embedding 挂 → 本地 sentence-transformers（Python 独有，质量优于 Java 版的哈希兜底）
```

### 3.7 L8 观测层：`contextvars` 是 Python 的加分项

TypeScript 用 `AsyncLocalStorage`，Java 要在 MDC / Reactor Context / 虚拟线程三者之间折腾，
Python 用 `contextvars` 即可——**`asyncio` 的每个 Task 自动继承上下文**。

```python
trace_id: ContextVar[str] = ContextVar("trace_id", default="-")
```

中间件 set 一次，之后所有 `async` 函数里都能读到。唯一例外是 `run_in_executor` 进线程池时会丢，
需要显式 `copy_context()` 传入。**这一条要写进规范**，否则 CPU 密集任务（分块、本地 embedding）的日志会丢 trace。

---

## 4. 最小骨架

```
agent_platform/
├── api/          FastAPI 路由 + 流式输出
├── agent/        编排：节点定义、执行器、轨迹、检查点
├── tools/        注册表 + 四段式调用链 + 内置工具
├── rag/          分块、embedding（含本地兜底）、检索、闸门
├── memory/       会话记忆 + 长期记忆抽取
├── llm/          客户端、failover、重试、动态 maxTokens
├── gateway/      能力网关、OpenAPI 发现、审批、SSRF
├── guard/        注入检测、PII 脱敏
├── obs/          trace、LLM 日志、用量
└── common/       加密、限流、熔断配置
```

依赖方向与 Java 版一致：`api → agent → tools → gateway`，`rag/memory/llm` 被依赖不反向，
`guard/obs` 横向切面。

```
fastapi + uvicorn
httpx（异步 HTTP，不要用 requests）
pydantic v2
sqlalchemy 2.x 或 asyncpg
pgvector
numpy
sentence-transformers（可选，本地 embedding）
redis
tenacity + pybreaker
cryptography
structlog + opentelemetry-sdk
mcp（官方 SDK）
pytest + pytest-asyncio + respx（HTTP 打桩）
```

---

## 5. 四个 Python 特有的坑

### 5.1 一个同步调用就能冻结整站（头号杀手）

FastAPI 里 `async def` 的函数如果调用了同步阻塞代码，**整个事件循环停住**——
表现不是「这个请求慢」，而是「所有请求一起卡住，包括健康检查」。

三个最常见触发点：

| 错误写法 | 后果 | 正确写法 |
|---|---|---|
| `requests.get()` | 阻塞，无法取消 | `httpx.AsyncClient` |
| `time.sleep()` | 阻塞 | `asyncio.sleep()` |
| 同步 DB 驱动 | 阻塞 | `asyncpg` / SQLAlchemy async |

**流式场景下这个错误特别难发现**：因为单用户测试时一切正常，只有并发时才暴露，
而且现象是「别的接口超时」，很难联想到是流式那个函数里的一行 `requests.get`。

**强制约束**：进入流式生成器的函数调用链上，只允许出现 `async` 版本；
在 CI 里加一条 lint 禁止 `api/`、`agent/` 目录 import `requests` 和 `time.sleep`。

### 5.2 LangChain 的抽象泄漏

想改一个默认行为（比如检索的分数阈值），要穿过 `Chain → Retriever → VectorStore → Client` 四层。
每层都可能覆盖你的参数，且文档不写清楚优先级。

**判断线**：能用 LlamaIndex 或直接用 SDK，就不要用 LangChain 的 Chain。
本项目 45 个 lib 文件里没有一个「框架编排层」，正是因为直接写调用比穿过抽象更快。

### 5.3 GIL：CPU 密集要走进程池

分块（正则）、本地 embedding 推理、大文件解析都是 CPU 密集。
在 `async` 里直接做，会把事件循环堵死——和 §5.1 同样后果，但原因不同。

```python
loop = asyncio.get_running_loop()
chunks = await loop.run_in_executor(process_pool, split_text, text)
```

注意 **`ThreadPoolExecutor` 对 CPU 密集无效**（GIL），必须 `ProcessPoolExecutor`。
代价是进程间要序列化数据，适合大块任务，不适合高频小任务。

### 5.4 依赖地狱：别一上来装 torch

`sentence-transformers` 依赖 torch，torch 的 CPU / CUDA 版本一旦装错，`pip` 会给你一个能 import 但推理报错的组合。
本机如果没 GPU，**必须装 `torch` 的 CPU 版**（`--index-url https://download.pytorch.org/whl/cpu`），
否则会拉一个几 GB 的 CUDA 包还跑不起来。

**建议顺序**：先用 API embedding 把流程跑通，本地模型作为第二阶段的可选增强。
不要因为「本地模型听起来更自主」就在第一天装 torch，那会把大量时间消耗在环境问题上。

---

## 6. 学习路径（7 天）

| 天 | 主题 | 对应 |
|---|---|---|
| 1 | FastAPI + 流式 NDJSON 跑通一次对话 | §3.5 |
| 2 | 工具注册表（Pydantic 生成 Schema）+ 超时审计 | §3.3 |
| 3 | 分块器 + 单测（中文、小数、重复块三条断言） | §3.2 |
| 4 | pgvector 检索 + 相关性闸门 + 跨模型隔离 | §3.2 |
| 5 | 长期记忆（`asyncio.create_task` 抽取）+ 词面预筛 | §3.3 |
| 6 | 编排：LangGraph 或自研，critic fail-closed | §3.4 |
| 7 | MCP 官方 SDK 接一个公开 server + trace 贯穿 | §1① §3.7 |

**和 Java 版的顺序差异**：Python 侧把 async 边界（第 1 天）提到最前，
因为它是后面所有代码的约束条件；Java 侧则是把工具注册表提前，因为 Java 的 async 问题相对可控。

---

## 7. 三方对照：同一件事的不同代价

| 能力 | TypeScript（本项目） | Java | Python |
|---|---|---|---|
| 流式输出 | 手写 `ReadableStream`，最灵活最啰嗦 | WebFlux `Flux`，类型安全 | `StreamingResponse`，最短 |
| 工具定义 | zod schema 手写 | `@Tool` + 反射（要规避） | Pydantic 自动生成 |
| MCP 客户端 | 手写协议 | starter（半成品） | **官方 SDK** |
| 本地 embedding | 自研哈希兜底（质量差） | 需引 ONNX/DJL | **sentence-transformers** |
| traceId 透传 | `AsyncLocalStorage` 天然 | MDC/Reactor/虚拟线程三处 | `contextvars` 天然 |
| 并发模型风险 | 单线程事件循环（同类） | 线程池/虚拟线程（较安全） | 单线程事件循环（最危险） |
| 评测工具 | 自研 | 自研 | **Ragas / promptfoo** |
| 适合阶段 | 前后端一体、快速交付 | 长周期、大团队、强类型 | 算法验证、离线批处理 |

---

## 8. 相关文档

- [`Agent技术地图-Java版.md`](Agent技术地图-Java版.md) —— 同一套能力的 Java 映射（含分层定义）
- [`Agent框架架构方案.md`](Agent框架架构方案.md) —— 语言无关的架构设计与核心抽象
- [`Agent能力矩阵.md`](Agent能力矩阵.md) —— 33 条能力的原始落点
