#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Git 分支与发布助手（见 docs/04-规范/Git分支与发布规范.md）
 *
 *   node scripts/release.mjs start 7.6.0     从 main 切 release/v7.6.0，并同步 package.json 版本
 *   node scripts/release.mjs check           跑全量门禁（typecheck + UI 规范 + 单测 + 文档链接）
 *   node scripts/release.mjs finish 7.6.0    合并回 main、打 tag、删分支（默认交互确认）
 *   node scripts/release.mjs notes           生成发布说明
 *   node scripts/release.mjs status          当前分支 / tag / 门禁状态
 *
 * 钩子子命令（由 .githooks 调用，一般不手动执行）：
 *   guard:commit | guard:msg <msgFile> | guard:push
 */

const PROD_BRANCHES = new Set(['main', 'master']);
const RELEASE_RE = /^release\/v\d+\.\d+\.\d+$/;
const HOTFIX_RE = /^hotfix\/v\d+\.\d+\.\d+$/;
const FEATURE_RE = /^feature\/[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CONVENTIONAL_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9\-./]+\))?!?: .{2,}/;

// 钩子/脚本可能从子目录被调用，统一到仓库根
try {
  process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
} catch {
  console.error('✖ 当前目录不是 Git 仓库');
  process.exit(1);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const red = (t) => c(31, t);
const green = (t) => c(32, t);
const yellow = (t) => c(33, t);
const dim = (t) => c(2, t);

function fail(title, lines = []) {
  console.error(`\n${red('✖ ' + title)}`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = String(err.stderr || err.message || '').trim();
    fail(`git ${args.join(' ')} 失败`, detail ? detail.split('\n') : []);
  }
}

function tryGit(args) {
  return git(args, { allowFail: true });
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']);
}

function hasRef(ref) {
  return Boolean(tryGit(['rev-parse', '--verify', '--quiet', ref]));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${dim('[y/N]')} `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function runStep(label, scriptPath, args = []) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.error) fail(`${label} 无法启动`, [String(result.error.message)]);
  if (result.status !== 0) fail(`${label} 未通过`, ['修完再提交/合并；不要用 --no-verify 绕过。']);
  console.log(green(`✓ ${label}`));
}

function prodBranch() {
  if (hasRef('refs/heads/main') || hasRef('refs/remotes/origin/main')) return 'main';
  return 'master';
}

function ensureClean(what) {
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    fail(`${what}要求工作区干净，当前还有未提交内容：`, dirty.split('\n').slice(0, 10));
  }
}

function bumpPackageVersion(version) {
  const file = path.join(process.cwd(), 'package.json');
  const raw = fs.readFileSync(file, 'utf8');
  const next = raw.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${version}$3`);
  if (next === raw && !raw.includes(`"version": "${version}"`)) {
    fail('无法写入 package.json 的 version 字段');
  }
  fs.writeFileSync(file, next);
}

function markerPath() {
  return path.join(process.cwd(), '.git', 'release-check.json');
}

