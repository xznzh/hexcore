'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import TrendChart from '@/components/TrendChart';
import { App, Button, Card, Empty, Skeleton, Space, Table, Tag, Tooltip } from 'antd';
import { BarChartOutlined, DownloadOutlined, ReloadOutlined, RiseOutlined, FallOutlined } from '@ant-design/icons';

type Member = { userId: string; name: string; email: string; used: number; limit: number };
type Overview = {
  scope: 'team' | 'self';
  period: string;
  periods: string[];
  trend: number[];
  used: number;
  limit: number;
  percent: number;
  mom: number | null;
  prev: number;
  members: Member[];
};
type Trend = {
  days: number;
  series: { date: string; tokens: number; cost: number }[];
  total: number;
  totalCost: number;
  cache?: { hit: number; miss: number; rate: number };
};

const fmt = (n: number) => (n || 0).toLocaleString('zh-CN');

/** 紧凑数字：12.3k / 1.2M，用于趋势峰值这类空间有限的位置 */
function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 使用率配色：与工作台额度条同一套阈值语义 */
function meterColor(pct: number) {
  if (pct > 80) return 'var(--danger)';
  if (pct > 60) return 'var(--warning)';
  return 'var(--accent)';
}

export default function UsagePage() {
  const { message } = App.useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/usage/overview').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/usage/trend?days=30').then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([ov, tr]) => {
        if (!ov || ov.error) {
          message.error(ov?.error || '加载用量数据失败');
          return;
        }
        setData(ov);
        // 趋势接口失败不影响主看板，单独降级
        if (tr && !tr.error) setTrend(tr);
      })
      .catch(() => message.error('加载用量数据失败'))
      .finally(() => setLoading(false));
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="page">
        <PageHeader title={<><BarChartOutlined /> 用量看板</>} desc="近 6 个月的 token 消耗趋势与额度占用。" />
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <PageHeader title={<><BarChartOutlined /> 用量看板</>} desc="近 6 个月的 token 消耗趋势与额度占用。" />
        <Card>
          <Empty description="暂无用量数据" />
        </Card>
      </div>
    );
  }

  const peak = Math.max(...data.trend, 0);
  const momUp = (data.mom ?? 0) >= 0;
  const dayPeak = trend ? Math.max(...trend.series.map((d) => d.tokens), 0) : 0;

  const memberColumns = [
    {
      title: '成员',
      dataIndex: 'name',
      key: 'name',
      render: (_: unknown, r: Member) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.name}</div>
          <div className="cell-sub">{r.email}</div>
        </div>
      ),
    },
    {
      title: '本月用量',
      dataIndex: 'used',
      key: 'used',
      align: 'right' as const,
      sorter: (a: Member, b: Member) => a.used - b.used,
      render: (n: number) => <span className="usage-num">{fmt(n)}</span>,
    },
    {
      title: '月度额度',
      dataIndex: 'limit',
      key: 'limit',
      align: 'right' as const,
      render: (n: number) =>
        n > 0 ? <span className="usage-num">{fmt(n)}</span> : <span style={{ color: 'var(--muted)' }}>不限</span>,
    },
    {
      title: '使用率',
      key: 'percent',
      width: 220,
      render: (_: unknown, r: Member) => {
        const pct = r.limit > 0 ? Math.min(100, Math.round((r.used / r.limit) * 100)) : 0;
        return (
          <div className="usage-meter-cell">
            <div className="meter">
              <i style={{ width: `${pct}%`, background: meterColor(pct) }} />
            </div>
            <span className="usage-meter-num">{r.limit > 0 ? `${pct}%` : '—'}</span>
          </div>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_: unknown, r: Member) => {
        const pct = r.limit > 0 ? (r.used / r.limit) * 100 : 0;
        if (pct > 90) return <Tag color="red">接近上限</Tag>;
        if (pct > 70) return <Tag color="gold">偏高</Tag>;
        return <Tag color="green">正常</Tag>;
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={<><BarChartOutlined /> 用量看板</>}
        desc={
          data.scope === 'team'
            ? '全团队 token 消耗趋势、额度占用与成员明细（管理员视图）。'
            : '你的 token 消耗趋势与额度占用。'
        }
        extra={
          <Space>
            <Tooltip title="重新拉取最新数据">
              <Button icon={<ReloadOutlined />} aria-label="刷新用量数据" onClick={load} loading={loading} />
            </Tooltip>
            {/* 复用服务端导出：管理员得全员、成员只得自己，与 /api/usage 口径一致 */}
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => window.open('/api/usage/export', '_blank')}>
              导出 CSV
            </Button>
          </Space>
        }
      />

      {/* 顶部四个指标 */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">{data.period} 消耗</div>
          <div className="stat-value accent">{fmt(data.used)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">月度额度</div>
          <div className="stat-value">{data.limit > 0 ? fmt(data.limit) : '不限'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">额度使用率</div>
          <div className="stat-value">{data.limit > 0 ? `${data.percent}%` : '—'}</div>
          <div className="meter" style={{ marginTop: 10 }}>
            <i style={{ width: `${data.percent}%`, background: meterColor(data.percent) }} />
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">环比上月</div>
          <div
            className="stat-value"
            style={{ color: data.mom === null ? 'var(--muted)' : momUp ? 'var(--danger)' : 'var(--success)' }}
          >
            {data.mom === null ? (
              '—'
            ) : (
              <span className="usage-mom">
                {momUp ? <RiseOutlined /> : <FallOutlined />}
                {Math.abs(data.mom)}%
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 月度额度趋势 */}
      <Card
        title="近 6 个月 token 消耗"
        extra={<span className="usage-peak">峰值 {compact(peak)} / 月</span>}
        style={{ marginBottom: 16 }}
      >
        {peak === 0 ? (
          <Empty description="近 6 个月暂无消耗记录" />
        ) : (
          <div className="usage-chart">
            <TrendChart data={data.trend} width={760} height={150} dots ariaLabel="近 6 个月 token 消耗趋势" />
            <div className="usage-chart-labels">
              {data.periods.map((p, i) => (
                <span key={p} className={i === data.periods.length - 1 ? 'current' : undefined}>
                  {p.slice(2)}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* 近 30 天消耗与花费（复用 /api/usage/trend，与管理后台同一口径） */}
      {trend && (
        <Card
          title={`近 ${trend.days} 天消耗与估算花费`}
          extra={
            <span className="usage-peak">
              合计 {fmt(trend.total)} tokens · 估算花费 {trend.totalCost}
              {trend.cache && trend.cache.hit + trend.cache.miss > 0 ? ` · 缓存命中 ${trend.cache.rate}%` : ''}
            </span>
          }
          style={{ marginBottom: 16 }}
        >
          {dayPeak === 0 ? (
            <Empty description={`近 ${trend.days} 天暂无消耗记录`} />
          ) : (
            <div className="usage-chart">
              <TrendChart
                data={trend.series.map((d) => d.tokens)}
                width={760}
                height={120}
                color="var(--accent-2)"
                ariaLabel={`近 ${trend.days} 天 token 消耗`}
              />
              <div className="usage-chart-labels">
                <span>{trend.series[0]?.date}</span>
                <span>{trend.series[trend.series.length - 1]?.date}</span>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* 成员明细（仅管理员） */}
      {data.scope === 'team' && (
        <Card title="成员用量明细" extra={<span className="usage-peak">共 {data.members.length} 人</span>}>
          <Table
            rowKey="userId"
            size="middle"
            dataSource={data.members}
            columns={memberColumns}
            pagination={data.members.length > 10 ? { pageSize: 10, hideOnSinglePage: true } : false}
            locale={{ emptyText: '暂无成员' }}
          />
        </Card>
      )}
    </div>
  );
}
