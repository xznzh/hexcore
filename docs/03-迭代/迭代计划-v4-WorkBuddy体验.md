# 迭代计划 v4 —— 对标 WorkBuddy 的 AI 工作助手体验

> 编制日期：2026-10-21 ｜ 基线：`需求实现对照-v3.1.md`（功能覆盖 ≈95%+，typecheck/build 通过）
> 目标：把产品从「功能齐全的工具聚合站」升级为「打开即用的 AI 工作助手」——即 WorkBuddy 类产品的产品形态：**工作台首页 + 对话中心 + 待办驱动 + 全局检索 + 精致工程**。
>
> 原则：① 不推翻既有功能与路由，增量演进；② 每个 M 里程碑结束都保持 `typecheck` / `build` / 可演示；③ 数据源优先复用已有 API。

---

## 一、现状盘点（为什么还需要迭代）

### 1.1 已达标项（本轮不动）
- 功能面：对话/RAG/文件/文档/PPT/技能/定时/项目/记忆/管理后台已全量落地（见 v3.1 对照文档 ⑨）。
- 导航性能：`AppShell` 常驻 + 服务端会话注入已解决白闪与重复请求。
- 设计系统：`globals.css` Design Tokens + ThemeProvider 换肤已就绪（吸收自 v4 期《界面优化建议》，该提案文档在落地后已移除，现行依据是 `04-规范/界面开发规范.md`）。

### 1.2 差距诊断（本计划要解决的）

| 编号 | 层级 | 问题 | 证据（现状代码） |
| --- | --- | --- | --- |
| G1 | 产品 | **无工作台首页**：打开产品看不到「我的工作」，首 impression 是一个空工具箱 | `app/page.tsx` 仅 `redirect('/chat')` |
| G2 | 产品 | AI 产出无后续动作：聊天结论/技能/定时结果不会沉淀为**待办任务**，「助手帮你干活」缺少闭环 | 无 todos 相关表/API |
| G3 | 产品 | 13 个一级导航过多，心智负担大 | `components/Nav.tsx` groups 共 12 项 |
| G4 | 产品 | 缺全局搜索：跨会话/文档/文件/知识库找东西逐页翻 | 无聚合搜索 API |
| G5 | 工程 | `Chat.tsx` 43.5KB 单文件、`admin/page.tsx` 27.5KB，首包与维护性差 | 文件体积统计 |
| G6 | 工程 | 无路由级错误/骨架边界，偶发白屏裸报错 | 仅有根 `app/loading.tsx` |
| G7 | 工程 | 字体走 `fonts.googleapis.com` CDN，国内环境阻塞/失败 | `app/layout.tsx:18-23` |
| G8 | 工程 | 通知只在挂载时拉取一次，长驻页面看不到新通知 | `Nav.tsx` useEffect 单次 fetch |
| G9 | 质量 | 全项目 0 测试（单测/E2E 均无） | `package.json` 无 test 脚本 |

---

## 二、迭代总览（4 个里程碑）

```
M1 工作台闭环（产品核心，2.5 周）
   工作台首页 /work → 今日简报 → 待办收件箱 → / 设为默认路由
M2 全局体验（1.5 周）
   Cmd+K 命令面板 → 导航收敛（IA 2.0）→ 通知实时化
M3 工程健康（1.5 周）
   Chat 拆分 → 路由边界/骨架 → 字体本地化 → 分包/懒加载
M4 质量与演进（2 周 + 持续）
   Vitest 单测 → Playwright E2E → 预算与监控 → 可选项池
```

总计约 7.5 周（单人全时口径；并行两项时可压缩到 ~5 周）。

---

## 三、M1 —— 工作台闭环（P0）

> 里程碑验收：新用户登录后落地 `/work`，一眼看到「今天该干什么」，并且 AI 产生的行动项能进入待办、能被完成——形成「对话 → 行动 → 完成」的产品故事。

### 3.1 工作台首页 `/work` ⭐

**页面结构（自上而下）**

