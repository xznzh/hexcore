'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { useMe } from '@/components/SessionContext';
import { cachedJson, getCache } from '@/lib/clientCache';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Dropdown,
} from 'antd';
import {
  ThunderboltOutlined,
  ReloadOutlined,
  EditOutlined,
  TeamOutlined,
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  RedoOutlined,
  MoreOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { safeValidate } from '@/lib/form';

const { Text, Paragraph } = Typography;

type Cap = {
  id: string;
  connectorId: string | null;
  connectorName: string | null;
  connectorStatus: string | null;
  key: string;
  name: string;
  description: string | null;
  method: string;
  path: string;
  inputSchema: string;
  responseMapping?: string;
  minRole: string;
  requiresApproval: boolean;
  timeoutMs: number;
  status: string;
};

type Op = {
  id: string;
  capabilityId: string | null;
  capabilityName: string | null;
  userId: string;
  userName: string | null;
  status: string;
  mode?: string;
  input: string | null;
  output: string | null;
  error: string | null;
  source: string;
  durationMs: number | null;
  createdAt: number;
  finishedAt: number | null;
};

type Metrics = {
  days: number;
  total: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  avgDurationMs: number | null;
  pendingApprovals: number;
  daily: { date: string; total: number; failed: number }[];
  topCapabilities: { name: string; total: number; failed: number; avgMs: number }[];
};

type Grant = { id: string; subjectType: string; subjectId: string; subjectLabel?: string };

const STATUS_COLOR: Record<string, string> = {
  succeeded: 'green',
  failed: 'red',
  running: 'blue',
  pending_approval: 'orange',
  approved: 'cyan',
  cancelled: 'default',
};

const STATUS_LABEL: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  running: '执行中',
  pending_approval: '待审批',
  approved: '已批准',
  cancelled: '已取消',
};

const statusLabel = (v: string) => STATUS_LABEL[v] || v;

const OPS_PAGE_SIZE = 10;

type ResultTone = 'success' | 'error' | 'info';

/** 统一结果展示：等宽字体 + 主题底色 + 左侧语义描边，深色主题下也不会浅底浅字 */
function ResultBlock({ text, tone = 'info', maxHeight = 340 }: { text: string; tone?: ResultTone; maxHeight?: number }) {
  return (
    <pre className={`result-block is-${tone}`} style={maxHeight ? { maxHeight } : undefined}>
      {text || '—'}
    </pre>
  );
}

