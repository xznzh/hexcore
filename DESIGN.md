# DESIGN.md — AI Agent 平台（深空控制台 · Deep Space Console）

> 设计系统规范文档。单一 token 来源、明暗双主题、6 套可换主色，供 AI 编程代理（Cursor / Claude Code / WorkBuddy）直接消费。
> 实现位置：`app/globals.css`（tokens + 组件 CSS）、`components/ThemeProvider.tsx`（换肤注入）、`components/Nav.tsx`、`components/TrendChart.tsx`、`app/usage/page.tsx`（用量看板）。

---

## 1. Visual Theme & Atmosphere

**设计哲学**：深空控制台（Deep Space Console）——以近黑蓝底托出冷调青色辉光，强调"专业工具、信息密度高、可长时间凝视不疲劳"。

- **视觉基调**：暗色优先（dark-first）的科技控制台；克制、精确、低密度噪声。
- **核心特征关键词**：`深空暗底` · `青色辉光(accent glow)` · `微玻璃面板` · `切角几何` · `高对比语义色`
- **光影与质感**：面板用"顶部 1px 内高光 + 底部极淡投影"模拟浮起；主按钮/激活态带 accent 辉光（box-shadow glow）；不做重毛玻璃，仅模态遮罩用 backdrop-blur。

---

## 2. Color Palette & Roles

所有颜色来自 CSS 变量；主色 `--accent` 由 `ThemeProvider` 在运行时注入，支持 6 套主题切换（默认青 `#22d3ee`）。

### 暗色主题（默认 :root）

| 角色 | HEX | CSS 变量 | 使用场景 |
|---|---|---|---|
| App 背景 | `#0d1117` | `--bg` | 页面底色 |
| 次级背景 | `#0f141d` | `--bg-subtle` | 左侧 rail、结果块 `--result-bg` |
| 面板/表面 | `#161b22` | `--panel` | 卡片、弹层、输入底 |
| 面板悬浮 | `#1c2230` | `--panel-hover` | 卡片 hover、下拉项 |
| 边框 | `#262d3a` | `--border` | 默认分隔线 |
| 边框强化 | `#333c4d` | `--border-strong` | 输入框、次级按钮描边 |
| 主文本 | `#e6edf3` | `--text` | 标题、正文 |
| 次文本 | `#b3bcc8` | `--text-secondary` | 说明文字 |
| 弱化文本 | `#8b949e` | `--muted` | 占位符、脚注、标签 |
| 主色 | `#22d3ee` | `--accent` | 主按钮、激活态、链接、图标辉光 |
| 主色副调 | `#0091ac` | `--accent-2` | 渐变第二色（用户气泡、logo） |
| 主色 hover | `#38dbf0` | `--accent-hover` | 主按钮/hover 提亮 |
| 主色柔底 | `rgba(34,211,238,.13)` | `--accent-soft` | 激活背景、选中行、图表填充 |
| 主色描边 | `rgba(34,211,238,.35)` | `--accent-border` | 聚焦环、激活边框 |
| 成功 | `#3fb950` | `--success` | 状态标签、成功提示 |
| 警告 | `#d29922` | `--warning` | 状态标签、额度 >60% |
| 危险 | `#f85149` | `--danger` | 删除、失败、额度 >80% |
| 用户气泡文字 | `#06232b` | `--user-bubble-text` | 暗主题主色面上的文字（深青黑） |

### 亮色主题（覆盖层 `[data-theme='light']`）

| 角色 | HEX | 变量 | 说明 |
|---|---|---|---|
| App 背景 | `#f5f7fa` | `--bg` | |
| 面板 | `#ffffff` | `--panel` | |
| 边框 | `#e5e7eb` | `--border` | |
| 主文本 | `#111827` | `--text` | |
| 弱化 | `#6b7280` | `--muted` | |
| 主色 | `#0891b2` | `--accent` | 蓝青，hover `#0a7c98` |
| 用户气泡文字 | `#ffffff` | `--user-bubble-text` | 亮主题主色面上的文字（白） |
| 成功/警告/危险 | `#3fb950` / `#d29922` / `#f85149` | 同暗色 | 语义色跨主题一致 |