function writeMarker(sha, version) {
  fs.writeFileSync(markerPath(), JSON.stringify({ sha, version, at: Date.now() }, null, 2));
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- maintainer

function maintainerEmails() {
  try {
    return fs
      .readFileSync(path.join(process.cwd(), '.release-owner'), 'utf8')
      .split(/[\s,;]+/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function currentEmail() {
  return (tryGit(['config', 'user.email']) || '').trim().toLowerCase();
}

function isMaintainer() {
  if (process.env.RELEASE_AS_MAINTAINER === '1') return true;
  const owners = maintainerEmails();
  return owners.length === 0 || owners.includes(currentEmail());
}

function assertMaintainer(flags, action) {
  const owners = maintainerEmails();
  const email = currentEmail();

  if (owners.length === 0) {
    console.log(yellow('⚠ 未找到 .release-owner，跳过维护者校验（建议补上维护者邮箱）'));
    return;
  }
  if (owners.includes(email)) {
    console.log(dim(`（维护者：${email}）`));
    return;
  }
  if (flags.has('--as-maintainer')) {
    console.log(yellow(`⚠ 当前邮箱 ${email || '（未设置）'} 不是维护者，已按 --as-maintainer 显式放行`));
    return;
  }
  fail(`${action} 只允许维护者执行`, [
    `当前 git user.email：${email || '（未设置）'}`,
    `维护者：${owners.join('、')}`,
    '',
    '其他人请走：推送 feature/release 分支 → 开 MR → 由维护者合并。',
    '不要合并 main、不要打 tag、不要发版。',
    '维护者换邮箱时，把邮箱写进 .release-owner；临时放行加 --as-maintainer。',
  ]);
}

function releaseNotes(fromTag) {
  if (!fromTag) {
    const log = git(['log', '--no-merges', '--pretty=format:- %s (%h)', '-20']);
    return log ? `${log}\n- …（首次发版，仅列最近 20 条）` : '（没有可展示的提交）';
  }
  const log = git(['log', '--no-merges', '--pretty=format:- %s (%h)', `${fromTag}..HEAD`]);
  return log || '（没有可展示的提交）';
}

// ---------------------------------------------------------------- guards

function guardCommit() {
  const branch = currentBranch();

  if (process.env.GIT_GUARD_SKIP === '1') {
    console.log(yellow('⚠ 已设置 GIT_GUARD_SKIP=1，跳过分支与类型检查（请自行承担风险）'));
    return;
  }

  if (PROD_BRANCHES.has(branch)) {
    fail(`禁止在 ${branch} 上直接提交`, [
      '正确做法：',
      `  pnpm release:start <版本号>     # 例如 pnpm release:start 7.6.0`,
      '  git switch -c release/vX.Y.Z   # 已有 release 分支时直接切过去',
      '',
      '已误提交但还没 push：',
      `  git switch -c release/vX.Y.Z && git reset --hard origin/${branch}`,
    ]);
  }

  if (branch === 'HEAD') {
    fail('当前处于 detached HEAD，提交会丢', ['先 git switch -c release/vX.Y.Z 再提交。']);
  }

  if (!RELEASE_RE.test(branch) && !HOTFIX_RE.test(branch) && !FEATURE_RE.test(branch)) {
    console.log(yellow(`⚠ 分支名 "${branch}" 不符合规范（release/vX.Y.Z、hotfix/vX.Y.Z、feature/<主题>），仅提醒。`));
  }

  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) {
    console.log(dim('（没有暂存内容，跳过检查）'));
    return;
  }

  runStep('类型检查 tsc --noEmit', path.join('node_modules', 'typescript', 'bin', 'tsc'), ['--noEmit']);

  const touchesUi = staged
    .split('\n')
    .some((f) => f.startsWith('app/') || f.startsWith('components/'));
  if (touchesUi) {
    runStep('界面规范检查', path.join('scripts', 'check-ui-spec.mjs'));
  }
}

function guardMessage(msgFile) {
  if (!msgFile || !fs.existsSync(msgFile)) return;
  const raw = fs.readFileSync(msgFile, 'utf8');
  const subject = raw.split('\n').find((line) => line.trim() && !line.startsWith('#')) || '';
  const allowed =
    CONVENTIONAL_RE.test(subject) ||
    /^(Merge |Revert |fixup!|squash!|chore\(release\): v)/.test(subject);

  if (!allowed) {
    fail('提交信息不符合 Conventional Commits', [
      `当前：${subject || '（空）'}`,
      '格式：<type>(<scope>): <描述>',
      'type：feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert',
      '示例：feat(chat): 支持停止生成',
    ]);
  }
  if (subject.length > 100) {
    console.log(yellow('⚠ 提交标题超过 100 字符，建议压缩到一行内。'));
  }
}

async function guardPush() {
  if (process.env.GIT_GUARD_SKIP === '1') return;

  const input = await readStdin();
  const lines = input.split('\n').map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!remoteRef) continue;

    // 打 tag / 推 tag 只归维护者，避免多人各打一版号
    if (remoteRef.startsWith('refs/tags/')) {
      if (!isMaintainer()) {
        fail(`禁止推送 tag ${remoteRef.replace('refs/tags/', '')}`, [
          `当前 git user.email：${currentEmail() || '（未设置）'}`,
          `维护者：${maintainerEmails().join('、')}`,
          'tag 只能由维护者在发布时创建并推送。',
        ]);
      }
      continue;
    }

    if (!remoteRef.startsWith('refs/heads/')) continue;

    const remoteBranch = remoteRef.replace('refs/heads/', '');
    const isDelete = /^0+$/.test(localSha || '');

    // 删除分支：生产分支永远拒绝；release/hotfix 的删除由 release:finish 授权
    if (isDelete) {
      if (PROD_BRANCHES.has(remoteBranch)) {
        fail(`禁止删除 ${remoteBranch}`, ['生产分支只能改名/迁移，不能删除。']);
      }
      if (process.env.RELEASE_FINISH !== '1') {
        console.log(yellow(`⚠ 正在删除远端分支 ${remoteBranch}（非 release:finish 调用，请确认这是有意操作）`));
      }
      continue;
    }

    if (PROD_BRANCHES.has(remoteBranch)) {
      if (process.env.RELEASE_FINISH === '1') {
        if (!isMaintainer()) {
          fail(`只有维护者才能推送 ${remoteBranch}`, [
            `当前 git user.email：${currentEmail() || '（未设置）'}`,
            `维护者：${maintainerEmails().join('、')}`,
            '其他人请推 release/feature 分支并开 MR。',
          ]);
        }
        console.log(dim(`（release:finish 授权推送 ${remoteBranch}）`));
      } else {
        fail(`禁止直接 push 到 ${remoteBranch}`, [
          'main 只接受 release/hotfix 的合并。',
          '正确做法：推到 release 分支 → 开 MR → 合并后由 release:finish 打 tag。',
          `  git push origin ${currentBranch()}`,
          '唯一例外：发布时用 pnpm release:finish <版本> --push。',
        ]);
      }
    }

    const zero = /^0+$/.test(remoteSha || '');
    if (!zero && remoteSha) {
      const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', remoteSha, localSha], {
        stdio: 'ignore',
      }).status === 0;
      if (!isAncestor) {
        fail(`禁止强推覆盖远端分支 ${remoteBranch}`, [
          '远端有你本地没有的提交，强推会丢别人的工作。',
          '先 git pull --rebase，解决冲突后再推。',
          '确需重写历史（身份修正 / 误提交密钥 / 仓库迁移）：先备份，再用 GIT_GUARD_SKIP=1 显式放行，做法见发布规范 §11.9。',
        ]);
      }
    }
  }
}

