import fs from 'node:fs';
import path from 'node:path';

/**
 * 评测进程的环境变量装载。
 *
 * 为什么需要：`next dev` 会自动读 `.env.local`，而 vitest 不会。
 * 少了它，最典型的报错是 `lib/crypto.ts` 用兜底密钥派生的 KEY 去解数据库里的密文 →
 * 「Unsupported state or unable to authenticate data」，看起来像是 Key 坏了，其实是没读到 APP_SECRET。
 *
 * 自己解析而不是装 dotenv：只要 KEY=VALUE 这一种形态，多一个依赖不值当。
 * 也不覆盖已有值（`npm run eval` 前手工 export 的变量优先）。
 */
for (const f of ['.env.local', '.env']) {
  const p = path.join(process.cwd(), f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