> **换肤规则**：切主色时，`--accent-hover / --accent-soft / --accent-border / --user-bubble-text` 由 JS 动态计算（`shade()` / `toRgba()` / `isLightColor()`）。浅色主色自动转白字，避免对比度翻车。

---

## 3. Typography Rules

**Font Family**
```css
--font-display: var(--font-sora), var(--font-noto-sc), 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Source Han Sans SC', sans-serif;
--font-body:    var(--font-display);
```
| 字体 | 字重 | 用途 | 加载方式 |
|---|---|---|---|
| **Sora** | 400/500/600/700 | 拉丁字母、数字、代码外的英文标识 | `next/font/local`，自托管 ttf |
| **Noto Sans SC** | 400/600 | 中文正文与标题（OFL 1.1，可商用） | `next/font/local`，自托管 woff2（常用汉字子集，约 1.1MB/档），`preload: false` |
| **JetBrains Mono** | 400/500 | 代码块、命令行、token 数 | `next/font/local`，自托管 ttf |

> Sora 无 CJK 字形，中文按字形逐字回退到 Noto Sans SC——英文仍是 Sora 的几何感，中文不再落到各机器不同的 PingFang / 雅黑上，跨设备视觉一致。
> CJK 体积大，故 **不做 preload**：首屏先用 `font-display: swap` 的系统字，字体到达后平滑替换，不阻塞渲染。

**Type Scale**

| Token | 尺寸 | 字重 | 行高 | 字距 | 用途 |
|---|---|---|---|---|---|
| `--fs-xs` | 11px | 500 | 1.4 | 0 | 标签、脚注、趋势轴 |
| `--fs-sm` | 12px | 500 | 1.5 | 0 | 次级文本、表头、Tag |
| `--fs-md` | 14px | 400 | 1.65 | 0 | 正文 |
| `--fs-lg` | 16px | 500/600 | 1.6 | 0 | 卡片标题、小标题 |
| `--fs-xl` | 23px | 600 | 1.3 | -0.01em | 页头 `.page-header h1` |
| `--fs-2xl` | 24px | 600 | 1.25 | -0.01em | 欢迎区 `.work-greet h1` |

**设计哲学**：14px 正文 + 1.65 行高偏紧凑但适合工具型长列表；标题用 600 字重 + 轻微负字距营造"现代控制台"感。

**CJK 字距规则（重要）**：负字距是为 Sora 的拉丁字形调的，中文回退字跟着收紧会发挤。因此：
```css
html:lang(zh) :is(.page-header h1, .welcome h2, .auth-brand h1, .ant-card-head-title, .work-greet h1) {
  letter-spacing: 0;   /* 中文界面下标题不做负字距 */
}
```
拉丁为主的标识（`.rail-logo-text`）单独保留 `-0.01em`。

---

## 4. Component Stylings

### Buttons
| 变体 | 背景 | 文字 | 边框 | 圆角 | hover / 禁用 |
|---|---|---|---|---|---|
| Primary | `linear-gradient(135deg, var(--accent), var(--accent-2))` | `var(--user-bubble-text)` | none | `var(--radius-md)`=10px | hover 提亮 `accent-hover`+上移 1px+辉光增强；disabled 去渐变/光晕 → `panel-hover` 底 + `muted` 字 |
| Secondary | transparent | `var(--text)` | `1px var(--border-strong)` | 9px | hover 边框 `accent-border`+字 `accent`+底 `hover-bg` |
| Ghost/Text | transparent | `var(--text-secondary)` | none | — | hover 底 `hover-bg`；图标按钮同 |
| Danger | transparent | `var(--danger)` | `1px danger-border` | 9px | hover 底 `danger-soft` |

> 次级操作（表格/列表）统一用 `type="text"` 小图标按钮，避免与 Primary 抢视觉。

### Cards
```css
background: var(--panel);            /* 带一层极淡 surface sheen */
border: 1px solid var(--border);
border-radius: var(--radius-lg);     /* 14px */
box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 1px 0 rgba(0,0,0,.2);
```
hover：边框 `border-strong` + 抬升阴影 `--lift`；body padding 16–20px。

### Inputs
`border:1px var(--border)` · `radius 9px` · 聚焦：`border accent-border` + `box-shadow 0 0 0 3px var(--accent-soft)` · placeholder `var(--muted)`。输入框前缀图标用 `var(--muted)`。