```
┌ 问候区 ────────────────────────────────────────┐
│ 下午好，张三 · 今天有 2 个定时任务已跑完        │
├ 今日简报卡（AI 生成，可折叠，缓存于当日）────────┤
│ · 昨日 2 场会话要点 1 摘要…                    │
│ · 未读通知 3 条：额度告警 / 定时任务失败…       │
│ · 额度余量 62%（预估）                        │
├ 居中大输入框（复用 Chat 的 Composer）────────────┤
│ 💬 问点什么，或  / 技能  @ 文件                │
├ 卡片行（响应式 grid，按角色显示）────────────────┤
│ [继续上次] [最近文档] [进行中任务] [待办 n] [团队动态] │
└───────────────────────────────────────────────┘
```

**卡片数据源（全部复用现有 API，仅新增 1 个聚合接口）**

| 卡片 | 数据源 |
| --- | --- |
| 今日简报 | 新增 `/api/brief`（见 3.2） |
| 继续上次 | `GET /api/conversations`（最近 3 条，未归档） |
| 最近文档/文件 | `GET /api/files` + artifacts（按 updatedAt 倒序取 5） |
| 进行中任务 | `GET /api/schedules`（enabled + lastStatus）+ `GET /api/schedules/runs` 最近失败 |
| 待办 | 新增 `/api/todos`（见 3.3） |
| 额度余量 | `GET /api/usage`（user 月度用量 vs quota） |
| 未读通知 | `GET /api/notifications` |

**新增文件**

- `app/work/page.tsx`（服务端壳，取会话与首屏聚合数据）
- `app/work/loading.tsx`（骨架屏）
- `lib/workbench.ts`（聚合查询：3 个 drizzle 查询拼装，避免前端串行 5 个请求）
- 新 API：`GET /api/workbench` —— 一次性返回聚合 JSON（代价 < 3 个并行 DB 查询）
- `components/work/`：`BriefCard.tsx`、`ComposerLauncher.tsx`、`CardGrid.tsx`、`TodoWidget.tsx`

**交互细节**

- 大输入框回车 → `router.push('/chat?draft=' + encodeURIComponent(text))`，Chat 页读取 query 自动填充发送（最小侵入）。
- `/` `@` 建议弹层直接复用 `Chat.tsx` 已有技能/文件选择逻辑，抽成 hook（配合 M3 的拆分，见 §5.1）。
- 时间问候：服务端渲染时区用 UTC+8 可配置（设置页）。

**估计：1 周（前端 0.5 引，接口聚合 0.3，联调 0.2）**

### 3.2 今日简报 `/api/brief`

- **生成时机**：每日首次访问工作台时惰性生成（不依赖 cron，小团队零运维）。
- **内容生成**：Prompt = 角色 + 近 24h 摘要素材（新会话标题与最后的助手消息截断、新文件名列表、schedule_runs 新失败、未读通知标题、额度余量）→ 一次 LLM 调用，输出 JSON 结构（3~5 个要点，每条 ≤40 字）。
- **缓存**：新表 `briefings(user_id, date, content_json, model_used)`，当日命中直接返回；可手动「重新生成」（每日限 3 次，防滥用）。
- **降级**：无可用对话模型时返回结构化模板文案（不调用 LLM），始终有内容可展示。
- **成本控制**：输入素材截断 ≤2k token；生成走默认对话模型；Admin 可在后台关闭简报（settings 增加 `brief_enabled`）。

**新增**：`app/api/brief/route.ts`、`lib/schema.ts` 增加 `briefings` 表 + drizzle 迁移、`app/api/brief` GET/POST。
**估计：0.5 周**

### 3.3 待办收件箱（todos）

**数据模型**（`lib/schema.ts` 新表）

```
todos:
  id uuid pk
  userId      -- 归属
  scope       -- personal | team（沿用既有 scope 语义）
  projectId   -- 可空，关联项目
  title       -- ≤120 字
  detail      -- 可空
  status      -- open | done | dismissed
  source      -- manual | chat | skill | schedule
  sourceRef   -- JSON：{conversationId?, messageId?, skillRunId?, scheduleRunId?}
  dueDate     -- 可空
  createdAt / completedAt
索引：(userId, status)、(projectId)
```

