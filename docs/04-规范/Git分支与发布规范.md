# Git 分支与发布规范（V8.10 修订）

> 一句话：**`main` 只负责「发布」，`release/*` 负责「干活」；每次迭代一条 release 分支，验收全绿后 `--no-ff` 合回 main 并打 tag。**
> 本文是分支操作的**唯一依据**；`README.md` 只留入口，`.opencode/skills/git-release/` 负责让 AI 按本文自动执行，`.githooks/` 负责在你违规时拦住你。

## 0. 先修正原方案里的 3 个逻辑矛盾

| 原说法 | 问题 | 改成 |
|---|---|---|
| 「主分支内容不变」 | 与「release 测试完合并到 main」自相矛盾：合并本身就在改 main | main **只在发布时变**，且只接受从 `release/*` / `hotfix/*` 的合并，不接受任何人的直接提交。它是「单调前进的可发布快照」，不是冻结的 |
| 「main 是一个空白的项目」 | 空白 = 新手 clone 下来没有代码、跑不起来，既没法学习，也没法作为 release 的切出点 | main 是**干净基线**：功能完整、可一条命令跑起来、无脏数据/密钥/半成品，文档齐全 |
| 「每个人从 main 下载项目」 | 各人各自下载后本地改，基线会漂移，且没有「这一版改了啥」的边界 | 从 main **切** `release/vX.Y.Z`；多人协作时在 release 分支下再开 `feature/*`，feature 只合进 release，不直接碰 main |

## 1. 分支定义

| 分支 | 生命周期 | 允许的操作 | 禁止 |
|---|---|---|---|
| `main` | 永久 | 只接受 release/hotfix 的合并；打 tag | 直接 commit、直接 push、force push |
| `release/vX.Y.Z` | 一轮迭代 | 开发、修 bug、自测、改文档 | 夹带下一轮需求、直接合入其他 release |
| `feature/<主题>`（可选） | 单个功能 | 从 release 切出，完成后合回 release | 合进 main |
| `hotfix/vX.Y.Z` | 线上紧急修复 | 从出问题的 **tag** 切出，修完合 main | 在 main 上直接改 |

关系图：

```
main      ●────────────────●────────────────●──────────▶  只合并 + 打 tag
           \              /                /
release/v7.5 ●──●──●──●──●   (开发/自测/验收)   /
                                  hotfix/v7.5.1 ●──●
```

## 2. 一轮迭代的标准动作

```bash
# 0) 一次性：钩子随 pnpm install 自动安装；也可手动重装
pnpm hooks:install

# 1) 从 main 切出版本分支，并自动把 package.json 的 version 改成 7.6.0
pnpm release:start 7.6.0

# 2) 正常开发 —— 反复提交（钩子会拦住「在 main 提交」并自动跑类型检查）
git add -A && git commit -m 'feat(chat): 支持停止生成'

# 3) 提交前全量自检（typecheck + UI 规范 + 单测 + 文档链接）
pnpm release:check

# 4A) 仓库未开保护分支时：本地合并 + 打 tag + 推 main
pnpm release:finish 7.6.0          # 交互式确认
pnpm release:finish 7.6.0 --yes --push   # 无人值守（CI/Agent 需用户明确授权后才可用）

# 4B) 已开保护分支时（hexcore 当前状态，必须走这条）：
git push -u origin release/v7.6.0  # 推送后在 Gitee 开 MR 合入 main
git switch main && git pull --ff-only
pnpm release:tag 7.6.0 --push      # 在 main 的合并提交上打 tag 并推送

# 5) 生成发布说明（粘贴到 MR / 群里）
pnpm release:notes
```

> 第 4A 步做的事：`checkout main` → `pull --ff-only` → `merge --no-ff` → `tag -a v7.6.0` → 推 main 和 tag → 删本地与远端 `release/*`。
> 第 4B 步只打 tag，不碰 main。
>
> ⚠️ **开了保护分支之后不要再用 `release:finish --push`。** 如果保护规则是「标准模式」，它会被远端拒绝；
> 如果开了「评审模式」，后果更隐蔽——**推送不会报错（退出码 0），而是被静默转成一个 MR**，
> 同时本地 `main` 已经合并了那个版本，和远端分叉。两种都不是你要的结果。
> 判断标志：命令看起来成功了，但远端 `main` 的 SHA 没变，Gitee 的 PR 列表里多出一条。
> 任何一步失败都会停下，不会留下「半个版本」。

## 3. 门禁：三道防线，各管一段

