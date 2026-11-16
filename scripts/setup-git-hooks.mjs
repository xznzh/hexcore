import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 安装仓库内置 Git 钩子（.githooks）。
 * 每个 clone 只需执行一次：pnpm hooks:install
 * 说明见 docs/04-规范/Git分支与发布规范.md
 */

let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
} catch {
  console.log('跳过 Git 钩子安装：当前目录不是 Git 工作区（如 npm 包解压目录）。');
  process.exit(0);
}
process.chdir(root);

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });

for (const name of fs.readdirSync('.githooks')) {
  const file = path.join('.githooks', name);
  if (!fs.statSync(file).isFile()) continue;
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Windows 上 chmod 是空操作，Git for Windows 自带 sh，可正常执行
  }
  console.log(`  ✓ ${name}`);
}

const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
console.log(`\n✅ 已启用 core.hooksPath = ${current}`);
console.log('   现在在 main 上提交/推送、提交信息不规范、强推覆盖远端都会被拦下。');
console.log('   临时跳过（不推荐）：GIT_GUARD_SKIP=1 git commit ...\n');
