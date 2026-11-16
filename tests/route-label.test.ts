import { describe, expect, it } from 'vitest';
import { routeLabel } from '@/lib/api/route-label';

/**
 * 指标标签里的路由归一化。
 *
 * 这函数只有一条职责：把「会无限增长的路径」压成「有限个路由」。
 * 它写错的后果不是报错，而是指标条数随用户使用慢慢涨到抓取端扛不住——
 * 等到发现时历史数据已经断了，所以用测试把边界钉死。
 */
describe('lib/api/route-label', () => {
  it('内部 id 段收敛成 :id', () => {
    expect(routeLabel('/api/conversations/conv_9f2a1b3c')).toBe('/api/conversations/:id');
    expect(routeLabel('/api/skills/run_abc123def456')).toBe('/api/skills/:id');
  });

  it('纯数字与 uuid 也收敛', () => {
    expect(routeLabel('/api/skills/123')).toBe('/api/skills/:id');
    expect(routeLabel('/api/files/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/api/files/:id');
    expect(routeLabel('/api/files/9f86d081884c7d659a2feaa0c55ad015')).toBe('/api/files/:id');
  });

  it('正常业务词原样保留（不能把静态路由也吞掉）', () => {
    expect(routeLabel('/api/admin/cost')).toBe('/api/admin/cost');
    expect(routeLabel('/api/health')).toBe('/api/health');
    expect(routeLabel('/api/models')).toBe('/api/models');
    // 短词 + 下划线但不是 id：`run_all`（动作名）不该被吞
    expect(routeLabel('/api/skills/run_all')).toBe('/api/skills/run_all');
  });

  it('末尾带动作的嵌套路由只收敛 id 段', () => {
    expect(routeLabel('/api/connectors/conv_abcdef/revoke')).toBe('/api/connectors/:id/revoke');
  });

  it('空路径退化成 /（避免出现空标签值）', () => {
    expect(routeLabel('')).toBe('/');
  });
});