| 层 | 文件 | 能否绕过 | 作用 |
|---|---|---|---|
| 本地防呆 | `.githooks/pre-commit`、`commit-msg`、`pre-push` | 能（`--no-verify`） | 在 main 提交/推送、提交信息不规范、强推覆盖远端时**立刻报错并给出正确做法** |
| 合并前自检 | `pnpm release:check` | 不能（脚本返回非 0 即失败） | 把「测试没毛病」变成可执行的标准，而不是口头判断 |
| 远端强制 | Gitee 仓库 → 管理 → 保护分支设置 + 分支状态设为「保护分支」 | 不能 | 禁止直推/强推/删除 `main`，合并只能由维护者在 MR 里点（配置与实测见 §11.6） |

> 本地钩子默认拦截所有推送到 `main` 的请求，**只对 `pnpm release:finish --push` 放行**（脚本会带授权标记）；
> 手工 `git push origin main` 一律被拒，这就是「唯一发布通道」的落地方式。

`pnpm release:check` 的门槛（与 `AGENTS.md` 一致）：

1. `tsc --noEmit` 0 错误（`scripts/check-ui-spec.mjs` 界面规范扫一遍）
2. `vitest run` 全绿
3. `docs:check` 无断链（改了 Markdown 必须过）
4. 改了主流程（登录/对话/知识库/发布）时，额外 `pnpm e2e` 通过并在 MR 里贴结果

## 4. 合并与打 tag 的硬规则

1. **合并方式**：`git merge --no-ff`。保留「这一版从哪开始、包含哪些提交」的边界；禁止 squash 成一坨，否则 tag 回溯没有意义。
2. **tag 格式**：`vMAJOR.MINOR.PATCH`（如 `v7.6.0`），**annotated tag**，与 `package.json` 的 `version` 完全一致。
3. **tag 打在 main 的合并提交上**，不在 release 分支上打。
4. **tag 只增不改**：发错了就发新补丁版（`v7.6.1`），禁止 `tag -f` 覆盖已推送的 tag。
5. 合并后删除 release 分支；历史与代码都在 main + tag 里，分支留着只会让人误以为还在开发。

## 5. 版本号语义与发布节奏

> 2026-11 修订：原来这里只有一句「破坏性变更 / 大改版 → 升 MAJOR」，回答不了「改得多算不算大改版」，
> 所以每次发版都要临场判断，判断完还只留在那一版的记录里。本节把它拆成可逐条核对的触发条件。

### 5.1 三种号各管什么

| 号 | 唯一触发条件 | 不算的理由（常见误用） |
|---|---|---|
| **MAJOR** | ① 主题换代：这一版要回答的问题和上一代不同；② 对外契约破坏：API、数据结构、部署形态不兼容；③ 依赖大升级（如 Next 14→15） | 「改了很多行」「攒了一批修复」「功能终于做完了」——**改动量不是依据** |
| **MINOR** | 新增**能独立说清**的能力（用户感知得到，或运维用得上） | 上一版的收尾、打补丁、纯重构、纯文档 |
| **PATCH** | 不改变对外行为的修复 | 顺手加的小功能（那还是 MINOR） |

判定顺序固定，先答「破契约了吗」，再答「有没有独立能力」：

1. 对外契约破了 → MAJOR
2. 没破，但新增了能独立说明的能力 → MINOR
3. 都没有 → PATCH

一个真实判定（v8.1）：未登录管理接口 403→401 属于**修正错误码**，不是新增不兼容语义，因此不构成 MAJOR；
引入输出护栏与 pgvector 检索属于新能力，因此是 MINOR 而不是 PATCH。

### 5.2 发布批次：tag 是承诺，不是存档点

两个频率必须分开：

- **提交频率**可以很高，一天几十次，这是开发节奏；
- **发布频率**是一个 tag 一次「这批东西交付完了」的承诺。

规则：

1. 一个 `release/*` 分支对应**一个主题**，主题的交付清单没清完，不打 tag；
2. 同主题的连续修复不新开分支、不新升版本号，就在当前 release 分支上继续提交；
3. 版本号在 `release:start` 时按 §5.1 定，定完不改——改号要重跑门禁，且会让 MR 描述与 tag 对不上。

反例（2026-11-11 实际发生）：v8.4 到 v8.9 六个 tag 集中在 1 小时 44 分内，单版 579~2036 行。
按 §5.1，v8.4~v8.8 都是 v8.3 的收尾，应当是 PATCH 或并入 v8.3。后果不是「版本号不好看」，而是：

- 回滚时六个 tag 都「可以」，没有一个是「当时上线的那个」；
- 被问到「MCP 审批哪天生效的」答不出来——答案是 06:15，而那天没有人上线。

