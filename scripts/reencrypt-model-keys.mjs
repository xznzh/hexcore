// 一次性迁移：APP_SECRET 轮换后，把 models.api_key 从旧密钥加密迁移到新密钥加密。
// 用法：node scripts/reencrypt-model-keys.mjs
// 幂等：已是新密钥加密的行会自动跳过。
import crypto from 'crypto';
import postgres from 'postgres';
import { readFileSync } from 'fs';

// 从 .env.local 读取配置（避免依赖 dotenv）
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
function env(name) {
  const m = envText.match(new RegExp('^' + name + '=(.*)$', 'm'));
  return m ? m[1].trim() : undefined;
}

const NEW_SECRET = process.env.APP_SECRET || env('APP_SECRET');
const OLD_SECRET = process.env.OLD_APP_SECRET || 'change-me-to-a-long-random-string';
const url = process.env.DATABASE_URL || env('DATABASE_URL') || 'postgres://postgres:postgres@localhost:5432/ai_agent_platform';

function keyOf(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}
function decryptWith(b64, key) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
function encryptWith(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

const oldKey = keyOf(OLD_SECRET);
const newKey = keyOf(NEW_SECRET);

const sql = postgres(url);
try {
  const rows = await sql`select id, name, api_key from models`;
  let migrated = 0, alreadyNew = 0, empty = 0, failed = [];
  for (const r of rows) {
    const raw = r.api_key;
    if (!raw || raw.length === 0) { empty++; continue; }
    try {
      // 先按新密钥解；成功则说明已迁移
      decryptWith(raw, newKey);
      alreadyNew++;
    } catch {
      try {
        const plain = decryptWith(raw, oldKey);
        await sql`update models set api_key = ${encryptWith(plain, newKey)} where id = ${r.id}`;
        migrated++;
      } catch (e) {
        failed.push({ id: r.id, name: r.name, err: String(e.message || e) });
      }
    }
  }
  console.log(JSON.stringify({ total: rows.length, migrated, alreadyNew, empty, failed }, null, 2));
} finally {
  await sql.end();
}
