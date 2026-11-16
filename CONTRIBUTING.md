# 参与贡献

先说清楚这个项目是什么：一个**可私有化部署的 AI Agent 平台**，强调运行时治理（输出护栏、可追溯、可评测）与全链路降级（无 Redis / 无向量库 / 无模型 Key 也能跑）。定位见 [`docs/03-迭代/项目评估-自用与开源就绪度.md`](docs/03-迭代/项目评估-自用与开源就绪度.md)。

## 先把项目跑起来

```bash
git clone https://gitee.com/XiaoZuiNiZhenHao/hexcore.git && cd hexcore
cp .env.example .env.local     # 首次启动唯一必填项是 APP_SECRET，可随意填
pnpm install
pnpm dev                        # 打开 http://localhost:3000，先注册的账号即管理员
```

**不需要任何模型 API Key**：默认走演示模式，本地合成回答，登录就有示例知识库可问。
完整步骤、Docker 方式、常见故障见 [`docs/00-快速开始.md`](docs/00-快速开始.md)。

环境要求：Node >= 20.9.0、pnpm、Postgres（`DATABASE_URL`；有 Docker 时 `docker compose up -d` 即可）。

## 改代码之前先看这张地图

新人最容易卡住的不是「看不懂某个函数」，是「不知道改的地方在哪」。按下面顺序看，大约 30 分钟能建立全局感：

| 想知道 | 看这里 |
|---|---|
| 一个 API 请求怎么进来、鉴权在哪 | `lib/api/handler.ts` 的 `withApi` —— **默认就要求登录**，只有显式写 `auth: 'none'` 才是公开接口 |
| 对话一次要经过哪些环节 | `app/api/chat/route.ts` → `lib/ai/rag.ts`（检索）→ `lib/ai/providers.ts`（模型）→ `lib/agent/`（护栏与校验） |
| 数据长什么样 | `lib/schema.ts`（drizzle 定义，32 张表）；建表在 `lib/db.ts` 的 `ensureInit()` |
| 检索怎么算相关 | `lib/ai/rag.ts`：向量快路径（pgvector）→ 内存词法兜底 → `blendScore` → 相关性闸门 |
| 模型怎么接 | `lib/ai/providers.ts`：统一 OpenAI 兼容接口，国产模型 / Ollama / 演示模式都走这一层 |
| 治理层有哪些 | `lib/agent/`（21 个模块）：输出护栏、运行时校验、幂等、防打转、质量告警 |
| 怎么证明「改好了」 | `tests/`（956 个用例）+ `evals/`（38 条评测基线，`pnpm eval`） |

## 分支与提交

**`main` 在服务端是受保护的**：不能直推、不能强推、不能删除，任何人都只能通过 Pull Request 合入，且只有维护者能点合并。本地还有 git hook 做第一道拦截。

一条改动要走完的路径：

```bash
git switch -c feature/your-topic          # 从 main 切，命名 feature/<主题>
# ... 改动 ...
pnpm check                                # 提交前自检：typecheck + 界面规范 + 全量单测
git commit -m 'fix(rag): 中文问句两轮召回'
git push -u origin feature/your-topic     # 推自己的分支
# 在 Gitee 开 PR：feature/your-topic → main
```

维护者收尾（维护者专用，贡献者不用管）：

```bash
git switch main && git pull --ff-only
pnpm release:tag 8.18.0 --push            # 在 main 的合并提交上打 tag
```

- 提交信息用 `<type>(<scope>): <描述>`，type 取 `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`
- 一个提交只做一件事。功能改动和顺手重构请拆开
- **不要**直接 `git push origin main`，也**不要** `--force` 推任何已推送的分支——保护规则会把你的推送转成一个 PR，看着像成功了，其实白忙一趟
- 完整规则（含保护分支配置与实测回执）见 [`docs/04-规范/Git分支与发布规范.md`](docs/04-规范/Git分支与发布规范.md)

## 门禁

提交时 hook 会自动跑 `tsc --noEmit`，完整门禁需手动跑：

```bash
pnpm check     # = typecheck + lint:ui（界面规范）+ vitest（956 用例）
```

界面改动还有额外约束，写之前请读 [`docs/04-规范/界面开发规范.md`](docs/04-规范/界面开发规范.md)（颜色 token、间距、可访问名都有源码级守卫）。

## 提 PR 时请附上

1. **你验证过的命令**，以及输出里能证明改动生效的那几行。只写「已测试」不算
2. **如果是修 bug**：改之前的表现是什么、根因是什么。这个项目的 CHANGELOG 只写根因不写「优化了」，请保持
3. **如果是 UI 改动**：前后截图
4. **如果改了检索 / 评测相关**：贴 `pnpm eval` 的前后对比（答题 / 拒答 / 检索命中共三项）

## 不会接受的改动

这些不是「不好」，是在当前阶段收益不够，提了大概率会被拒，提前说明省得白做：

- **大规模重命名 / 目录重组 / 引入新的分层**。现有 L1–L5 分层是刻意设计的，见 `docs/02-设计/`
- **全量开 `tsconfig` 的 `strict`**。当前 `strict: false`，存量 `any` 有 442 处，属于已知技术债；**但新代码请尽量不要引入新的 `any`**
- **引入新框架替换现有选择**（换成 Prisma / 换成 LangChain / 换成 Turborepo 之类），除非有可复现的、现有方案解决不了的问题
- **纯格式化 PR**（全仓缩进、引号风格），会和现有提交历史冲突

## 发现安全问题

**不要开 public issue**，请按 [`SECURITY.md`](SECURITY.md) 的方式私下报告。

## 许可证

贡献的代码按 [Apache-2.0](LICENSE) 授权。提交 PR 即表示你同意以此协议发布你的贡献。
