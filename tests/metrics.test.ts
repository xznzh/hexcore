import { beforeEach, describe, expect, it } from 'vitest';
import { clearMetric, incCounter, observeMs, renderMetrics, resetMetrics, setGauge } from '@/lib/metrics';

/**
 * 指标导出的正确性。
 *
 * 这类代码的失败方式很安静：标签少引号、直方图忘了累加、`+Inf` 桶漏写，
 * Prometheus 都不会报错——它只是**收不到数据**，或者算出来的分位数是错的。
 * 所以这里逐条断言文本形状，而不是只断言「render 返回了非空字符串」。
 */
describe('lib/metrics', () => {
  beforeEach(() => resetMetrics());

  it('计数器累加并渲染成标准文本格式', () => {
    incCounter('hexcore_test_total', '测试计数', { route: '/api/chat' });
    incCounter('hexcore_test_total', '测试计数', { route: '/api/chat' }, 2);
    const out = renderMetrics();
    expect(out).toContain('# HELP hexcore_test_total 测试计数');
    expect(out).toContain('# TYPE hexcore_test_total counter');
    expect(out).toContain('hexcore_test_total{route="/api/chat"} 3');
  });

  it('仪表是覆盖而不是累加', () => {
    setGauge('hexcore_gauge', '测试仪表', 5);
    setGauge('hexcore_gauge', '测试仪表', 2);
    expect(renderMetrics()).toContain('hexcore_gauge 2');
    expect(renderMetrics()).not.toContain('hexcore_gauge 7');
  });

  it('标签值里的引号与换行被转义（否则整段文本解析失败）', () => {
    incCounter('hexcore_escape_total', '转义测试', { label: 'a"b\nc' });
    expect(renderMetrics()).toContain('label="a\\"b\\nc"');
  });

  it('直方图输出累积分桶 + _sum + _count，超最大桶只进 +Inf', () => {
    const buckets = [100, 500];
    observeMs('hexcore_lat_ms', '耗时', 50, { route: '/x' }, buckets);
    observeMs('hexcore_lat_ms', '耗时', 300, { route: '/x' }, buckets);
    observeMs('hexcore_lat_ms', '耗时', 9_000, { route: '/x' }, buckets);

    const out = renderMetrics();
    expect(out).toContain('hexcore_lat_ms_bucket{le="100",route="/x"} 1');
    expect(out).toContain('hexcore_lat_ms_bucket{le="500",route="/x"} 2'); // 累积
    expect(out).toContain('hexcore_lat_ms_bucket{le="+Inf",route="/x"} 3');
    expect(out).toContain('hexcore_lat_ms_sum{route="/x"} 9350');
    expect(out).toContain('hexcore_lat_ms_count{route="/x"} 3');
  });

  it('负数与 NaN 被忽略（指标不该出现负的耗时）', () => {
    observeMs('hexcore_bad_ms', '耗时', -5);
    observeMs('hexcore_bad_ms', '耗时', Number.NaN);
    expect(renderMetrics()).toBe('');
  });

  it('标签基数封顶：超出后收敛到 overflow，不无限增长', () => {
    for (let i = 0; i < 260; i++) incCounter('hexcore_many_total', '基数测试', { route: `/r${i}` });
    const out = renderMetrics();
    const series = out.split('\n').filter((l) => l.startsWith('hexcore_many_total{'));
    // 200 个正常序列 + 1 个 overflow 桶
    expect(series.length).toBeLessThanOrEqual(201);
    expect(out).toContain('overflow="true"');
  });

  it('清空单条指标后不再出现在输出里（抓取侧重算的 gauge 靠它避免僵尸序列）', () => {
    setGauge('hexcore_temp', '临时', 1, { k: 'a' });
    clearMetric('hexcore_temp');
    expect(renderMetrics()).not.toContain('hexcore_temp');
  });
});