/** 每日调用量迷你柱图：主色为总量，语义色叠加失败数；不引入图表库 */
function TrendBars({ data }: { data: { date: string; total: number; failed: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, padding: '4px 0' }}>
      {data.map((d) => {
        const h = Math.round((d.total / max) * 100);
        const failPct = d.total ? Math.round((d.failed / d.total) * 100) : 0;
        return (
          <Tooltip key={d.date} title={`${d.date}：${d.total} 次${d.failed ? `，失败 ${d.failed}` : ''}`}>
            <div style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
              <div
                className="trend-bar"
                style={{
                  width: '100%',
                  height: `${h}%`,
                  minHeight: d.total ? 3 : 0,
                  borderRadius: 2,
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {d.failed > 0 && (
                  <div
                    className="trend-bar-fail"
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: `${failPct}%`,
                    }}
                  />
                )}
              </div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}


function sampleInput(cap: Cap): string {
  let schema: any = {};
  try {
    schema = JSON.parse(cap.inputSchema || '{}');
  } catch {
    schema = {};
  }
  const obj: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema.properties || {}) as [string, any][]) {
    if (v?.enum?.length) obj[k] = v.enum[0];
    else if (v?.type === 'number' || v?.type === 'integer') obj[k] = 0;
    else if (v?.type === 'boolean') obj[k] = false;
    else if (v?.type === 'array') obj[k] = [];
    else obj[k] = '';
  }
  return JSON.stringify(obj, null, 2);
}

/** 提取 inputSchema 的字段说明，用于调用前提示必填项 */
function schemaFields(cap: Cap): { name: string; type: string; required: boolean; description: string }[] {
  let schema: any = {};
  try {
    schema = JSON.parse(cap.inputSchema || '{}');
  } catch {
    schema = {};
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required.map(String) : [];
  return Object.entries(schema.properties || {}).map(([name, v]: [string, any]) => ({
    name,
    type: String(v?.type || 'any'),
    required: required.includes(name),
    description: String(v?.description || ''),
  }));
}

export default function CapabilitiesPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const me = useMe();
  const isAdmin = me?.role === 'admin';

  const [tab, setTab] = useState('catalog');
  const [caps, setCaps] = useState<Cap[]>([]);
  const [ops, setOps] = useState<Op[]>([]);
  const [approvals, setApprovals] = useState<Op[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);

  // 目录筛选 / 分页
  const [capQ, setCapQ] = useState('');
  const [capStatus, setCapStatus] = useState('all');
  const [capPage, setCapPage] = useState(1);
  // 调用记录筛选 / 分页
  const [opsStatus, setOpsStatus] = useState('');
  const [opsQ, setOpsQ] = useState('');
  const [opsPage, setOpsPage] = useState(1);
  const [opsTotal, setOpsTotal] = useState(0);
  // 指标时间范围
  const [metricsDays, setMetricsDays] = useState(30);

  // 调用
  const [invokeCap, setInvokeCap] = useState<Cap | null>(null);
  const [invokeInput, setInvokeInput] = useState('{}');
  const [invoking, setInvoking] = useState(false);
  const [invokeResult, setInvokeResult] = useState<string | null>(null);
  const [invokeAsync, setInvokeAsync] = useState(false);
  const [invokeFailed, setInvokeFailed] = useState(false);

  // 编辑
  const [editCap, setEditCap] = useState<Cap | null>(null);
  const [editForm] = Form.useForm();

  // 授权
  const [grantCap, setGrantCap] = useState<Cap | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [grantType, setGrantType] = useState<'user' | 'role'>('user');
  const [grantSubject, setGrantSubject] = useState('');
  const [users, setUsers] = useState<{ id: string; name: string; email: string }[]>([]);

  // 记录详情
  const [opDetail, setOpDetail] = useState<Op | null>(null);

  async function loadCaps() {
    const url = isAdmin ? '/api/capabilities?all=1' : '/api/capabilities';
    const c = getCache<Cap[]>(url);
    if (c) setCaps(c);
    const d = await cachedJson<Cap[]>(url);
    if (d) setCaps(d);
  }

  async function loadOps(opts: { page?: number; q?: string; status?: string } = {}) {
    const page = opts.page ?? opsPage;
    const q = opts.q ?? opsQ;
    const status = opts.status ?? opsStatus;
    const params = new URLSearchParams({
      limit: String(OPS_PAGE_SIZE),
      offset: String((page - 1) * OPS_PAGE_SIZE),
    });
    if (isAdmin) params.set('mine', '0');
    if (status) params.set('status', status);
    if (q.trim()) params.set('q', q.trim());

    const d = await fetch(`/api/capabilities/operations?${params}`).then((r) => r.json());
    if (d && Array.isArray(d.items)) {
      setOps(d.items);
      const total = Number(d.total) || 0;
      setOpsTotal(total);
      // 筛选/删除后当前页越界，回退到最后一页
      const lastPage = Math.max(1, Math.ceil(total / OPS_PAGE_SIZE));
      if (page > lastPage) {
        setOpsPage(lastPage);
        loadOps({ page: lastPage });
        return;
      }
    }

    if (isAdmin) {
      const a = await fetch('/api/capabilities/operations?status=pending_approval&mine=0&limit=100').then((r) => r.json());
      if (a && Array.isArray(a.items)) setApprovals(a.items);
    }
  }

  async function loadMetrics(days = metricsDays) {
    const d = await fetch(`/api/capabilities/metrics?days=${days}`).then((r) => r.json());
    if (d && !d.error) {
      setMetrics(d);
      setMetricsDays(Number(d.days) || days);
    }
  }

  async function reload() {
    setLoading(true);
    try {
      await Promise.all([loadCaps(), loadOps(), loadMetrics()]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 调用记录 / 待审批：页面可见时每 6 秒自动刷新（异步任务完成后无需手动刷新）
  useEffect(() => {
    if (tab !== 'ops' && tab !== 'approvals') return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      loadOps();
    }, 6000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isAdmin, opsPage, opsQ, opsStatus]);

  useEffect(() => {
    if (!grantCap) return;
    fetch(`/api/capabilities/grants?capabilityId=${grantCap.id}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setGrants(d))
      .catch(() => {});
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setUsers(d))
      .catch(() => {});
  }, [grantCap]);

  // 调用详情：运行中每 3 秒刷新，结束后同步列表
  useEffect(() => {
    if (!opDetail || !['running', 'pending_approval', 'approved'].includes(opDetail.status)) return;
    const id = opDetail.id;
    const timer = setInterval(async () => {
      const d = await fetch(`/api/capabilities/operations/${id}`)
        .then((r) => r.json())
        .catch(() => null);
      if (!d || d.error) return;
      setOpDetail((prev) => (prev && prev.id === id ? { ...prev, ...d } : prev));
      if (['succeeded', 'failed', 'cancelled'].includes(d.status)) loadOps();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opDetail?.id, opDetail?.status]);

  function openInvoke(cap: Cap) {
    setInvokeCap(cap);
    setInvokeInput(sampleInput(cap));
    setInvokeResult(null);
    setInvokeFailed(false);
    setInvokeAsync(false);
  }

  function formatJson() {
    try {
      const obj = invokeInput.trim() ? JSON.parse(invokeInput) : {};
      setInvokeInput(JSON.stringify(obj, null, 2));
      message.success('已格式化');
    } catch {
      message.error('参数不是合法 JSON，无法格式化');
    }
  }

  async function copyResult() {
    if (!invokeResult) return;
    // Clipboard API 只在 https / localhost 可用，局域网 http 访问时退回到 execCommand
    try {
      await navigator.clipboard.writeText(invokeResult);
      message.success('已复制');
      return;
    } catch {
      // fall through
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = invokeResult;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) message.success('已复制');
      else message.error('复制失败，请手动选择复制');
    } catch {
      message.error('复制失败，请手动选择复制');
    }
  }

  async function openOpDetail(id: string, fallback?: Op) {
    if (fallback) setOpDetail(fallback);
    const d = await fetch(`/api/capabilities/operations/${id}`)
      .then((r) => r.json())
      .catch(() => null);
    if (d && !d.error) setOpDetail((prev) => (prev && prev.id === id ? { ...prev, ...d } : d));
    else if (!fallback) message.error('加载详情失败');
  }

  async function doInvoke() {
    if (!invokeCap) return;
    let input: any;
    try {
      input = invokeInput.trim() ? JSON.parse(invokeInput) : {};
    } catch {
      return message.error('参数必须是合法 JSON');
    }
    setInvoking(true);
    setInvokeFailed(false);
    try {
      const r = await fetch('/api/capabilities/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: invokeCap.id, input, mode: invokeAsync ? 'async' : 'sync' }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 400) {
        const msg = j.error || '参数不合法';
        setInvokeFailed(true);
        setInvokeResult(`参数校验未通过：${msg}`);
        message.error(msg);
        return;
      }
      if (j.status === 'running') {
        message.info('已转后台执行');
        setInvokeResult(j.message || '已在后台执行');
        pollOperation(j.operationId);
      } else if (j.status === 'pending_approval') {
        message.info(j.message || '已提交审批');
        setInvokeResult(j.message || '已提交审批');
      } else if (j.status === 'failed') {
        setInvokeFailed(true);
        setInvokeResult(`调用失败（${j.durationMs}ms）：\n${j.error}`);
      } else if (j.status === 'succeeded') {
        setInvokeResult(`调用成功（${j.durationMs}ms）：\n${j.output}`);
      } else {
        setInvokeFailed(true);
        setInvokeResult(j.error || JSON.stringify(j, null, 2));
      }
      loadOps();
      loadMetrics();
    } catch (e: any) {
      setInvokeFailed(true);
      setInvokeResult(`调用异常：${String(e?.message || e)}`);
    } finally {
      setInvoking(false);
    }
  }

  /** 异步任务轮询：最多约 60 秒，超时提示去「调用记录」查看 */
  async function pollOperation(opId: string) {
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const d = await fetch(`/api/capabilities/operations/${opId}`)
        .then((r) => r.json())
        .catch(() => null);
      if (!d || d.error) return;
      if (d.status === 'succeeded') {
        setInvokeResult(`调用成功（${d.durationMs ?? 0}ms）：\n${d.output || ''}`);
        loadOps();
        loadMetrics();
        return;
      }
      if (d.status === 'failed' || d.status === 'cancelled') {
        setInvokeFailed(true);
        setInvokeResult(`调用${d.status === 'cancelled' ? '已取消' : '失败'}：\n${d.error || '—'}`);
        loadOps();
        loadMetrics();
        return;
      }
    }
    setInvokeResult('仍在后台执行，请稍后在「调用记录」查看结果。');
  }

  const filteredCaps = useMemo(() => {
    const q = capQ.trim().toLowerCase();
    return caps.filter((c) => {
      if (capStatus !== 'all' && c.status !== capStatus) return false;
      if (!q) return true;
      return [c.name, c.key, c.path, c.description || ''].some((x) => x.toLowerCase().includes(q));
    });
  }, [caps, capQ, capStatus]);

  function openEdit(cap: Cap) {
    // 弹窗内容用 initialValues 回填（配合 preserve={false}），避免 setFieldsValue 先于表单挂载的告警
    setEditCap(cap);
  }

  async function saveEdit() {
    if (!editCap) return;
    const v = await safeValidate(editForm);
    if (!v) return;
    let mapping: any = {};
    try {
      mapping = v.responseMapping ? JSON.parse(v.responseMapping) : {};
    } catch {
      return message.error('响应映射必须是合法 JSON');
    }
    const r = await fetch(`/api/capabilities/${editCap.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...v, responseMapping: mapping }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return message.error(j.error || '保存失败');
    message.success('已保存');
    setEditCap(null);
    loadCaps();
  }

  async function toggleStatus(cap: Cap, active: boolean) {
    const r = await fetch(`/api/capabilities/${cap.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: active ? 'active' : 'disabled' }),
    });
    if (r.ok) {
      message.success(active ? '已启用' : '已停用');
      loadCaps();
    } else message.error('操作失败');
  }

  async function decide(op: Op, approve: boolean) {
    const r = await fetch('/api/capabilities/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: op.id, approve }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return message.error(j.error || '处理失败');
    message.success(approve ? '已批准' : '已拒绝');
    reload();
  }

  async function addGrant() {
    if (!grantCap || !grantSubject) return message.warning('请选择授权对象');
    const r = await fetch('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilityId: grantCap.id, subjectType: grantType, subjectId: grantSubject }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return message.error(j.error || '授权失败');
    setGrantSubject('');
    const d = await fetch(`/api/capabilities/grants?capabilityId=${grantCap.id}`).then((x) => x.json());
    if (Array.isArray(d)) setGrants(d);
  }

  async function removeGrant(grantId: string) {
    await fetch(`/api/capabilities/grants?grantId=${grantId}`, { method: 'DELETE' });
    setGrants((g) => g.filter((x) => x.id !== grantId));
  }

  const capColumns = useMemo(
    () => [
      {
        title: '能力',
        key: 'name',
        render: (_: any, c: Cap) => (
          <div>
            <Text strong>{c.name}</Text>
            {c.description ? <div className="cell-sub" title={c.description}>{c.description}</div> : null}
          </div>
        ),
      },
      {
        title: '连接器',
        dataIndex: 'connectorName',
        key: 'connectorName',
        width: 124,
        ellipsis: true,
        render: (v: string | null) => v || <Text type="secondary">内置</Text>,
      },
      {
        title: '接口',
        key: 'endpoint',
        width: 176,
        render: (_: any, c: Cap) => (
          // 路径单行省略，避免长接口把整行撑成 3 行
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <Tag color="blue" style={{ flexShrink: 0, marginInlineEnd: 0 }}>{c.method}</Tag>
            <span
              title={c.path}
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-secondary)',
              }}
            >
              {c.path}
            </span>
          </div>
        ),
      },
      {
        title: '审批',
        dataIndex: 'requiresApproval',
        key: 'requiresApproval',
        width: 88,
        render: (v: boolean) => (v ? <Tag color="orange">需审批</Tag> : <Tag>直接调用</Tag>),
      },
      { title: '最低角色', dataIndex: 'minRole', key: 'minRole', width: 94, ellipsis: true },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 76,
        render: (v: string) => <Tag color={v === 'active' ? 'green' : v === 'revoked' ? 'red' : 'default'}>{v === 'active' ? '启用' : v === 'revoked' ? '已撤销' : '停用'}</Tag>,
      },
      {
        title: '操作',
        key: 'action',
        width: 100,
        align: 'right' as const,
        render: (_: any, c: Cap) => (
          <Space size={6} wrap={false}>
            <Button size="small" icon={<ThunderboltOutlined />} onClick={() => openInvoke(c)}>
              调用
            </Button>
            {isAdmin && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'config', icon: <EditOutlined />, label: '配置能力', onClick: () => openEdit(c) },
                    { key: 'grant', icon: <TeamOutlined />, label: '授权角色', onClick: () => setGrantCap(c) },
                    { type: 'divider' as const },
                    c.status === 'active'
                      ? { key: 'toggle', label: '停用能力', onClick: () => toggleStatus(c, false) }
                      : { key: 'toggle', label: '启用能力', onClick: () => toggleStatus(c, true) },
                  ],
                }}
              >
                <Button size="small" icon={<MoreOutlined />} aria-label="能力更多操作" />
              </Dropdown>
            )}
          </Space>
        ),
      },
    ],
    [isAdmin],
  );

  const opColumns = [
    {
      title: '能力',
      dataIndex: 'capabilityName',
      key: 'capabilityName',
      render: (v: string | null) => v || <Text type="secondary">（注册表工具）</Text>,
    },
    { title: '调用者', dataIndex: 'userName', key: 'userName', render: (v: string | null) => v || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Tag color={STATUS_COLOR[v] || 'default'}>{v}</Tag>,
    },
    { title: '来源', dataIndex: 'source', key: 'source' },
    {
      title: '模式',
      dataIndex: 'mode',
      key: 'mode',
      render: (v: string) => (v === 'async' ? <Tag color="blue">后台</Tag> : <Tag>同步</Tag>),
    },
    { title: '耗时', dataIndex: 'durationMs', key: 'durationMs', render: (v: number | null) => (v != null ? `${v}ms` : '—') },
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: number) => new Date(v).toLocaleString() },
    {
      title: '',
      key: 'action',
      render: (_: any, r: Op) => (
        <Button size="small" type="link" onClick={() => openOpDetail(r.id, r)}>
          详情
        </Button>
      ),
    },
  ];

  // 调用结果语义：失败 / 成功 / 仅提示（后台执行、待审批）
  const invokeTone: ResultTone = invokeFailed
    ? 'error'
    : invokeResult && invokeResult.startsWith('调用成功')
      ? 'success'
      : 'info';
  const invokeToneLabel = invokeTone === 'error' ? '失败' : invokeTone === 'success' ? '成功' : '提示';

  return (
    <div className="page">
      <PageHeader
        title={
          <>
            <ThunderboltOutlined /> 能力目录
          </>
        }
        desc="统一管理连接器发现的能力：权限、审批、超时、响应映射与调用记录。对话中模型可通过 list_capabilities / invoke_capability 使用。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={reload} loading={loading}>
            刷新
          </Button>
        }
      />

      <Row gutter={12} className="stat-row">
        <Col xs={12} md={6}>
          <Card size="small" className="stat-card-item">
            <Statistic title={`近 ${metrics?.days ?? metricsDays} 天调用`} value={metrics?.total ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" className="stat-card-item">
            <Statistic title="成功率" value={metrics?.successRate ?? '—'} suffix={metrics?.successRate != null ? '%' : ''} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" className="stat-card-item">
            <Statistic title="平均耗时" value={metrics?.avgDurationMs ?? '—'} suffix={metrics?.avgDurationMs != null ? 'ms' : ''} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" className="stat-card-item">
            <Statistic title="待审批" value={metrics?.pendingApprovals ?? 0} valueStyle={{ color: (metrics?.pendingApprovals || 0) > 0 ? 'var(--warning)' : undefined }} />
          </Card>
        </Col>
      </Row>

      <Card>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'catalog',
              label: `能力（${caps.length}）`,
              children: (
                <>
                  <div className="toolbar" style={{ marginBottom: 14 }}>
                    <Input.Search
                      allowClear
                      // antd 默认搜索按钮只有内部图标的英文 aria-label="search"；
                      // 自定义 enterButton 让按钮拿到中文可访问名，外观仍是图标按钮。
                      enterButton={<SearchOutlined aria-label="搜索能力" />}
                      placeholder="搜索能力名 / 标识 / 路径"
                      style={{ width: 280 }}
                      onSearch={(v) => {
                        setCapQ(v);
                        setCapPage(1);
                      }}
                      onChange={(e) => {
                        if (!e.target.value) {
                          setCapQ('');
                          setCapPage(1);
                        }
                      }}
                    />
                    <Select
                      value={capStatus}
                      onChange={(v) => {
                        setCapStatus(v);
                        setCapPage(1);
                      }}
                      style={{ width: 130 }}
                      options={[
                        { value: 'all', label: '全部状态' },
                        { value: 'active', label: '启用' },
                        { value: 'disabled', label: '停用' },
                        { value: 'revoked', label: '已撤销' },
                      ]}
                    />
                    <Text type="secondary">共 {filteredCaps.length} 个</Text>
                  </div>
                  <Table
                    rowKey="id"
                    dataSource={filteredCaps}
                    columns={capColumns as any}
                    tableLayout="fixed"
                    pagination={{
                      current: capPage,
                      pageSize: 12,
                      showSizeChanger: false,
                      onChange: setCapPage,
                    }}
                    locale={{
                      emptyText: caps.length ? (
                        '没有匹配的能力'
                      ) : (
                        <Empty description="还没有能力">
                          <Button type="primary" onClick={() => router.push('/connectors')}>
                            去连接器发现
                          </Button>
                        </Empty>
                      ),
                    }}
                  />
                </>
              ),
            },
            ...(isAdmin
              ? [
                  {
                    key: 'approvals',
                    label: `待审批（${approvals.length}）`,
                    children: (
                      <Table
                        rowKey="id"
                        dataSource={approvals}
                        pagination={false}
                        locale={{ emptyText: '暂无待审批调用' }}
                        columns={[
                          { title: '能力', dataIndex: 'capabilityName', key: 'capabilityName', render: (v: string | null) => v || '—' },
                          { title: '调用者', dataIndex: 'userName', key: 'userName' },
                          { title: '参数', dataIndex: 'input', key: 'input', ellipsis: true },
                          { title: '来源', dataIndex: 'source', key: 'source' },
                          { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: number) => new Date(v).toLocaleString() },
                          {
                            title: '操作',
                            key: 'action',
                            render: (_: any, r: Op) => (
                              <Space>
                                <Button size="small" type="link" onClick={() => openOpDetail(r.id, r)}>
                                  详情
                                </Button>
                                <Popconfirm
                                  title="批准并执行该调用？"
                                  okText="批准"
                                  cancelText="取消"
                                  onConfirm={() => decide(r, true)}
                                >
                                  <Button size="small" type="primary" icon={<CheckOutlined />}>
                                    批准
                                  </Button>
                                </Popconfirm>
                                <Popconfirm
                                  title="拒绝该调用？"
                                  okText="拒绝"
                                  cancelText="取消"
                                  onConfirm={() => decide(r, false)}
                                >
                                  <Button size="small" danger icon={<CloseOutlined />}>
                                    拒绝
                                  </Button>
                                </Popconfirm>
                              </Space>
                            ),
                          },
                        ]}
                      />
                    ),
                  },
                ]
              : []),
            {
              key: 'ops',
              label: '调用记录',
              children: (
                <>
                  <Space wrap style={{ marginBottom: 12 }}>
                    <Select
                      value={opsStatus || 'all'}
                      onChange={(v) => {
                        const st = v === 'all' ? '' : v;
                        setOpsStatus(st);
                        setOpsPage(1);
                        loadOps({ page: 1, status: st });
                      }}
                      style={{ width: 140 }}
                      options={[
                        { value: 'all', label: '全部状态' },
                        { value: 'succeeded', label: '成功' },
                        { value: 'failed', label: '失败' },
                        { value: 'running', label: '运行中' },
                        { value: 'pending_approval', label: '待审批' },
                        { value: 'cancelled', label: '已取消' },
                      ]}
                    />
                    <Input.Search
                      allowClear
                      enterButton={<SearchOutlined aria-label="搜索调用记录" />}
                      placeholder="能力名 / 调用者 / 操作编号"
                      style={{ width: 280 }}
                      onSearch={(v) => {
                        setOpsQ(v);
                        setOpsPage(1);
                        loadOps({ page: 1, q: v });
                      }}
                      onChange={(e) => {
                        if (!e.target.value) {
                          setOpsQ('');
                          setOpsPage(1);
                          loadOps({ page: 1, q: '' });
                        }
                      }}
                    />
                    <Text type="secondary">共 {opsTotal} 条</Text>
                  </Space>
                  <Table
                    rowKey="id"
                    dataSource={ops}
                    columns={opColumns as any}
                    pagination={{
                      current: opsPage,
                      pageSize: OPS_PAGE_SIZE,
                      total: opsTotal,
                      showSizeChanger: false,
                      onChange: (p: number) => {
                        setOpsPage(p);
                        loadOps({ page: p });
                      },
                    }}
                    locale={{ emptyText: '暂无调用记录' }}
                    scroll={{ x: 900 }}
                  />
                </>
              ),
            },
            {
              key: 'metrics',
              label: '指标',
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Space wrap>
                    <Text type="secondary">时间范围</Text>
                    <Select
                      value={metricsDays}
                      onChange={(v) => {
                        setMetricsDays(v);
                        loadMetrics(v);
                      }}
                      style={{ width: 120 }}
                      options={[
                        { value: 7, label: '近 7 天' },
                        { value: 30, label: '近 30 天' },
                        { value: 90, label: '近 90 天' },
                      ]}
                    />
                    <Text type="secondary">
                      {metrics?.daily?.length
                        ? `${metrics.daily[0].date} ~ ${metrics.daily[metrics.daily.length - 1].date}（红 = 失败）`
                        : '—'}
                    </Text>
                  </Space>
                  <div>
                    <Text strong style={{ display: 'block', marginBottom: 8 }}>
                      每日调用量
                    </Text>
                    {metrics?.daily?.length ? (
                      <TrendBars data={metrics.daily} />
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
                    )}
                  </div>
                  <Table
                    rowKey="name"
                    dataSource={metrics?.topCapabilities || []}
                    pagination={false}
                    locale={{ emptyText: '暂无数据' }}
                    columns={[
                      { title: '能力', dataIndex: 'name', key: 'name' },
                      { title: '调用次数', dataIndex: 'total', key: 'total' },
                      { title: '失败', dataIndex: 'failed', key: 'failed' },
                      { title: '平均耗时', dataIndex: 'avgMs', key: 'avgMs', render: (v: number) => `${v}ms` },
                    ]}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* 调用 */}
      <Drawer
        title={invokeCap ? `调用能力：${invokeCap.name}` : '调用能力'}
        open={!!invokeCap}
        onClose={() => setInvokeCap(null)}
        width="min(620px, 92vw)"
      >
        {invokeCap && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="接口">
                <Tag color="blue">{invokeCap.method}</Tag> <Text code>{invokeCap.path}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="连接器">{invokeCap.connectorName || '内置'}</Descriptions.Item>
              <Descriptions.Item label="审批">{invokeCap.requiresApproval ? '需要管理员审批' : '直接调用'}</Descriptions.Item>
            </Descriptions>
            <Text strong>参数（JSON）</Text>
            {schemaFields(invokeCap).length > 0 && (
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                {schemaFields(invokeCap).map((f) => (
                  <Text key={f.name} type="secondary" style={{ fontSize: 12 }}>
                    <Text code style={{ fontSize: 12 }}>
                      {f.name}
                    </Text>{' '}
                    {f.required ? <Tag color="red">必填</Tag> : <Tag>可选</Tag>} {f.type}
                    {f.description ? ` · ${f.description}` : ''}
                  </Text>
                ))}
              </Space>
            )}
            <Input.TextArea rows={8} value={invokeInput} onChange={(e) => setInvokeInput(e.target.value)} style={{ fontFamily: 'monospace' }} />
            <Space size={8} wrap>
              <Switch checked={invokeAsync} onChange={setInvokeAsync} checkedChildren="后台" unCheckedChildren="同步" />
              <Text type="secondary">长任务可转后台执行，结果在「调用记录」查看（自动刷新）</Text>
              <Button size="small" onClick={formatJson}>
                格式化 JSON
              </Button>
            </Space>
            <Button type="primary" onClick={doInvoke} loading={invoking} icon={<ThunderboltOutlined />}>
              {invokeAsync ? '提交后台执行' : '调用'}
            </Button>
            {invokeResult && (
              <>
                <Space style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space size={8}>
                    <Text strong>结果</Text>
                    <Tag color={invokeTone === 'error' ? 'error' : invokeTone === 'success' ? 'success' : 'processing'}>
                      {invokeToneLabel}
                    </Tag>
                  </Space>
                  <Space size={4}>
                    {invokeFailed && (
                      <Button size="small" icon={<RedoOutlined />} onClick={doInvoke} loading={invoking}>
                        重试
                      </Button>
                    )}
                    <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyResult}>
                      复制
                    </Button>
                  </Space>
                </Space>
                <ResultBlock text={invokeResult} tone={invokeTone} maxHeight={320} />
              </>
            )}
          </Space>
        )}
      </Drawer>

      {/* 配置 */}
      <Modal title={editCap ? `配置能力：${editCap.name}` : '配置能力'} open={!!editCap} onOk={saveEdit} onCancel={() => setEditCap(null)} okText="保存" cancelText="取消" width={640} destroyOnHidden>
        <Form
          form={editForm}
          layout="vertical"
          preserve={false}
          initialValues={{
            name: editCap?.name,
            description: editCap?.description || '',
            minRole: editCap?.minRole,
            requiresApproval: editCap?.requiresApproval,
            timeoutMs: editCap?.timeoutMs,
            status: editCap?.status,
            responseMapping: editCap?.responseMapping || '{}',
          }}
        >
          <Form.Item name="name" label="展示名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="minRole" label="最低角色">
              <Select
                style={{ width: 140 }}
                options={[
                  { value: 'admin', label: '管理员' },
                  { value: 'member', label: '成员' },
                  { value: 'guest', label: '访客' },
                ]}
              />
            </Form.Item>
            <Form.Item name="timeoutMs" label="超时（ms）">
              <InputNumber min={1000} max={120000} step={1000} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="requiresApproval" label="需要审批" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="status" label="状态">
              <Select
                style={{ width: 120 }}
                options={[
                  { value: 'active', label: '启用' },
                  { value: 'disabled', label: '停用' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item
            name="responseMapping"
            label="响应映射（JSON）"
            extra='可选：{"extract":"data.list","pick":{"名称":"name","现价":"price/100"},"limit":20}'
          >
            <Input.TextArea rows={5} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 授权 */}
      <Drawer
        title={grantCap ? `能力授权：${grantCap.name}` : '能力授权'}
        open={!!grantCap}
        onClose={() => setGrantCap(null)}
        width="min(520px, 92vw)"
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Text type="secondary">添加授权后，只有名单内的用户或角色可调用该能力（管理员始终可用）。</Text>
          <Space.Compact style={{ width: '100%' }}>
            <Select
              value={grantType}
              onChange={(v) => {
                setGrantType(v);
                setGrantSubject('');
              }}
              options={[
                { value: 'user', label: '用户' },
                { value: 'role', label: '角色' },
              ]}
              style={{ width: 90 }}
            />
            {grantType === 'user' ? (
              <Select
                showSearch
                allowClear
                placeholder="选择用户"
                value={grantSubject || undefined}
                onChange={setGrantSubject}
                optionFilterProp="label"
                style={{ flex: 1 }}
                options={users.map((u) => ({ value: u.id, label: `${u.name}（${u.email}）` }))}
              />
            ) : (
              <Select
                placeholder="选择角色"
                value={grantSubject || undefined}
                onChange={setGrantSubject}
                style={{ flex: 1 }}
                options={[
                  { value: 'admin', label: '管理员' },
                  { value: 'member', label: '成员' },
                  { value: 'guest', label: '访客' },
                ]}
              />
            )}
            <Button type="primary" onClick={addGrant}>
              添加
            </Button>
          </Space.Compact>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={grants}
            locale={{ emptyText: '暂无授权（按角色可见性放行）' }}
            columns={[
              { title: '类型', dataIndex: 'subjectType', key: 'subjectType', width: 80, render: (t: string) => <Tag>{t === 'role' ? '角色' : '用户'}</Tag> },
              { title: '对象', dataIndex: 'subjectLabel', key: 'subjectLabel' },
              {
                title: '',
                key: 'action',
                width: 70,
                render: (_: any, r: Grant) => (
                  <Button size="small" type="link" danger onClick={() => removeGrant(r.id)}>
                    移除
                  </Button>
                ),
              },
            ]}
          />
        </Space>
      </Drawer>

      {/* 调用详情 */}
      <Drawer
        title={opDetail ? `调用详情：${opDetail.id}` : '调用详情'}
        open={!!opDetail}
        onClose={() => setOpDetail(null)}
        width="min(620px, 92vw)"
      >
        {opDetail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="能力">{opDetail.capabilityName || '（注册表工具）'}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_COLOR[opDetail.status] || 'default'}>{statusLabel(opDetail.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="调用者">{opDetail.userName || opDetail.userId}</Descriptions.Item>
              <Descriptions.Item label="来源">{opDetail.source}</Descriptions.Item>
              <Descriptions.Item label="模式">{opDetail.mode === 'async' ? '后台执行' : '同步执行'}</Descriptions.Item>
              <Descriptions.Item label="耗时">{opDetail.durationMs != null ? `${opDetail.durationMs}ms` : '—'}</Descriptions.Item>
              <Descriptions.Item label="时间">{new Date(opDetail.createdAt).toLocaleString()}</Descriptions.Item>
            </Descriptions>
            <Text strong>参数</Text>
            <ResultBlock text={opDetail.input || ''} tone="info" />
            <Text strong>输出</Text>
            <ResultBlock
              text={opDetail.output || opDetail.error || ''}
              tone={opDetail.error ? 'error' : opDetail.status === 'succeeded' ? 'success' : 'info'}
            />
            {['pending_approval', 'running', 'approved'].includes(opDetail.status) && (
              <Popconfirm title="确认取消该操作？" okText="取消操作" cancelText="返回" onConfirm={async () => {
                await fetch(`/api/capabilities/operations/${opDetail.id}`, { method: 'DELETE' });
                message.success('已取消');
                setOpDetail(null);
                loadOps();
              }}>
                <Button danger>取消操作</Button>
              </Popconfirm>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
}
