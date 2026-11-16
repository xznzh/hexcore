# AGENTS.md

小团队协作 AI 智能体平台。Next.js 15 App Router + TypeScript + PostgreSQL(Drizzle) + 可选 Redis/BullMQ + Vercel AI SDK + Ant Design。

## 常用命令

```bash
pnpm dev          # 开发，turbo 模式，端口 3000
pnpm typecheck    # tsc --noEmit（改动后的首选验证，秒级）
pnpm lint         # ESLint 9（flat config），只拦真错：Hook 顺序 / key / Next 约定
pnpm test         # vitest run，仅 tests/*.test.ts
pnpm e2e          # playwright，e2e/smoke.spec.ts
pnpm build        # 生产构建（较慢，非必要不跑）
pnpm release:status  # 当前分支 / 最新 tag / 门禁状态
```

提交前最低要求：`pnpm typecheck` + `pnpm lint` 通过；发版前用 `pnpm release:check`（typecheck + lint + 界面规范 + 单测 + 文档链接）。

## 目录地图

| 路径 | 说明 |
| --- | --- |
| `app/` | 页面（App Router）。业务页：chat / knowledge / docs / ppt / files / projects / memory / skills / connectors / schedules / admin |
| `app/api/` | 91 个 `route.ts`，按域分目录（auth / models / chat / conversations / knowledge / files / skills / admin …） |
| `components/` | 客户端组件；`components/chat/` 是对话子组件，`AppShell` + `Nav` + `SessionContext` 提供持久化外壳 |
| `lib/` | 服务端逻辑。`db.ts`(建表+预置)、`schema.ts`(全部表)、`auth.ts`、`llm.ts`、`ai/`(providers/rag/embed/memory/extract)、`agent/engine.ts`、`scheduler.ts`、`queue.ts`、`storage.ts` |
| `tests/` | vitest 单测（util / crypto / embed / extract / skills-hub） |
| `e2e/` | Playwright |
| `scripts/` | 运维脚本（重置数据、密钥重新加密） |
| `data/` | **运行时**文件与产物，不是源码，不要改不要提交 |

## 代码约定

- 路径别名 `@/*` 指向仓库根；服务端统一 `@/lib/...`。
- 时间戳一律用 `new Date().getTime()` 即 `Date.now()` 存数字，不用 Date 列。
- ID 用 `newId('前缀')`（`lib/util.ts`），前缀按表名简写（`usg` / `log` / `f_xxx`）。
- 新增表改 `lib/schema.ts`，并在 `lib/db.ts` 的初始化里补 `CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER`，保持旧库兼容。
- API 路由模板：`export const dynamic = 'force-dynamic'` → `await ensureInit()` → `getSession()` 判空返回 `{ error: '未登录' }, { status: 401 }` → `NextResponse.json(...)`。
- 风格：单引号、行尾逗号、2 空格缩进、`async/await`。`tsconfig` 是 `strict: true` + `noImplicitAny: false`（分期开启，原因见配置里的注释）；`strictNullChecks` 已开，别用 `!` 断言绕。
- 路由包装器 `withApi` 的返回签名是两条重载，最后一条「两个必填参数」不能改成可选——Next 15 的 `.next/types` 靠它做参数校验，改成可选会让 `next build` 在类型检查阶段失败。
- 外部依赖（Redis / BullMQ / pgvector / Langfuse / embedding 模型）必须「未配置则优雅降级」，不能让其缺失导致请求失败。
- 埋点统一走 `lib/metrics.ts`（`incCounter` / `observeMs` / `setGauge`），不要在业务代码里自己维护计数器：`/api/metrics` 只导出注册表里的东西。给指标打标签前先想基数——带 id 的标签必须先用 `lib/api/route-label.ts` 的 `routeLabel()` 归一化，否则序列会随时间无限增长。
- 非对话通道（技能 / 定时任务 / 新的 workflow）的产出**必须**经 `governChannelAnswer()` 外发，技能通道直接用 `runSkillGoverned()`。裸 `runSkill(` 需要登记进 `tests/source-guards.test.ts` 的白名单——登记意味着「我知道这条通道要自己接治理」，而不是默默忘掉。
- 熔断是集群共享的（`lib/resilience.ts` 走 Redis，未配置时回落进程内），API 都是 async，调用点必须 `await`；否则 `guardCircuit` 的拒绝会变成未处理的 Promise。

## 文档使用规则（重要）

`docs/` 按用途分层，**不要默认全读**。先看 `docs/README.md`（索引页，含「我要做什么 → 读哪篇」导航），
再按需只读相关的那一篇：

- `01-需求/` —— 需求基线 + 需求↔实现对照
- `02-设计/技术说明-学习版.md` —— 全链路技术说明与踩坑（改架构前读）
- `02-设计/Agent能力矩阵.md` —— 33 条 Agent 能力 → 文件级落点（定位"某能力在哪实现"最快）
- `04-规范/界面开发规范.md` —— **改界面的唯一依据**，动手前必读
- `05-手册/` —— 面向最终用户，改 UI 文案时可查

改完文档跑 `npm run docs:check`（校验所有相对链接未断）。

`README.md` 已包含功能清单，比重复翻 docs 更快。

## 分支纪律（必须遵守）

- **禁止在 `main` / `master` 上直接提交或推送**；所有改动在 `release/vX.Y.Z`（或 `feature/*` → release）。
- 开工第一步：`pnpm release:status` 确认分支；不在 release 分支就先 `pnpm release:start <版本>`，不要自行编版本号。
- 合并回 main、打 tag、推送、删分支：**必须先得到用户明确同意**，再执行 `pnpm release:finish` 或 `pnpm release:tag`。
- **只有维护者（`.release-owner` 里的邮箱）能合并 `main`、打 tag**；其他人只能推 `feature/*` / `release/*` 并开 MR，不得执行 `release:finish` / `release:tag`。
- 不 `git push --force`、不改写已推送历史、不移动已有 tag。
- 全量规则：[`docs/04-规范/Git分支与发布规范.md`](docs/04-规范/Git分支与发布规范.md)；自动化见 `.opencode/skills/git-release/`。

## 注意

- `.env.local` 含真实密钥，不要读取内容、不要提交、不要在输出里回显。
- `.env.example` 是模板；新增环境变量需同步补充。
- 演示/脏数据在 `data/files/`，排查存储问题时才看。
- 大文件勿整读：`pnpm-lock.yaml`、`tsconfig.tsbuildinfo`。