### Navigation（左侧 rail）
- 宽：展开 `200px` / 折叠 `56px`；底 `var(--rail-bg)`。
- 激活项：`3px` 左侧渐变竖条(`accent→accent-2`) + 底 `accent-soft` + 字 `accent` + 图标辉光。
- 分组标题：`var(--muted)` 10–11px，大写 + `0.14em` 字距；折叠态仅留图标 + Tooltip。
- **可折叠分组**（`.rail-group-toggle`）：低频分组（"更多"：记忆 / 连接器 / 能力目录）默认收起，整行可点，右侧箭头 `-90°`（收起）→ `0°`（展开）`150ms` 过渡。未手动操作过时跟随"当前路由是否在该组"自动展开；用户一旦点击，以用户选择为准。折叠态（仅图标）下分组直接平铺，不做二级收起。
- **一级信息架构**：工作区（工作台 / 对话）→ 创作与知识（文档 / PPT / 知识库 / 文件 / 项目）→ 自动化（技能编排 / 定时任务）→ 更多（可折叠）→ 系统（用量看板 / 设置 / 管理后台）。一级可见项控制在 10 个以内。

### Badges / Tags
`radius 6px` · `padding 0 8px` · `line-height 20px` · `font-size 12` · `font-weight 500`。
语义映射（消除 antd 预设色与自定义调色板并存的"两套颜色"）：
`green/lime→success` · `red/volcano/error→danger` · `gold/orange/warning→warning` · `cyan/blue/purple/magenta/processing→accent` · `default→muted+border`。

### Data Display（指标卡 / 额度条 / 趋势图）
- **指标卡** `.stat-grid` + `.stat-card`：`grid auto-fit minmax(180px,1fr)`，卡内 `.stat-label`（12px `--muted`）+ `.stat-value`（22px / 600 / display 字体），关键数值加 `.accent`；hover 只换 `border-strong`，不做位移。
- **额度条** `.meter`：高 6px、`radius 999px`、底 `--bg-subtle`，填充 `<i>` 按阈值换色 —— `>80% --danger` / `>60% --warning` / 其余 `--accent`。工作台 `.work-quota .bar` 与之同一视觉语言。
- **趋势图** `components/TrendChart.tsx`：零依赖 SVG 面积图，`data: number[]`，默认 `var(--accent)`，容器侧 `svg{width:100%;height:auto}` 自适应。工作台额度卡用 48px 迷你版；用量看板用 150px + 数据点 + 月份轴（当前月高亮 `--accent`）。
- **表格内数值**：`font-variant-numeric: tabular-nums` + 右对齐；比例列用 `.usage-meter-cell`（条 + 百分比，条自适应）。

### Modals / Dialogs
遮罩 `rgba(0,0,0,.5)` + `backdrop-filter: blur(4px)`；内容 `var(--panel)` + `radius-lg` + `shadow-lg`；入场 `fade+scale` `180ms var(--ease)`。

---

## 5. Layout Principles

- **间距系统**：4px 基数 → `--sp-1..6` = `4 / 8 / 12 / 16 / 24 / 32`px。组件内边距、栅格 gap 一律走 token。
- **Grid**：工作台卡片用 `auto-fill, minmax(240px,1fr)`；表格放进卡片时卡片内边距收一档让表格撑满。
- **Container**：内容最大宽度 `--content-max: 1200px`（`.page` 与 `.work-shell` 共用，避免跨页忽宽忽窄），`margin: 0 auto`。
- **Section Spacing**：区块间距 `--sp-5`(24px)；页头到内容 `--sp-5`。
- **留白哲学**：信息密度优先；卡片间 16px、组内 6px；不堆大插画，空态用 shimmer 骨架屏。
- **看板页构成**：`PageHeader`（含导出/刷新）→ `.stat-grid` 四指标 → 趋势卡（`Card` + `TrendChart`）→ 明细表。顺序固定，避免每个看板各排一套。

---

## 6. Depth & Elevation

