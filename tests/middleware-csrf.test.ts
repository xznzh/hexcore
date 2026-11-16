import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

// 直接对边缘中间件做行为验证（不需要起服务）：
// - 状态变更请求的 CSRF 拦截/放行边界
// - 页面路由原有的「未登录跳登录页」逻辑不能被破坏
const BASE = 'http://localhost:3111';

function mk(method: string, path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(BASE + path), { method, headers });
}

describe('middleware CSRF 校验', () => {
  it('跨站 POST（Sec-Fetch-Site: cross-site）返回 403', () => {
    const r = middleware(mk('POST', '/api/chat', { 'sec-fetch-site': 'cross-site' }));
    expect(r.status).toBe(403);
  });

  it('同站子域（same-site）也拦住', () => {
    const r = middleware(mk('POST', '/api/chat', { 'sec-fetch-site': 'same-site' }));
    expect(r.status).toBe(403);
  });

  it('同源 POST 放行', () => {
    const r = middleware(mk('POST', '/api/chat', { 'sec-fetch-site': 'same-origin' }));
    expect(r.status).toBe(200);
  });

  it('浏览器直接访问（Sec-Fetch-Site: none）放行', () => {
    const r = middleware(mk('POST', '/api/chat', { 'sec-fetch-site': 'none' }));
    expect(r.status).toBe(200);
  });

  it('无 Sec-Fetch-Site 时回退到 Origin / Host 比对', () => {
    expect(middleware(mk('DELETE', '/api/schedules?id=x', { origin: 'https://evil.example.com', host: 'localhost:3111' })).status).toBe(403);
    expect(middleware(mk('DELETE', '/api/schedules?id=x', { origin: BASE, host: 'localhost:3111' })).status).toBe(200);
  });

  it('完全没有 Origin 的服务端调用（curl / 服务互调）放行', () => {
    const r = middleware(mk('POST', '/api/chat'));
    expect(r.status).toBe(200);
  });

  it('GET / HEAD 不受 CSRF 影响', () => {
    expect(middleware(mk('GET', '/api/logs', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
    expect(middleware(mk('HEAD', '/api/models', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
  });
});

describe('middleware 页面鉴权（原有行为未破坏）', () => {
  it('未登录访问页面 → 307 跳登录页', () => {
    const r = middleware(mk('GET', '/work'));
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toContain('/login');
  });

  it('登录页本身不跳转', () => {
    expect(middleware(mk('GET', '/login')).status).toBe(200);
  });

  it('分享页公开可访问', () => {
    expect(middleware(mk('GET', '/share/abc123')).status).toBe(200);
  });
});
