import { describe, expect, it } from 'vitest';
import { checkUrlLiteral, isBlockedIp, isPlaceholderHost } from '@/lib/ssrf';

/**
 * SSRF 防护的重点不是「能拦」，而是「只拦内网、不误伤公网」，且必须默认生效。
 * 这里锁三类边界：典型内网/元数据地址必须拒、公网必须放、显式白名单必须放。
 */
describe('lib/ssrf 地址校验', () => {
  describe('isBlockedIp', () => {
    it('拒绝环回 / 私网 / 链路本地（含云元数据）/ CGNAT', () => {
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
        expect(isBlockedIp(ip), ip).toBe(true);
      }
    });

    it('拒绝 IPv6 环回 / 链路本地 / ULA / 组播，以及 IPv4 映射地址', () => {
      for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1']) {
        expect(isBlockedIp(ip), ip).toBe(true);
      }
    });

    it('公网地址放行', () => {
      for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.9', '2606:4700:4700::1111']) {
        expect(isBlockedIp(ip), ip).toBe(false);
      }
    });

    it('非法输入 fail-closed（当作不安全）', () => {
      expect(isBlockedIp('not-an-ip')).toBe(true);
      expect(isBlockedIp('')).toBe(true);
    });
  });

  describe('checkUrlLiteral', () => {
    const strict = { allowPrivate: false };

    it('拒绝云元数据地址（这是 SSRF 最危险的目标）', () => {
      const r = checkUrlLiteral('http://169.254.169.254/latest/meta-data/', strict);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/内网|保留/);
    });

    it('拒绝 localhost 与内网 IP', () => {
      expect(checkUrlLiteral('http://localhost:3000/api', strict).ok).toBe(false);
      expect(checkUrlLiteral('http://10.0.0.5:8080/admin', strict).ok).toBe(false);
      expect(checkUrlLiteral('http://[::1]:8080/', strict).ok).toBe(false);
    });

    it('拒绝非 http(s) 协议与内嵌凭据', () => {
      expect(checkUrlLiteral('file:///etc/passwd', strict).ok).toBe(false);
      expect(checkUrlLiteral('gopher://example.com/', strict).ok).toBe(false);
      const cred = checkUrlLiteral('https://user:pass@example.com/api', strict);
      expect(cred.ok).toBe(false);
      expect(cred.reason).toMatch(/账号密码/);
    });

    it('放行正常公网地址', () => {
      expect(checkUrlLiteral('https://api.open-meteo.com/v1/forecast?latitude=30.59', strict).ok).toBe(true);
      expect(checkUrlLiteral('http://example.com:8080/path', strict).ok).toBe(true);
    });

    it('显式白名单可放行本地服务（本地自建 MCP / 内网接口的合法场景）', () => {
      const r = checkUrlLiteral('http://localhost:7801/mcp', { allowPrivate: false, allowHosts: ['localhost'] });
      expect(r.ok).toBe(true);
    });

    it('拒绝格式不合法的 URL', () => {
      expect(checkUrlLiteral('not a url', strict).ok).toBe(false);
      expect(checkUrlLiteral('', strict).ok).toBe(false);
    });
  });

  describe('isPlaceholderHost', () => {
    it('识别文档占位域名（含任意子域）', () => {
      expect(isPlaceholderHost('example.com')).toBe(true);
      expect(isPlaceholderHost('mcp.example.com')).toBe(true);
      expect(isPlaceholderHost('api.example.org')).toBe(true);
      expect(isPlaceholderHost('your-domain.com')).toBe(true);
      expect(isPlaceholderHost('MCP.EXAMPLE.COM')).toBe(true);
    });

    it('真实域名不误判', () => {
      expect(isPlaceholderHost('mcp.deepwiki.com')).toBe(false);
      expect(isPlaceholderHost('api.open-meteo.com')).toBe(false);
      // 只是以 example 结尾但不是 .example.com 家族
      expect(isPlaceholderHost('myexample.com')).toBe(false);
    });
  });
});