**Shadow System**
```css
--shadow-sm: 0 1px 2px rgba(0,0,0,.24);
--shadow-md: 0 4px 16px rgba(0,0,0,.28);
--shadow-lg: 0 12px 40px rgba(0,0,0,.36);
/* 亮色主题 */
--shadow-sm: 0 1px 2px rgba(16,24,40,.08);
--shadow-md: 0 6px 20px rgba(16,24,40,.12);
--shadow-lg: 0 16px 48px rgba(16,24,40,.16);
```

**Surface Layers**：`--bg`（底层）→ `--panel`（卡片）→ elevated（卡片 hover / 下拉）→ overlay（模态 / 移动端 rail 抽屉）。
**Z-index**：rail 抽屉 `50` · Popover/Dropdown `1000+` · Modal `1050` · Toast `1080`。
**Backdrop**：仅模态遮罩用 `blur(4px)`；其余靠阴影分层。

---

## 7. Do's and Don'ts

**Do**
- 所有颜色/间距/圆角走 CSS 变量（`var(--*)`），不散落 hex。
- 状态标签用语义色（`success/warning/danger/accent`），跟主题同步。
- 主操作必用 Primary 渐变；次级操作用 `type="text"` 图标按钮。
- 暗主题优先设计；检索/列表结果加 relevance 条 + 命中高亮。
- 移动端 rail 默认收起，展开时才用 `force-open` 抽屉，并始终配 `.rail-backdrop`。
- 列表项用语义类（`.kb-item` / `.conv-item`）表达 hover/active，不在 JSX 里堆内联 `style`。
- 看板类页面复用 `.stat-grid` / `.meter` / `TrendChart` 三件套。

**Don't**
- 在组件里硬编码 hex（除 `ThemeProvider` 内 6 个换肤主色）。
- 混用 antd 预设色（`green/red/gold`）与语义 token —— 会出现"两套绿/两套红"。
- 把标题负字距（`-0.015em`）原样套到中文上导致发挤（已收敛到 `-0.01em`）。
- 表格操作列写死 `width:158px` 导致标签变动溢出（已改自适应）。
- 触屏不提供搜索入口（⌘K 不可用 + 搜索按钮收进 rail 时，移动端需常驻入口）。

---

## 8. Responsive Behavior

| 断点 | 策略 |
|---|---|
| `≤1100px` | rail **默认收起**为 56px 图标栏（`useEffect` + `matchMedia` 初始化，避免首屏即被抽屉盖住）；用户点"展开菜单"→ `force-open` 变覆盖式抽屉（`position:fixed; z-index:50`）+ `.rail-backdrop` 遮罩（点空白处关闭），不挤压主区；点击导航项自动收起 |
| `≤900px` | 对话页隐藏 `chat-ws`（会话列表变 220px 高块）；登录页隐藏品牌区只留表单 |

- **Touch Targets**：按钮 / rail 项最小 `36–40px` 高。
- **折叠策略**：rail→抽屉；chat→纵向堆叠；work-grid→单列。
- **Font Scaling**：保持 px 定值（依赖系统缩放），不做 rem 收缩。

---

## 9. Agent Prompt Guide

**Quick Reference**：暗底 `#0d1117` + 青主色 `#22d3ee`；圆角 14（卡）/10（按钮）/9（输入）/6（标签）；间距 4 倍数；阴影分 3 档；语义色 success `#3fb950` / warning `#d29922` / danger `#f85149`。

**Component Prompts（可直接复制）**
1. 主按钮：`"用 var(--accent)→var(--accent-2) 渐变 + accent-hover 辉光的主按钮，圆角 10px，禁用态去渐变回灰"`
2. 卡片：`"14px 圆角 panel 卡片，1px border，顶部 1px 内高光，hover 抬升阴影"`
3. 状态标签：`"圆角 6px 的 Tag，green/lime→success、red→danger、gold/orange→warning、cyan/blue→accent 语义映射"`
4. 导航项：`"左侧 rail 激活态：3px 渐变竖条 + accent-soft 底 + accent 字 + 图标辉光"`
5. 趋势图：`"零依赖 SVG 面积图 components/TrendChart.tsx，data:number[]，跟随 var(--accent)，宽 100% 自适应"`
6. 指标卡：`"4 个 .stat-card 组成 .stat-grid，label 12px muted + value 22px 600，关键值 accent"`
7. 额度条：`"6px 高 .meter，按 >80% danger / >60% warning / 其余 accent 换色"`
8. 可折叠分组：`"rail 低频分组用 .rail-group-toggle，箭头 -90°→0° 指示展开，激活项所在组自动展开"`