// ---------------------------------------------------------------- commands

function cmdStart(version) {
  if (!version) fail('缺少版本号', ['用法：pnpm release:start 7.6.0']);
  if (!VERSION_RE.test(version)) fail(`版本号 "${version}" 不合法`, ['格式：X.Y.Z，例如 7.6.0']);

  const branch = currentBranch();
  const prod = prodBranch();
  if (branch !== prod) {
    fail(`必须从 ${prod} 切出版本分支，当前在 ${branch}`, [
      `git switch ${prod} && git pull --ff-only`,
    ]);
  }
  ensureClean('切版本分支');

  if (hasRef(`refs/heads/release/v${version}`)) fail(`release/v${version} 已存在`);
  if (hasRef(`refs/tags/v${version}`)) fail(`tag v${version} 已存在，请换一个版本号`);

  console.log(`\n▶ 同步 ${prod}`);
  if (tryGit(['pull', '--ff-only']) === null) {
    console.log(yellow('⚠ pull 失败（可能没有配置 upstream），继续基于本地分支创建。'));
  }

  git(['switch', '-c', `release/v${version}`]);
  bumpPackageVersion(version);
  git(['add', 'package.json']);
  if (git(['diff', '--cached', '--name-only'])) {
    git(['commit', '-m', `chore(release): v${version}`]);
  } else {
    console.log(dim('package.json 版本已是 ' + version + '，跳过版本提交。'));
  }

  const current = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  console.log(`\n${green('✓ 已创建 release/v' + version)}  package.json version = ${current}`);
  console.log('下一步：正常开发并提交，完成后运行 `pnpm release:check`，再 `pnpm release:finish ' + version + '`。\n');
}

function cmdCheck() {
  const branch = currentBranch();
  console.log(`\n${dim('分支：')}${branch}`);

  runStep('类型检查 tsc --noEmit', path.join('node_modules', 'typescript', 'bin', 'tsc'), ['--noEmit']);
  runStep('界面规范检查', path.join('scripts', 'check-ui-spec.mjs'));
  runStep('单元测试 vitest run', path.join('node_modules', 'vitest', 'vitest.mjs'), ['run']);
  runStep('文档链接检查', path.join('scripts', 'check-doc-links.mjs'), ['.']);

  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const sha = git(['rev-parse', 'HEAD']);
  writeMarker(sha, version);
  console.log(`\n${green('✓ 门禁全部通过')}  v${version} @ ${sha.slice(0, 7)}`);
  console.log(dim('提示：改了主流程（登录/对话/知识库）请额外跑 pnpm e2e，并在 MR 里贴结果。\n'));
}

