import { describe, expect, it } from 'vitest';
import { encryptText, decryptText, safeDecrypt, hasApiKey, encryptJson, decryptJson } from '@/lib/crypto';

// 验证 API Key 加解密回环（AES-256-GCM）；模块加载时绑定密钥，测试保持自洽
describe('lib/crypto 模型 Key 加密存储', () => {
  it('加解密回环一致', () => {
    const plain = 'sk-test-1234567890abcdef';
    const enc = encryptText(plain);
    expect(enc).not.toContain(plain);
    expect(decryptText(enc)).toBe(plain);
  });

  it('相同明文两次加密密文不同（随机 IV）', () => {
    const a = encryptText('hello');
    const b = encryptText('hello');
    expect(a).not.toEqual(b);
    expect(decryptText(a)).toBe('hello');
    expect(decryptText(b)).toBe('hello');
  });

  it('空 Key 的密文非空，但 hasApiKey 必须判为未配置', () => {
    const enc = encryptText('');
    expect(enc.length).toBeGreaterThan(0); // 只看密文长度会误判
    expect(safeDecrypt(enc)).toBe('');
    expect(hasApiKey(enc)).toBe(false);
  });

  it('密文损坏 / 密钥不匹配时安全解密返回空串而不是抛错', () => {
    expect(safeDecrypt('not-a-valid-ciphertext')).toBe('');
    expect(safeDecrypt('')).toBe('');
    expect(safeDecrypt(null)).toBe('');
    expect(hasApiKey('not-a-valid-ciphertext')).toBe(false);
  });
});

// 连接器 config 加密：库里不能出现明文密钥，且必须能平滑兼容 V6.5 之前的明文存量行
describe('lib/crypto 连接器配置加密存储', () => {
  const cfg = {
    url: 'https://api.example.com/quotes?code={{input}}',
    headers: { Authorization: 'Bearer super-secret-token' },
  };

  it('密文不包含明文密钥，也无法被当成 JSON 直接读出', () => {
    const enc = encryptJson(cfg);
    expect(enc).not.toContain('Bearer super-secret-token');
    expect(enc).not.toContain('api.example.com');
    expect(() => JSON.parse(enc)).toThrow();
    expect(decryptJson(enc)).toEqual(cfg);
  });

  it('兼容历史明文行（未加密的老数据直接是 JSON 文本）', () => {
    expect(decryptJson(JSON.stringify(cfg))).toEqual(cfg);
  });

  it('脏数据 / 空值一律返回空对象，不抛错', () => {
    expect(decryptJson('not-json-not-cipher')).toEqual({});
    expect(decryptJson('')).toEqual({});
    expect(decryptJson(null)).toEqual({});
    expect(decryptJson(undefined)).toEqual({});
  });
});