**Iteration Guide**
- 改任何视觉前先确认是否已有 token；没有就加到 `:root`，再在组件 CSS 引用，禁止内联 hex。
- 新增主色主题：只需在 `ThemeProvider` 加一组 HEX，其余（hover/柔底/文字色）由 `shade()/toRgba()/isLightColor()` 自动派生。
- 加表格：操作列用 `type="text"` 小按钮；长表加 `pagination` + 顶部筛选 Input。
- 加数据可视化：优先复用 `TrendChart`（SVG，零依赖），不引图表库。
- 改响应式：窄屏一律走 `force-open` 抽屉模式，并在导航点击时 `setCollapsed(true)` 收起。
- 中文排版：标题字体栈必须含 CJK 回退；负字距不超过 `-0.01em`，中文界面下用 `html:lang(zh)` 归零。
- 每次改动后跑 `npx tsc --noEmit` 验证（当前 0 错误）。
- 设计意图有分歧时，以本文件 9 章为准，不在组件里各自发挥。
- 重大视觉升级在 `globals.css` 用 `/* 视觉升级 vN */` 注释分段，别 overwrite 旧块造成重复定义。

---

### 附：本规范覆盖的近期优化（审计闭环）
- 跨页内容宽度统一为 `--content-max`（修"忽宽忽窄"）。
- 状态标签统一映射到语义 token（修"两套颜色"）。
- `--fs-xl` 对齐真实渲染值 23px，移除页头 h1 重复 23px（修 token 漂移）。
- 收敛 `.ant-tag` 重复圆角定义（999px 基础块删除，单一定义 6px）。
- 知识库表加 `pagination` + 文件名筛选；操作列宽改为自适应。
- 知识库检索结果加 relevance 条 + 命中词高亮。
- 工作台"继续对话/最近文件"加客户端本地筛选。
- 移动端 rail 抽屉：点击导航项自动收起。
- 导航密度：低频项（记忆/连接器/能力目录）归入"更多"分组。
- 次级按钮统一为 `type="text"` 小图标风格。
- 工作台额度卡接入真实近 6 月用量趋势（`/api/workbench` 返回 `quota.trend`，由 `TrendChart` 渲染）。

### 附 B：第二轮收口（2026-10-30）
- **修真 bug**：`force-open` 原先挂在默认的展开态上，导致 ≤1100px 首屏侧栏就是固定抽屉、盖住主内容。改为窄屏默认收起（`matchMedia` 初始化）+ 展开时才 `force-open` + `.rail-backdrop` 遮罩。
- **新增用量看板** `app/usage/page.tsx` + `app/api/usage/overview`（页面聚合：近 6 月 token 趋势 + 当月额度 + 成员明细，管理员看全员 / 成员看自己）。日粒度消耗与估算花费直接复用既有 `/api/usage/trend`，导出复用 `/api/usage/export`，不重复造接口。入口在 rail「系统」、工作台额度卡「详情」、`lib/nav-routes.ts` 搜索索引。
- **导航可折叠**：新增 `.rail-group-toggle`，"更多"（记忆 / 连接器 / 能力目录）默认收起，激活项所在组自动展开；折叠图标栏下平铺。
- **内联样式收敛**：知识库列表内联 `style` → `.kb-item / .kb-name / .kb-meta / .kb-actions` 语义类；切换知识库时文档表带 `loading` 态。
- **中文排版**：`html:lang(zh)` 下标题字距归零，负字距只服务拉丁。
- **中文字体自托管**：引入 Noto Sans SC 400/600（`app/fonts/NotoSansSC-*.woff2`，OFL 1.1），`next/font/local` + `preload: false`。修掉"英文用 Sora、中文用系统字"的混排割裂，同时消除不同机器（PingFang / 雅黑）渲染差异。
- **CSS 收敛**：`.page` 重复定义合并（宽度 + 入场动画归一处），文件头补 10 段分区索引。
- 一级导航 13 项 → 10 项可见（"更多"折叠后），跨页宽度与文案语义统一。