async function cmdFinish(version, flags) {
  if (!version) fail('缺少版本号', ['用法：pnpm release:finish 7.6.0 --yes']);
  if (!VERSION_RE.test(version)) fail(`版本号 "${version}" 不合法`);
  assertMaintainer(flags, '合并发布');

  const branch = currentBranch();
  const expected = [`release/v${version}`, `hotfix/v${version}`];
  if (!expected.includes(branch)) {
    fail(`当前在 ${branch}，但准备发布 v${version}`, [`先 git switch ${expected[0]}`]);
  }
  ensureClean('合并发布');

  const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  if (pkgVersion !== version) {
    fail(`package.json 版本 (${pkgVersion}) 与发布版本 (${version}) 不一致`, [
      `先改 package.json，或执行 pnpm release:start ${version}。`,
    ]);
  }
  if (hasRef(`refs/tags/v${version}`)) fail(`tag v${version} 已存在`, ['tag 只增不改，请发新补丁版。']);

  const prod = prodBranch();
  const lastTag = tryGit(['describe', '--tags', '--abbrev=0']);
  const notes = releaseNotes(lastTag);
  console.log(`\n${dim('即将：')}${branch} → ${prod}，打 tag v${version}${lastTag ? `，上一版 ${lastTag}` : ''}`);
  console.log(`\n${dim('本轮提交：')}\n${notes}\n`);

  cmdCheck();

  if (!flags.has('--yes')) {
    const ok = await confirm(`确认合并到 ${prod} 并打 tag v${version}？`);
    if (!ok) {
      console.log(yellow('已取消，release 分支保持不变。'));
      return;
    }
  }

  git(['switch', prod]);
  if (tryGit(['pull', '--ff-only']) === null) {
    console.log(yellow(`⚠ ${prod} 未拉取成功，将基于本地 ${prod} 合并。`));
  }

  git(['merge', '--no-ff', branch, '-m', `chore(release): v${version}`]);
  git(['tag', '-a', `v${version}`, '-m', `v${version}`, '-m', notes]);
  writeMarker(git(['rev-parse', 'HEAD']), version);

  let pushed = false;
  if (flags.has('--push')) {
    console.log(`\n▶ 推送 ${prod} 与 tag`);
    const pushEnv = {
      ...process.env,
      RELEASE_FINISH: '1',
      RELEASE_AS_MAINTAINER: flags.has('--as-maintainer') ? '1' : '',
    };
    const pushBranch = spawnSync('git', ['push', 'origin', prod], { stdio: 'inherit', env: pushEnv });
    const pushTag = pushBranch.status === 0
      ? spawnSync('git', ['push', 'origin', `v${version}`], { stdio: 'inherit', env: pushEnv })
      : { status: 1 };
    if (pushBranch.status !== 0 || pushTag.status !== 0) {
      fail('本地已合并并打 tag，但推送失败', [
        `修复网络/权限后执行：git push origin ${prod} && git push origin v${version}`,
        'release 分支未删除，可继续排查。',
      ]);
    }
    pushed = true;
  }

  git(['branch', '-d', branch]);
  if (pushed && hasRef(`refs/remotes/origin/${branch}`)) {
    const del = spawnSync('git', ['push', 'origin', '--delete', branch], {
      stdio: 'inherit',
      env: { ...process.env, RELEASE_FINISH: '1' },
    });
    if (del.status !== 0) console.log(yellow(`⚠ 远端 ${branch} 未删除，请手动：git push origin --delete ${branch}`));
  }

  console.log(`\n${green(`✓ 已发布 v${version}`)}${pushed ? '（已推送）' : dim('（仅本地，记得 git push origin ' + prod + ' && git push origin v' + version + '）')}`);
  console.log(dim(`已删除 ${branch}，tag 保留。发布说明：pnpm release:notes\n`));
}

function cmdNotes() {
  const lastTag = tryGit(['describe', '--tags', '--abbrev=0']);
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  console.log(`## v${version}${lastTag ? ` (${lastTag}..HEAD)` : ''}\n`);
  console.log(releaseNotes(lastTag));
  console.log('');
}

