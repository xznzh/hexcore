import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/metrics/route';

/**
 * `/api/metrics` 的契约。
 *
 * 这个端点最危险的失败方式不是 500，而是**看起来很正常的 200**：
 * 没有鉴权（内网暴露实例指标）、或者被中间层缓存（多副本抓回来是同一份数据，
 * 面板上「三个 Pod 负载一模一样」，排查时会把方向带偏）。所以这里断言的是
 * 鉴权分支与缓存头，而不是「能不能输出指标文本」——后者在 lib/metrics 的单测里。
 */
describe('GET /api/metrics', () => {
  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  it('未配置 METRICS_TOKEN 时默认开放（自托管开箱即可被抓取）', async () => {
    const res = await GET(new Request('http://127.0.0.1/api/metrics'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    // 至少要吐出 Prometheus 的元信息行，否则抓取端会认为「这个 target 没有指标」
    expect(text).toContain('# TYPE');
    expect(text).toContain('hexcore_build_info');
  });

  it('配置令牌后必须带正确的 Bearer，错误令牌与缺失令牌都 401', async () => {
    process.env.METRICS_TOKEN = 's3cret-token';
    const url = 'http://127.0.0.1/api/metrics';

    expect((await GET(new Request(url))).status).toBe(401);
    expect((await GET(new Request(url, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
    // 大小写不敏感（不同抓取端写法不一），值必须完全一致
    expect((await GET(new Request(url, { headers: { authorization: 'bearer s3cret-token' } }))).status).toBe(200);
  });

  it('禁止缓存：缓存住会让所有副本看起来是同一份数据', async () => {
    const res = await GET(new Request('http://127.0.0.1/api/metrics'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('不泄露用户维度信息（指标是聚合值，不能追溯到个人）', async () => {
    const text = await (await GET(new Request('http://127.0.0.1/api/metrics'))).text();
    // 邮箱 / 密码 / 连接串这类字段一个都不该出现
    expect(text).not.toMatch(/@|password|postgres:\/\//i);
  });
});
