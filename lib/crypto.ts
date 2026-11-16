import crypto from 'crypto';

const SECRET = process.env.APP_SECRET || 'dev-insecure-secret-change-me';
// 由密钥派生出 32 字节 AES 密钥
const KEY = crypto.createHash('sha256').update(SECRET).digest();

export function encryptText(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptText(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/**
 * 安全解密：密文损坏、APP_SECRET 变更、或库里存的是「空字符串的密文」时统一返回 ''。
 * 注意 encryptText('') 也是非空密文，所以「有没有配 Key」必须解密后判断，不能看密文长度。
 */
export function safeDecrypt(b64: string | null | undefined): string {
  if (!b64) return '';
  try {
    return decryptText(b64);
  } catch {
    return '';
  }
}

/** 是否真的配置了 Key（解密后非空） */
export function hasApiKey(b64: string | null | undefined): boolean {
  return safeDecrypt(b64).trim().length > 0;
}

/**
 * 加密一份 JSON 配置（连接器 config 等含第三方密钥的结构）后落库。
 * 存的是密文 base64 —— 它既不是合法 JSON，也不含任何明文密钥，DB 备份/只读账号泄漏时不会直接暴露凭据。
 */
export function encryptJson(value: unknown): string {
  return encryptText(JSON.stringify(value ?? {}));
}

/**
 * 解析一份「可能已加密」的配置，兼容三种历史/运行时状态：
 * 1. 密文（V6.5 之后写入）→ 解密再 JSON.parse；
 * 2. 明文 JSON（V6.5 之前的存量行）→ 直接 JSON.parse；
 * 3. 脏数据 / APP_SECRET 变更导致解密失败 → 返回 {}（与原 try/catch 兜底行为一致）。
 * 这样老库无需数据迁移即可平滑升级，且下次写回时自动变成密文。
 */
export function decryptJson<T = any>(stored: string | null | undefined): T {
  if (!stored) return {} as T;
  try {
    return JSON.parse(stored) as T;
  } catch {
    /* 不是明文 JSON，继续按密文处理 */
  }
  try {
    return JSON.parse(decryptText(stored)) as T;
  } catch {
    return {} as T;
  }
}