### 5.3 每次发布必须写变更记录

仓库根目录的 [`CHANGELOG.md`](../../CHANGELOG.md) 是唯一的人读入口：

- 按「新增 / 修复 / 要做的」分组，一条一句，**不抄 commit 标题**；
- 「要做的」写清升级方需要执行的动作（填配置、跑迁移、改调用），没有就写「无」；
- 技术推演、取舍、反向验证过程写 `docs/03-迭代/`，CHANGELOG 只放链接。

`pnpm release:notes` 输出的是提交清单，给 MR 描述用；CHANGELOG 是给人读的。两者不互相替代：
前者回答「改了哪些提交」，后者回答「我受影响了吗、要做什么」。

### 5.4 三种写法各管一段

| 用途 | 写法 | 例子 |
|---|---|---|
| Git tag / package.json / 发布说明 | 语义化版本 `X.Y.Z` | `8.10.0` |
| 文档里的迭代批次 | `V8.10`（仅作文档目录名与标题） | `优化记录-v8.10-xxx.md` |
| 破坏性变更 / 主题换代 | 升 MAJOR | `9.0.0` |

`release:start` 会同步改 `package.json`，所以 tag 与版本号不会漂移。文档迭代号与 tag 的对应关系
写进 `docs/03-迭代/` 对应记录与 `CHANGELOG.md` 的文首即可。

## 6. 线上紧急修复（hotfix）

```bash
git switch --detach v7.6.0          # 从出问题的 tag 切，不在 main 上改
git switch -c hotfix/v7.6.1
# 修复 + 只提交修复相关改动
pnpm release:check
# 合回 main、打 v7.6.1，并把修复同步回当前 release（如果还在开发）
```

hotfix 只修 bug，不夹带新功能；修完必须补一条回归用例（`tests/` 或 `evals/`），否则同类问题会再犯。

## 7. 「干净基线」验收清单（每次合并 main 前逐条过）

- [ ] 全新 clone 后：`pnpm install` → `cp .env.example .env.local` → `pnpm dev` 能起来，首页能注册/登录
- [ ] 仓库里没有 `.env.local`、`data/`、`.next/`、`*.log`、临时脚本、注释掉的大段代码
- [ ] `package.json` 版本 = 即将打的 tag
- [ ] `README.md` 的「快速开始」未过期；`docs/README.md` 索引已补本轮记录
- [ ] 没有把「暂时这样」「TODO 上线前删」留在代码里（确实要留的写进 issue 并在 MR 说明）
- [ ] 数据库变更能在旧库上幂等执行（`lib/db.ts` 的 `CREATE TABLE IF NOT EXISTS` + `ALTER`）

> 注意：main 的「干净」指**无本地环境残留**，不是「空仓库」。功能代码、文档、测试一个都不能少。

## 8. master → main 迁移（已完成）

**状态（2026-10-29）**：Gitee 默认分支已改为 `main`，远端只剩 `refs/heads/main`，旧 `master` 已删除，标签从 `v7.6.0` 起。

**其他同事的本地仓库**（迁移后一次性执行）：

```bash
git fetch --prune
git branch -m master main          # 若本地仍叫 master
git branch -u origin/main main
git remote set-head origin -a
```

**校验**：`git ls-remote --symref origin HEAD` 应输出 `ref: refs/heads/main HEAD`；新 clone 默认检出 `main`。

> 不要再创建 `master`；若团队决定长期保留它作为生产分支，把本文所有 `main` 读作 `master` 即可，钩子会同时拦截两者。

## 9. 自动化落点（为什么不是「只写进 README」）

| 你想要的 | 落在哪 | 说明 |
|---|---|---|
| 新人一眼看懂怎么参与 | `README.md` + 本文 | README 放 5 行摘要和链接，细节只在本文维护，避免两处不一致 |
| AI 每次自动按流程做 | `.opencode/skills/git-release/SKILL.md` | 说「发版/开分支/合并」时自动加载，按本文步骤执行并做前置校验 |
| 违规时立刻被拦住 | `.githooks/` + `pnpm hooks:install` | `pnpm install` 的 `prepare` 会自动装；`--no-verify` 能绕，但会被下一层兜住 |
| 绕过本地也能兜住 | Gitee 保护分支 + MR | 远端强制，唯一真正不可绕过的层 |
| 操作不用记命令 | `scripts/release.mjs` | `start / check / finish / tag / notes` 子命令，失败即停 |

## 10. 常见错误处理