**入口与 API**

| 入口 | 说明 |
| --- | --- |
| 对话消息操作条 | 助手消息新增「加入待办」按钮 → `POST /api/todos`（source=chat, 带 conversationId/messageId） |
| Function Calling 工具 | `/api/chat` 工具表新增 `create_todo`（Agent 明确产出行动项时自动建档），与 `search_knowledge` 等并列，maxSteps+1 |
| 技能/定时运行结果 | runs 响应体旁提供「转为待办」（复用同一 POST，sourceRef 记 runId） |
| 工作台/侧栏 | `GET /api/todos?status=open&limit=20`；`PATCH /api/todos/:id` 完成/撤销/改标题；`DELETE` |

**权限**：沿用资源属主校验模式（同 `files/[id]` 路由的写法）；guest 角色只读。

**估计：1 周（表+API 0.4，对话工具接入 0.3，工作台/消息操作条 UI 0.3）**

### 3.4 默认路由迁移

- `app/page.tsx`：`redirect('/work')`（登录态）；未登录仍去 `/login`。
- 登录后跳转目标 `/chat` → `/work`（login 页 + middleware 中 `hasToken && isAuthPage` 的跳转同步改）。
- 旧链接 `/chat` 依然有效（不裁撤），仅默认入口变化。

**估计：0.25 周（含回归：AppShell 当前页高亮逻辑已按前缀匹配，需检查 `/work` 分类展示）**

---

## 四、M2 —— 全局体验（P1）

### 4.1 Cmd+K 命令面板

- **聚合搜索 API**：`GET /api/search?q=&types=conversations,files,knowledge,docs,skills`
  - messages：drizzle `ilike` 全文（pgvector 环境下可顺带跑语义召回，q 长度>6 时混合排序）
  - files/knowledge docs：`ilike` filename/title
  - conversations：标题命中
  - 返回类型化结果 `{type, id, title, subtitle, url, updatedAt}`，各源 limit 5
- **前端**：`components/CommandPalette.tsx`（自绘，不引新依赖：Modal + 输入 + 结果分组 + 键盘导航 ↑↓/Enter/Esc）
  - 全局快捷键 `Ctrl/Cmd + K`，`AppShell` 监听；导航页脚加入口按钮
  - 无输入时展示「最近」+「快捷动作」（新对话/新文档/转 PPT/生成简报）
- **性能**：输入 250ms debounce；取消上一次请求（AbortController）

**估计：0.75 周**

### 4.2 导航收敛（IA 2.0，不改 URL，零迁移成本）

- 现在：工作台(7) / 自动化(3) / 系统(2) 共 12 项 → 收敛为 **6 项**：

```
首栏常用：
  工作台 /work        对话 /chat
分组「创作」：文档(合并 /docs /ppt 为一个入口内二选一 Tab)
分组「知识」：知识库(含文件区 Tab) / 记忆
分组「自动化」：技能 / 连接器 / 定时
尾部：设置 / 管理后台(admin only)
```

- **实施方式（低风险）**：只改 `Nav.tsx` 的 groups 结构 + `/docs`、`/ppt`、`/knowledge`、`/files` 顶部增加页内 Tab 切换（保留原 URL 为默认 Tab），**不合并路由文件**，避免回链失效。
- `PageHeader` 增加 Tab 组件（antd `Segmented`，样式与 tokens 对齐）。

**估计：0.5 周**

### 4.3 通知实时化

- `Nav.tsx` 拉通知改为「进入页面后 60s 轮询 + `document.visibilityState==='visible'` 才发起 + Tab 切换/新消息事件触发即时刷新」（自研 10 行 hook `useNotifications()`，不引 SWR）。
- 未读数变化时顺带刷新工作台的待办/简报角标（简单 event bus：`window.dispatchEvent(new CustomEvent('todo:changed'))`）。

**估计：0.25 周**

---

## 五、M3 —— 工程健康（P1）

