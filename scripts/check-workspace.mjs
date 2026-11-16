#!/usr/bin/env node
// 工作区卫生检查：拦两类「本地调试痕迹被误提交」的情况。
//
// 为什么需要它：这两条都靠"记得"防不住，而后果都不是报错，是悄悄坏掉。
//
// 1) tsconfig.json 的 include 被 Next 写进了临时构建目录。
//    next build / next dev 都会按当前 distDir 追加 "<distDir>/types/**" 这一类条目，
//    用 NEXT_DIST_DIR=.next-verify 跑一次，tsconfig 就绑死在那个名字上。
//    本项目 README 与 AGENTS 都推荐这种用法（dev 开着时验证构建），所以很容易踩。
//    注意：include 里的 ".next*/types" 通配拦不住它——Next 是按精确字符串判断的。
//
// 2) .env.local / .env 被 git 跟踪。
//    .gitignore 已经写了，但 git add -f 或"改名后复制"都能绕过去。
//    这类文件里有 APP_SECRET 与模型 Key，一旦进了历史就基本只能重写仓库。
//
// （本题注不用块注释：路径里的 "*/" 会提前闭合注释。）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const problems = [];

// —— 1. tsconfig 的 include ——
const TS_ALLOWED = new Set(['next-env.d.ts', '**/*.ts', '**/*.tsx', '**/*.mts', '.next*/types/**/*.ts']);

let include = [];
try {
  const raw = fs.readFileSync('tsconfig.json', 'utf8');
  // tsconfig 允许注释与尾逗号，JSON.parse 吃不下；这里只取 include 数组做粗解析
  const m = raw.match(/"include"\s*:\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('找不到 include 字段');
  include = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
} catch (e) {
  problems.push(`tsconfig.json 解析失败：${e.message}`);
}

for (const entry of include) {
  if (TS_ALLOWED.has(entry)) continue;
  // 只拦「构建产物目录」这一类；其他自加路径（如 tests/**）属正常修改
  if (/^\.next[^/]*\/types\/\*\*\/\*\.ts$/.test(entry)) {
    problems.push(
      `tsconfig.json 的 include 含临时构建目录 "${entry}"。\n` +
        `    这是 next build/dev 按 NEXT_DIST_DIR 自动追加的，提交前应删掉；\n` +
        `    保留通配 ".next*/types/**/*.ts" 即可。`,
    );
  }
}

// 重复项也算问题：同一目录两种写法并存，读者会以为是两回事
const dup = include.filter((v, i) => include.indexOf(v) !== i);
if (dup.length) problems.push(`tsconfig.json 的 include 有重复项：${[...new Set(dup)].join(', ')}`);

// —— 2. next-env.d.ts 的 reference path ——
// 同一根因的第二个受害者：Next 也会把 routes.d.ts 的引用路径改成当前 distDir，
// 而这个文件**在版本库里**。被污染后别人 clone 下来类型检查就指向不存在的目录。
try {
  const envDts = fs.readFileSync('next-env.d.ts', 'utf8');
  const m = envDts.match(/"\.\/([^/"]+)\/types\/routes\.d\.ts"/);
  if (m && m[1] !== '.next') {
    problems.push(
      `next-env.d.ts 指向了 "${m[1]}/types/routes.d.ts"，应为 ".next"。\n` +
        `    这同样是 NEXT_DIST_DIR 的副作用，执行 git checkout next-env.d.ts 恢复。`,
    );
  }
} catch {
  // 文件不存在（未跑过 next dev/build 的全新 clone）属正常
}

// —— 3. 环境文件是否被跟踪 ——
try {
  const tracked = execFileSync('git', ['ls-files', '.env', '.env.local', '.env.*.local'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of tracked) {
    if (f === '.env.example') continue;
    problems.push(`环境文件 ${f} 已被 git 跟踪——它可能含密钥，应立即 git rm --cached 并轮换凭据。`);
  }
} catch {
  // 非 git 目录（例如解压出来的源码包）跳过这项
}

if (problems.length) {
  console.error('\n✖ 工作区卫生检查未通过：\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`✅ 工作区卫生检查通过（tsconfig include ${include.length} 项，无环境文件被跟踪）`);