| 场景 | 处理 |
|---|---|
| 已经在 main 上提交了（还没 push） | `git switch -c release/vX.Y.Z` 把提交带走，main 用 `git reset --hard origin/main` 复位 |
| 已经 push 到 main 了 | 不要 force push 覆盖历史；把改动 cherry-pick 到 release 分支，再按正常流程合并，并在群里说明 |
| 合并后发现严重 bug | 走 §6 hotfix，禁止回滚 main 历史（除非密钥/数据事故） |
| 忘了打 tag | 在 main 对应合并提交上补 `git tag -a vX.Y.Z <sha>` 并推送；不要移动已有 tag |
| 两个 release 同时开发 | 允许，但先合并的那个先打 tag；后合并的必须 `git merge main` 解冲突并重跑 `release:check` |
| 钩子没生效 | `pnpm hooks:install`，然后 `git config --get core.hooksPath` 应输出 `.githooks` |

## 11. 多人协作与权限（谁能让 main 变化）

一句话：**所有人都可以贡献代码，只有维护者能让 `main` 前进。**

### 11.1 角色与权限

| 角色 | 仓库权限 | 推自己的分支 | 开 MR | 合并到 `main` | 打 tag / 发版 |
|---|---|---|---|---|---|
| 观察者 / 报告者 | 只读 | 否 | 否 | 否 | 否 |
| 开发者（Developer） | 读写（保护分支除外） | 是 | 是 | **否**（默认） | **否** |
| 维护者（管理员 / Owner） | 管理员 | 是 | 是 | 是 | 是 |

两条落地要点：

1. **加人只给「开发者」，不给「管理员」。** 管理员通常能绕过保护分支，等于把 `main` 交出去。
2. 保护分支里「可推送代码成员」选**禁止任何人**、「可合并 Pull Request 成员」勾维护者。这样开发者能推 `feature/*`、能开 MR，但**合并按钮是灰的**；维护者自己也不能直推，得走 MR——「必须合并才生效」才是真的生效。

> 私有仓库必须先把人加进仓库成员才能 clone；公开仓库的非成员只能 fork，在 fork 里改完发 PR，同样合不了 `main`。

### 11.2 多人时的分支流

```
main                                  ← 只有维护者能合并、打 tag
 └── release/v7.7.0                   ← 维护者开，决定这一版收什么
      ├── feature/zhang-chat-stop     ← 同事 A，从 release 切
      └── feature/li-rag-rerank       ← 同事 B，从 release 切
```

- 同事只推 `feature/*`，开 MR **合进当前的 `release/*`**，不要直接对着 `main` 开 MR。
- 维护者在 release 上收 MR、跑门禁，最后整条 release → main，一个 tag 对应一个完整迭代。
- 紧急线上问题走 `hotfix/vX.Y.Z`（见 §6），同样只由维护者合并、打 tag。

### 11.3 贡献者（非维护者）步骤

```bash
git clone https://gitee.com/XiaoZuiNiZhenHao/hexcore.git
cd hexcore
pnpm install && pnpm hooks:install

git fetch origin
git switch -c feature/zhang-chat-stop origin/release/v7.7.0   # 从当前 release 切
# 开发、提交、自检
pnpm release:check

git push -u origin feature/zhang-chat-stop
# 在 Gitee 网页开 MR：源 feature/zhang-chat-stop → 目标 release/v7.7.0
```

贡献者**不要做**：

- 不合并 MR、不推 `main`、不打 tag、不改 `package.json` 的 version。
- 不 `git push --force`，不改写已推送历史。
- 不在一个 MR 里混多个不相关改动；不提交 `.env.local`、`data/`、构建产物。

### 11.4 维护者步骤

```bash
# 1) 收 feature MR
git switch release/v7.7.0 && git pull --ff-only
# 在网页审查并合并 feature MR（或本地 merge --no-ff 后推送）

# 2) 整条 release 验收
pnpm release:check
git push -u origin release/v7.7.0

# 3) 合入 main：开了保护分支就走 MR
#    网页开 MR：release/v7.7.0 → main，合并
git switch main && git pull --ff-only
pnpm release:tag 7.7.0 --push        # 只有维护者能执行

# 4) 收尾：删除 release 分支，发通知
pnpm release:notes
```

若仓库**没开**保护分支，第 3 步可改用 `pnpm release:finish 7.7.0 --push`。

### 11.5 MR 审查清单（维护者逐条看）