### 5.1 `Chat.tsx` 拆分（43.5KB → 目录化）

```
components/chat/
  Composer.tsx        -- 输入框 + / @ 建议 + 附件 + 语音（抽公用供 /work 复用）
  MessageList.tsx     -- 列表 + 虚拟滚动（可选，>200 条时）
  MessageItem.tsx     -- 单条气泡 + Markdown + 引用 chip
  MessageActions.tsx  -- 转文档/PPT/存技能/加入待办（M1 接入点）
  SessionDrawer.tsx   -- 会话列表（见下）
  useChatController.ts -- 状态与请求编排
```

- 拆分原则：**纯搬家不改逻辑**，每搬一块跑一次 `pnpm typecheck`；完成后 `Chat.tsx` 缩为 <10KB 装配层。
- 顺手完成两个体验项：会话列表改为左侧常驻抽屉（不离开对话页可切换）；消息「编辑重发」。

**估计：0.75 周**

### 5.2 路由级边界与骨架

- 新增 `app/not-found.tsx`、`app/error.tsx`（client 组件，提供「返回工作台」）。
- 为大页面（work/knowledge/admin/skills/files）各加 `loading.tsx` 骨架，复用 `app/loading.tsx` 样式改参数。

**估计：0.4 周**

### 5.3 字体与首包

- `layout.tsx` 去掉 fonts.googleapis.com `<link>`，改 `next/font/local`（本地化 Sora / JetBrains Mono woff2 子集，中文继续走系统栈，不新增中文字体下载）。
- `next/dynamic` 懒加载重型页面组件：`admin`、`skills` 编排画布、`knowledge` 上传区。
- 加 `@next/bundle-analyzer`（dev 脚本 `analyze`），拿到基线数据并记录在本文档附表中。

**估计：0.5 周**

---

## 六、M4 —— 质量与演进（P1 + 持续）

### 6.1 测试建设（当前 0 测试）

**Vitest 单测（优先级序）**

| 目标 | 覆盖点 |
| --- | --- |
| `lib/agent/engine.ts` | 线性步骤编排、Critic 重试、human 节点暂停/续跑（mock LLM） |
| 额度策略 | 超限拦截/降级/告警三分支、跨阈值告警只触发一次 |
| `lib/auth.ts` + middleware | JWT 过期、guest 写拦截、注册模式（开放/邀请码/仅管理员） |
| `lib/crypto.ts` | Key 加解密回环 |
| 检索 | 命中阈值过滤、kbId 过滤 |

**Playwright E2E（冒烟三层）**

1. 游客路径：注册 → 进入工作台 → 看到简报模板
2. 核心链路：登录 → 新对话 → 发消息（流式返回）→ 引用 chip 出现 → 加入待办 → 工作台勾选完成
3. 管理链路：admin 登录 → 添加用户 → 分配额度 → 模型连通测试

配套：`pnpm e2e`（CI 可选，本地先跑）；复用 G7 已有 Playwright 依赖（需 `pnpm add -D playwright`）。

**估计：1.25 周（单测 0.75 + E2E 0.5）**

### 6.2 质量护栏（小成本，常驻）

- CI 脚本（本地 git hook 即可）：`pre-commit` = typecheck + vitest run；`pre-push` = build。
- 核心路径打点已有（usage/feedback/logs），补一个 `/api/workbench` 的响应耗时日志，防止聚合接口随数据增长劣化。

### 6.3 可选项池（不排期，按需拉取）

| 项 | 触发条件 |
| --- | --- |
| 移动端适配（rail 折叠为底部栏） | 有手机演示需求时 |
| 简报推送（站内/邮件） | 团队规模 >10 或有异地成员 |
| 待办 → 项目看板视图 | 项目协作强度上升 |
| AI SDK v4→v5、Next 14→15 升级 | 需要新框架特性时（独立专项，约 1 周） |
| 计费倍率精细化 / 成本报表增强 | 商用化启动时 |
| 语音播报常态化、图片理解入口优化 | 用户反馈驱动 |

---

## 七、库表与 API 变更总表

