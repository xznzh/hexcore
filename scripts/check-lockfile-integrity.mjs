#!/usr/bin/env node
/**
 * 锁文件完整性守卫。
 *
 * 为什么需要：`pnpm-lock.yaml` 里的 integrity 是 base64 的 sha512，一旦被某个环节
 * 按错误编码写出（实测见过 base64 片段 "O3" 被替换成两个汉字），哈希就永久错了。
 * 表现极具迷惑性：`pnpm install` 报 `ERR_PNPM_TARBALL_EXTRACT ... object null is not
 * iterable`，看不出是哪个包、也看不出是哈希问题；本地因为 store 已缓存而能装上，
 * 换一台机器或进 Docker（`--frozen-lockfile`）就必然失败。
 *
 * 所以把它变成一道显式的门禁：integrity 必须是纯 ASCII 的 base64。
 * 发现问题的修复方式不是手改哈希，而是删掉对应包在本地 store 的元数据缓存后重新解析，
 * 或者从 registry 取 `dist.integrity` 逐条核对（两者应完全一致）。
 *
 * 用法：node scripts/check-lockfile-integrity.mjs
 */

import { readFileSync } from 'node:fs';

const LOCK = new URL('../pnpm-lock.yaml', import.meta.url);
const BASE64 = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

const text = readFileSync(LOCK, 'utf8');
const lines = text.split('\n');

const bad = [];
let pkg = '(未知)';
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // 包名行：`  name@version:`（scoped 包带引号）
  const m = line.match(/^ {2}('?[^\s][^:]*'?)@([^:]+):\s*$/);
  if (m) pkg = `${m[1].replace(/'/g, '')}@${m[2].replace(/'/g, '')}`;
  if (!line.includes('integrity:')) continue;
  const value = line.slice(line.indexOf('integrity:') + 'integrity:'.length).replace(/[}\s]/g, '');
  if (!BASE64.test(value)) bad.push({ line: i + 1, pkg, value });
}

if (bad.length) {
  console.error(`❌ pnpm-lock.yaml 有 ${bad.length} 处 integrity 不是合法 base64：\n`);
  for (const b of bad) {
    console.error(`  第 ${b.line} 行  ${b.pkg}`);
    console.error(`     ${b.value.slice(0, 96)}${b.value.length > 96 ? '…' : ''}`);
  }
  console.error(
    '\n这类锁文件会让 `--frozen-lockfile` 安装失败（本地可能因为 store 缓存而侥幸通过）。' +
      '\n修复：从 registry 取该版本的 dist.integrity 核对后替换，或清掉本地元数据缓存重新解析。',
  );
  process.exit(1);
}

const total = lines.filter((l) => l.includes('integrity:')).length;
console.log(`✅ 锁文件 integrity 校验通过（${total} 条，全部为合法 base64）`);