- [ ] 目标分支正确：feature → `release/*`，release → `main`，没有跨层直合。
- [ ] 改动范围与 MR 标题一致，没有顺手夹带重构 / 格式化 / 无关文件。
- [ ] 提交信息符合 `<type>(<scope>): <描述>`。
- [ ] MR 里贴了 `pnpm release:check` 结果；改主流程的贴了 `pnpm e2e` 结果。
- [ ] 没有 `.env.local`、密钥、`data/`、日志、临时脚本。
- [ ] 数据库变更能在旧库幂等执行（`CREATE TABLE IF NOT EXISTS` + `ALTER`）。
- [ ] UI 改动附截图，并符合 [`界面开发规范.md`](./界面开发规范.md)。
- [ ] 写清回滚方式（通常是 `git revert <merge-sha>`）。

### 11.6 保护分支配置（Gitee 网页）

分两步，**缺第二步等于没配**：

**第一步：建规则**（仓库 → 管理 → 保护分支设置 → 新建规则）

| 配置项 | 推荐值 | 说明 |
|---|---|---|
| 分支名称 | `main` | 必要时连 `release/*` 一起护 |
| 可推送代码成员 | **禁止任何人** | 选「仅维护者」时维护者自己仍能直推，想连自己一起锁死就选这个 |
| 可合并 Pull Request 成员 | 仅维护者 | 决定谁能点合并按钮 |
| 评审模式 | **开启** | 无推送权限者的推送会**自动转成 MR**，而不是报错把代码弹回去 |
| 合并方式 | 保留合并提交（`--no-ff`） | 不要 squash，否则 tag 回溯失去意义 |
| 合并后删除源分支 | 开启 | feature / release 都适用 |

**第二步：把分支状态改成「保护分支」**

代码 → 分支 → 管理 → 找到 `main` → 分支状态：常规分支 → **保护分支**。

> ⚠️ **这一步最容易漏，漏了规则完全不生效。** Gitee 的规则是「条文」，分支状态是「这颗分支受不受条文管」。
> 判据只有一个：回到保护分支设置页，规则那行必须显示**「作用于 1 个分支」**。
> 显示「作用于 0 个分支」并被标红「规则没有生效?」时，规则就是一张废纸。

#### 配好之后的行为（2026-11-13 实测）

| 尝试动作 | 服务端回执 | `main` 是否变化 |
|---|---|---|
| 推普通分支 `feature/*` | 成功，并提示可创建 MR | 不涉及 |
| 直推 `main` | `Cannot push to a protected branch 'refs/heads/main' directly`，自动建 MR | 否 |
| 强推 `main`（`--force`） | `Target branch is in review mode`，转投 `auto/main/...` 评审分支 | 否 |
| 删除 `main`（`git push origin :main`） | `The protected branch does not allow deletion`，`pre-receive hook declined` | 否 |

三种拦法强度不同：**删除是硬拒绝**（连试都不许），推送和强推是「引流成 MR」。所以判断保护是否生效，不要看命令成功与否（评审模式下推送的退出码是 0），**要看远端 `main` 的 SHA 有没有变**。

> 保护分支只管 `refs/heads/*`，**管不到 tag**。谁都能推 tag，服务端没有对应开关，只能靠本地 `pre-push` 钩子拦（可被 `--no-verify` 绕过）。

### 11.7 维护者标识与本地兜底

仓库根目录的 [`.release-owner`](../../.release-owner) 记录维护者邮箱（一行一个，`#` 开头为注释）：

```text
XiaoZuiNiZhenHao@users.noreply.gitee.com
```

- `pnpm release:finish`、`pnpm release:tag` 会校验 `git config user.email`；不匹配直接失败并提示走 MR。
- 推送 `main` 或**推送任何 tag**时，`pre-push` 钩子会再校验一次，非维护者被拦。
- `pnpm release:status` 会显示「维护者：是 / 不是」。
- 维护者换邮箱：把新邮箱加进 `.release-owner`；临时用其他邮箱操作可加 `--as-maintainer` 显式放行。
- 这一层是**本地防呆**，能被 `--no-verify` 绕过；真正不可绕过的是 §11.6 的远端保护。

### 11.8 版本号与 tag 归属

- 版本号由维护者在 `release:start` / 发版时决定；贡献者的 feature 分支**不要改** `package.json` 的 version。
- tag 只在 `main` 的合并提交上打，且只由维护者打；多人各打 tag 会让版本号打架、无法回溯。
- 发错版本：发新补丁版，禁止移动或覆盖已有 tag（§4）。

## 相关

- 提交前最低要求与代码约定：[`AGENTS.md`](../../AGENTS.md)
- 项目入口与快速开始：[`README.md`](../../README.md)
- 文档索引维护约定：[`docs/README.md`](../README.md)