### 库表（`lib/schema.ts` + drizzle 迁移 ×1）

| 表 | 新增/修改 | M |
| --- | --- | --- |
| `todos` | 新增 | M1 |
| `briefings` | 新增 | M1 |
| 其余 | 不动 | — |

### API

| 接口 | 方法 | M | 说明 |
| --- | --- | --- | --- |
| `/api/workbench` | GET | M1 | 聚合首屏数据 |
| `/api/brief` | GET/POST | M1 | 简报读取/重生成 |
| `/api/todos` · `/api/todos/[id]` | GET/PATCH/DELETE | M1 | 收件箱 CRUD |
| `/api/search` | GET | M2 | 聚合搜索 |
| `/api/chat` | 修改 | M1 | 工具表新增 `create_todo` |
| `/api/admin/settings` | 修改 | M1 | `brief_enabled` 开关 |

---

## 八、风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 默认路由改动引起书签/习惯不适 | `/chat` 保留可直达；发布说明写清 |
| 简报生成意外走大模型产生费用 | 素材截断 + 当日缓存 + 每日重生成限 3 次 + admin 开关 |
| Agent 自动建待办泛滥 | `create_todo` 仅在 LLM 结构化输出「建议行动」时触发；每会话每回合限 1 条；可全局停用 |
| Chat 拆分引入回归 | 纯搬家 + 每步 typecheck + E2E 冒烟在合并前跑通 |
| IA 收敛让人「找不到功能」 | 只改分组不改 URL；旧入口全部保留（Tab 化） |
| 聚合接口慢查询 | 并行查询 + limit + 相关表已有索引字段；打点观察 |

---

## 九、验收脚本（最后一个里程碑后的 Demo 流）

1. 打开采集点 → 落地 `/work`：问候、简报、四宫格卡片齐备
2. 在工作台输入框输入「帮我总结 XX 项目的进展」→ 进入对话 → 得到带引用的回答
3. 对该回答点「加入待办」→ 回到 `/work`，待办卡片 +1
4. 勾选完成 → 待办数归零（另返回对话工具自动建档路径演示 1 例）
5. `Ctrl+K` 搜「XX 项目」→ 命中会话/文件/知识库三类结果 → 回车直达
6. 演示导航：创作 Tab 下切文档/PPT、知识 Tab 下切知识库/文件（URL 未变）
7. `pnpm e2e` 冒烟 3 条全绿；`pnpm analyze` 出包体积对比表

---

## 十、排期建议（单人）

```
W1      工作台页 + 聚合接口 + 默认路由
W2      简报 + todos 表/API + 消息操作条入口
W3      create_todo 工具 + 收件箱 UI + M1 收尾回归
W4      Cmd+K（API + 前端） + 通知轮询
W5      导航收敛 + M2 回归
W6      Chat 拆分（搬家式）
W7      边界/骨架 + 字体本地化 + 分包
W8      Vitest 关键模块
W9      E2E 冒烟 + 护栏 + 文档收口（本文件更新为"复盘报告"）
```

> 若需要更快见效：M1 的「工作台首页（不含简报）+ / 默认路由 + 待办最小闭环」可在 3~4 天内先出可演示版本——这是整个计划里性价比最高的一刀。

---

## ⑪ 全部实现记录（第三轮 · 本计划已全量落地）

> 验证：`pnpm typecheck`（0 错误）、`pnpm test`（Vitest 5/5 通过）、`pnpm build`（构建成功，19 个静态页全部生成）。