// MR 模式：release 分支已通过网页合并进 main，本地只需打 tag
function cmdTag(version, flags) {
  if (!version) fail('缺少版本号', ['用法：pnpm release:tag 7.6.0 --push']);
  if (!VERSION_RE.test(version)) fail(`版本号 "${version}" 不合法`);
  assertMaintainer(flags, '打 tag');

  const prod = prodBranch();
  const branch = currentBranch();
  if (branch !== prod) {
    fail(`打 tag 必须在 ${prod} 上（MR 合并完成后）`, [`git switch ${prod} && git pull --ff-only`]);
  }
  ensureClean('打 tag');

  const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  if (pkgVersion !== version) fail(`package.json 版本 (${pkgVersion}) 与发布版本 (${version}) 不一致`);
  if (hasRef(`refs/tags/v${version}`)) fail(`tag v${version} 已存在`, ['tag 只增不改，请发新补丁版。']);

  tryGit(['fetch', 'origin']);
  const upstream = tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) {
    const behind = git(['rev-list', '--count', `HEAD..${upstream}`]);
    if (behind !== '0') fail(`本地 ${prod} 落后 ${upstream} ${behind} 个提交`, ['先 git pull --ff-only，确认 MR 已合并。']);
  }

  const lastTag = tryGit(['describe', '--tags', '--abbrev=0']);
  const notes = releaseNotes(lastTag);
  console.log(`\n${dim('即将在')} ${prod} @ ${git(['rev-parse', '--short', 'HEAD'])} ${dim('打 tag')} v${version}`);
  console.log(`\n${dim('本轮提交：')}\n${notes}\n`);

  git(['tag', '-a', `v${version}`, '-m', `v${version}`, '-m', notes]);
  writeMarker(git(['rev-parse', 'HEAD']), version);

  if (flags.has('--push')) {
    console.log(`\n▶ 推送 tag v${version}`);
    const pushed = spawnSync('git', ['push', 'origin', `v${version}`], {
      stdio: 'inherit',
      env: {
        ...process.env,
        RELEASE_AS_MAINTAINER: flags.has('--as-maintainer') ? '1' : '',
      },
    });
    if (pushed.status !== 0) fail('tag 已创建但推送失败', [`修复后执行：git push origin v${version}`]);
  }

  console.log(`\n${green(`✓ 已打 tag v${version}`)}${flags.has('--push') ? '（已推送）' : dim(`（仅本地，记得 git push origin v${version}）`)}\n`);
}

function cmdStatus() {
  const branch = currentBranch();
  const prod = prodBranch();
  const lastTag = tryGit(['describe', '--tags', '--abbrev=0']) || '（无）';
  const dirty = git(['status', '--porcelain']);
  const marker = readMarker();
  const head = git(['rev-parse', 'HEAD']);

  console.log(`\n分支        ${branch}${PROD_BRANCHES.has(branch) ? yellow('  ← 生产分支，不要直接提交') : ''}`);
  console.log(`生产分支    ${prod}`);
  const owners = maintainerEmails();
  const email = currentEmail();
  const ownerState = owners.length === 0
    ? yellow('未配置 .release-owner，跳过校验')
    : owners.includes(email)
      ? green(`是（${email}）`)
      : yellow(`不是（当前 ${email || '未设置'}）← 只能推分支开 MR`);
  console.log(`维护者      ${ownerState}`);
  console.log(`最新 tag    ${lastTag}`);
  console.log(`工作区      ${dirty ? yellow(`${dirty.split('\n').length} 项未提交`) : green('干净')}`);
  const checkState = !marker || marker.sha !== head
    ? yellow('当前提交未验证，跑 pnpm release:check')
    : dirty
      ? yellow(`HEAD 已通过（v${marker.version}），但工作区有未提交改动`)
      : green(`已通过（v${marker.version} @ ${head.slice(0, 7)}）`);
  console.log(`门禁        ${checkState}`);
  console.log('');
}

function usage() {
  console.log(`
Git 分支与发布助手 · 规范见 docs/04-规范/Git分支与发布规范.md

  pnpm release:start <X.Y.Z>              从 main 切 release/vX.Y.Z 并同步版本号
  pnpm release:check                      全量门禁（typecheck / UI 规范 / 单测 / 文档链接）
  pnpm release:finish <X.Y.Z> [--yes] [--push]
                                          合并回 main、打 tag、删分支（仅维护者；未开保护分支时）
  pnpm release:tag <X.Y.Z> [--push]       已用 MR 合并后，在 main 上补 tag（仅维护者）
  pnpm release:notes                      生成发布说明
  pnpm release:status                     查看分支 / tag / 门禁 / 维护者状态
  pnpm hooks:install                      安装 .githooks（每个 clone 一次）

  维护者由 .release-owner 指定（git user.email 必须匹配）；
  换邮箱临时放行加 --as-maintainer。其他人只能推分支并开 MR。
`);
}

// ---------------------------------------------------------------- entry

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
const positional = rest.filter((arg) => !arg.startsWith('--'));

switch (command) {
  case 'start':
    cmdStart(positional[0]);
    break;
  case 'check':
    cmdCheck();
    break;
  case 'finish':
    await cmdFinish(positional[0], flags);
    break;
  case 'notes':
    cmdNotes();
    break;
  case 'tag':
    cmdTag(positional[0], flags);
    break;
  case 'status':
    cmdStatus();
    break;
  case 'guard:commit':
    guardCommit();
    break;
  case 'guard:msg':
    guardMessage(positional[0]);
    break;
  case 'guard:push':
    await guardPush();
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}
