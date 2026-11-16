import { describe, it, expect, afterEach } from 'vitest';
import {
  assertBusinessSuccess,
  registerBusinessRule,
  unregisterBusinessRule,
  clearBusinessRules,
} from '../lib/tools/business-success';

afterEach(() => clearBusinessRules());

describe('business-success · 内置规则（迁移前后行为一致）', () => {
  it('DemoAPI 成功码 0 不判失败', () => {
    expect(assertBusinessSuccess('{"demoapi_res_code":0,"demoapi_res_body":{"v":1}}')).toBeNull();
  });

  it('DemoAPI 缺少 appKey 时给出配置提示', () => {
    const err = assertBusinessSuccess('{"demoapi_res_code":-1002,"demoapi_res_error":"appKey err"}');
    expect(err).toContain('demoapi_res_code=-1002');
    expect(err).toContain('缺少 appKey');
  });

  it('Open-Meteo 的 status=error 判失败，城市名错误给拼音提示', () => {
    const err = assertBusinessSuccess('{"status":"error","data":"Unknown station"}');
    expect(err).toContain('Open-Meteo status=error');
    expect(err).toContain('拼音');
  });

  it('业务成功（status=ok）不判失败', () => {
    expect(assertBusinessSuccess('{"status":"ok","data":{"ehi":42}}')).toBeNull();
  });
});

describe('business-success · 不该误判的输入', () => {
  it('非 JSON（纯文本/CSV/HTML）一律放过', () => {
    expect(assertBusinessSuccess('a,b,c\n1,2,3')).toBeNull();
    expect(assertBusinessSuccess('<html>502 Bad Gateway</html>')).toBeNull();
    expect(assertBusinessSuccess('')).toBeNull();
  });

  it('数组响应放过（规则只面向对象包裹）', () => {
    expect(assertBusinessSuccess('[{"status":"error","data":"x"}]')).toBeNull();
  });

  it('没有明确错误字段的普通业务 code 不误伤', () => {
    expect(assertBusinessSuccess('{"code":200,"msg":"ok","data":[]}')).toBeNull();
    expect(assertBusinessSuccess('{"code":"ERR_BUSINESS","data":null}')).toBeNull();
  });
});

describe('business-success · 自定义规则', () => {
  it('注册后对新网关生效', () => {
    registerBusinessRule({
      name: 'my-gw',
      check: (body) => (body.errCode && body.errCode !== 0 ? `网关错误：${body.errMsg || body.errCode}` : null),
    });
    expect(assertBusinessSuccess('{"errCode":10001,"errMsg":"签名错误"}')).toContain('签名错误');
    expect(assertBusinessSuccess('{"errCode":0}')).toBeNull();
  });

  it('可按连接器收窄，不影响其他连接器', () => {
    registerBusinessRule({
      name: 'only-c1',
      connectorId: 'c1',
      check: (body) => (body.ok === false ? 'c1 专属失败' : null),
    });
    expect(assertBusinessSuccess('{"ok":false}', { connectorId: 'c1' })).toBe('c1 专属失败');
    expect(assertBusinessSuccess('{"ok":false}', { connectorId: 'c2' })).toBeNull();
  });

  it('可按 URL 收窄', () => {
    registerBusinessRule({
      name: 'only-api',
      urlPattern: /api\.example\.com/,
      check: (body) => (body.error ? String(body.error) : null),
    });
    expect(assertBusinessSuccess('{"error":"boom"}', { url: 'https://api.example.com/x' })).toBe('boom');
    expect(assertBusinessSuccess('{"error":"boom"}', { url: 'https://other.com/x' })).toBeNull();
  });

  it('写得有 bug 的规则不会让整个调用抛错', () => {
    registerBusinessRule({
      name: 'broken',
      check: () => {
        throw new Error('rule bug');
      },
    });
    expect(assertBusinessSuccess('{"a":1}')).toBeNull();
  });

  it('同名注册覆盖旧规则；注销后不再生效', () => {
    registerBusinessRule({ name: 'x', check: () => 'v1' });
    expect(assertBusinessSuccess('{"a":1}')).toBe('v1');
    registerBusinessRule({ name: 'x', check: () => 'v2' });
    expect(assertBusinessSuccess('{"a":1}')).toBe('v2');
    unregisterBusinessRule('x');
    expect(assertBusinessSuccess('{"a":1}')).toBeNull();
  });
});