### M1 工作台闭环 ✅
| 项 | 实现 |
| --- | --- |
| 工作台首页 `/work` | `app/work/page.tsx` + `.loading.tsx` 骨架：问候区、居中大输入框（Enter → `/chat?draft=` 预填）、今日简报卡、待办收件箱（可勾选完成）、继续对话、最近文件、定时任务（含近 24h 失败标记）、额度余量条、未读通知、最近产物 六宫格 |
| 聚合接口 | `GET /api/workbench`：Promise.all 并行 9 组轻查询一次返回首屏数据 |
| 今日简报 | `GET/POST /api/brief` 惰性生成（当日缓存于 `briefings` 表）+ 每日重生成限 2 次 + LLM 失败/未配置自动模板降级；Admin 可关闭（`brief_enabled`） |
| 待办收件箱 | 新表 `todos`（schema + DDL 迁移）+ `/api/todos` GET/POST/PATCH/DELETE；对话消息操作条新增「加入待办」；Function Calling 新增 `create_todo` 工具（行动项自动落档，sourceRef 记录 conversationId/messageId） |
| 默认路由 | `/` → `/work`；middleware 与登录后跳转同步改为 `/work`（`/chat` 保留直达） |

### M2 全局体验 ✅
| 项 | 实现 |
| --- | --- |
| Cmd+K | `components/CommandPalette.tsx` + `AppShell` 挂载 + Nav「全局搜索 ⌘K」入口；250ms 防抖 + AbortController；↑↓/Enter/Esc 键盘导航；快捷动作兜底 |
| 聚合搜索 | `GET /api/search`：会话/消息/文件/知识库/记忆/技能六源并行词法检索（限 5×6），知识库按可见范围过滤 |
| 导航收敛 | `Nav.tsx` 分组为 工作区/创作与知识/自动化/系统；docs↔ppt、knowledge↔files 顶部 `SectionTabs`（antd Segmented，URL 不变零迁移） |
| 通知实时化 | `components/useNotifications.ts`：60s 轮询 + `visibilityState` 感知 + Tab 聚焦即时刷新；未读数与面板共用同一状态 |

### M3 工程健康 ✅
| 项 | 实现 |
| --- | --- |
| Chat 拆分 | `components/chat/{types,Markdown,Composer}.tsx` 纯搬家抽出（Markdown/代码高亮/输入区/共享类型）；`Chat.tsx` 缩为装配层（首包 19.4KB） |
| 错误/边界 | 新增 `app/error.tsx`（可重试）、`app/not-found.tsx`（404）；`admin/skills/files/knowledge` 各加路由级骨架 `loading.tsx` |
| 字体本地化 | Google Fonts CDN `<link>` 移除；`next/font/local` 自托管 Sora（400-700）与 JetBrains Mono（400/500）至 `app/fonts/`，绑定 `--font-sora/--font-jbmono` 变量 |
| 分包懒加载 | `admin` / `skills` 页面改为 `next/dynamic` 客户端懒加载（skills 首包 1.43KB，admin 不再进主包） |

### M4 质量与演进 ✅（基础设施）
| 项 | 实现 |
| --- | --- |
| 单测 | Vitest 5 + `vitest.config.ts`（@ 别名）；`tests/util.test.ts`、`tests/crypto.test.ts` 共 5 例通过 |
| E2E | Playwright 冒烟三层骨架 `e2e/smoke.spec.ts` + `playwright.config.ts`（未登录跳转 / 登录落地工作台 / 对话草稿链路；需 `pnpm exec playwright install chromium` + `E2E_EMAIL/E2E_PASSWORD`） |
| 脚本 | `pnpm test / test:watch / e2e / analyze`（bundle analyzer 已装，可随时出包体报告） |

### 新增/改动文件清单
- 新增 API：`/api/workbench`、`/api/brief`、`/api/todos`、`/api/search`（修改：`/api/chat` 工具表、`/api/admin/settings`）
- 新增页面：`app/work/*`、`app/error.tsx`、`app/not-found.tsx`、5 个 `loading.tsx`、`app/admin/page.tsx`+`AdminClient.tsx`、`app/skills/page.tsx`+`SkillsClient.tsx`
- 新增组件：`CommandPalette`、`SectionTabs`、`useNotifications`、`chat/{types,Markdown,Composer}`
- 数据库：`lib/schema.ts` 新表 `todos`、`briefings`（`lib/db.ts` 幂等 DDL），`lib/settings.ts` 新增 `brief_enabled`
- 字体资产：`app/fonts/*.ttf`（6 个文件，Sora/JetBrains Mono）
