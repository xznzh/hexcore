'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import {
  Tabs,
  Table,
  Button,
  Tag,
  Modal,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Progress,
  Descriptions,
  App,
  Space,
  Empty,
  Alert,
  Typography,
  Card,
  Statistic,
  Switch,
  Dropdown,
  Spin,
} from 'antd';
import { PlusOutlined, DeleteOutlined, EyeOutlined, KeyOutlined, ThunderboltOutlined, DownloadOutlined, MoreOutlined } from '@ant-design/icons';
import MiniChart from '@/components/MiniChart';
import { safeValidate } from '@/lib/form';

const { Title, Text, Paragraph } = Typography;

type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  monthlyLimit: number;
  overQuotaAction: string;
  alertThreshold: number;
};
type Model = {
  id: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  visibleRoles: string;
  isDefault: boolean;
  enabled: boolean;
  capabilities: string;
  hasKey: boolean;
};
type Usage = {
  userId: string;
  email: string;
  name: string;
  period: string;
  tokensUsed: number;
  monthlyLimit: number;
};
type Log = { id: string; email: string | null; action: string; target: string | null; createdAt: number };

export default function AdminPage() {
  const { message, modal } = App.useApp();
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState<User[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [logsPage, setLogsPage] = useState(1);
  const [logsTotal, setLogsTotal] = useState(0);
  const [trend, setTrend] = useState<{ series: { date: string; tokens: number; cost: number }[]; total: number; totalCost: number; cache?: { hit: number; miss: number; rate: number } } | null>(null);
  const [regMode, setRegMode] = useState<string>('open');
  const [briefEnabled, setBriefEnabled] = useState<boolean>(true);
  const [inviteList, setInviteList] = useState<any[]>([]);
  const [inviteRole, setInviteRole] = useState<string>('member');
  const [evalResult, setEvalResult] = useState<any>(null);
  // 权限闸门：未确认身份前不渲染后台骨架，避免非管理员先闪一下用户表/模型表再被替换
  const [gate, setGate] = useState<'checking' | 'ok' | 'denied'>('checking');
  const [judgeIn, setJudgeIn] = useState('');
  const [judgeOut, setJudgeOut] = useState('');
  const [judgeRes, setJudgeRes] = useState<any>(null);
  const [cost, setCost] = useState<any>(null);
  const [costDays, setCostDays] = useState<number>(30);
  // V8.10：按 traceId 还原链路。列表模式按时间倒序分页，链路模式按时间正序全量。
  const [traceQuery, setTraceQuery] = useState<string>('');
  const [traceMode, setTraceMode] = useState<boolean>(false);
  // V8.10：单价不再由页面手填——金额按「模型配置」里的 price_in/price_out 计算。
  // 手填单价的问题不是麻烦，而是**两个数字会不一致**：页面按手填价算出「估算花费」，
  // 而库里配的单价没人读，管理员改完单价却看不到任何变化。
  // V8.7：通道健康度（数据源是 operation_logs 里的 eval_runtime / guardrail_output_block）
  const [quality, setQuality] = useState<any>(null);
  const [qualityDays, setQualityDays] = useState<number>(7);
  /**
   * V8.8：告警试算（dryRun）。
   *
   * 告警是周期任务，「上线后想确认阈值会不会命中」原本只能等一周。
   * 这里给一个只计算不发送的入口，先看会发什么，再决定要不要调阈值。
   */
  const [trialLoading, setTrialLoading] = useState(false);
  const [trial, setTrial] = useState<any>(null);
  const [trialOpen, setTrialOpen] = useState(false);

  async function runEval() {
    const r = await fetch('/api/admin/eval');
    if (r.ok) setEvalResult(await r.json());
  }

  async function runJudge() {
    if (!judgeIn.trim() || !judgeOut.trim()) {
      message.warning('请填写输入与回答');
      return;
    }
    const r = await fetch('/api/admin/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: judgeIn, output: judgeOut }),
    });
    const j = await r.json();
    if (r.ok) setJudgeRes(j);
    else message.error(j.error || '评估失败');
  }

  const [userModalOpen, setUserModalOpen] = useState(false);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [keyModalModel, setKeyModalModel] = useState<Model | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [drawerUser, setDrawerUser] = useState<User | null>(null);

  const [userForm] = Form.useForm();
  const [modelForm] = Form.useForm();

  // 统一的 JSON 请求封装：失败/非预期形状一律兜底为空数组/空对象，
  // 避免「把错误对象塞进 antd Table dataSource」导致整页崩成 rawData.some is not a function。
  const getJson = async (url: string, expect: 'array' | 'object') => {
    try {
      const r = await fetch(url);
      if (r.status === 401) {
        if (typeof window !== 'undefined') window.location.href = '/login';
        return expect === 'array' ? [] : null;
      }
      if (r.status === 403) {
        setGate('denied');
        return expect === 'array' ? [] : null;
      }
      if (!r.ok) return expect === 'array' ? [] : null;
      const j = await r.json();
      if (expect === 'array') return Array.isArray(j) ? j : [];
      return j && typeof j === 'object' ? j : null;
    } catch {
      return expect === 'array' ? [] : null;
    }
  };

  // 操作日志：服务端分页加载（详见 app/api/logs/route.ts），后台不再一次性拉全表。
  async function loadLogs(page: number) {
    const j = await getJson(`/api/logs?page=${page}&pageSize=50`, 'object');
    const rows = (j as any)?.rows;
    if (j && Array.isArray(rows)) {
      setLogs(rows as Log[]);
      setLogsTotal((j as any).total || 0);
      setLogsPage(page);
      setTraceMode(false);
    }
  }

  /** 按 traceId 还原一次请求的完整链路（时间正序，不分页） */
  async function loadTrace() {
    const id = traceQuery.trim();
    if (!id) return;
    const j = await getJson(`/api/logs?trace=${encodeURIComponent(id)}`, 'object');
    const rows = (j as any)?.rows;
    if (j && Array.isArray(rows)) {
      setLogs(rows as Log[]);
      setLogsTotal(rows.length);
      setTraceMode(true);
    }
    if (Array.isArray(rows) && rows.length === 0) message.info('这条链路没有日志：id 不存在，或产生于更早的版本（那时 trace 只写在 detail 里）');
  }

  // 成本看板：聚合 operation_logs 真实 token（O12 落地），覆盖 chat / 引擎 / 记忆 / 调度全路径。
  async function loadCost(days: number) {
    const j = await getJson(`/api/admin/cost?days=${days}`, 'object');
    if (j) setCost(j);
  }

  /**
   * 通道健康度。
   *
   * 注意 `getJson(..., 'object')` 在请求失败时返回 null，所以这里用 `if (j) setQuality(j)`：
   * 失败时保留上一次的数据（并靠接口自身的错误提示），
   * 而不是把页面刷成空态——空态会被读成「一切正常」，那是更危险的误导。
   */
  async function loadQuality(days: number) {
    const j = await getJson(`/api/admin/quality?days=${days}`, 'object');
    if (j) setQuality(j);
  }

  /** 试算：调告警检查接口的 dryRun 分支，只返回「会发什么」，不发通知、不写状态。 */
  async function runAlertTrial() {
    setTrialLoading(true);
    try {
      const r = await fetch('/api/admin/quality/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const j = await r.json();
      if (!r.ok) {
        message.error(j?.error || '试算失败');
        return;
      }
      setTrial(j);
      setTrialOpen(true);
    } finally {
      setTrialLoading(false);
    }
  }

  async function loadAll() {
    const [u, m, us, tr] = await Promise.all([
      getJson('/api/admin/users', 'array'),
      getJson('/api/admin/models', 'array'),
      getJson('/api/usage', 'array'),
      getJson('/api/usage/trend?days=30', 'object'),
    ]);
    setUsers(u as User[]);
    setModels(m as Model[]);
    setUsage(us as Usage[]);
    setTrend(tr as any);
    await loadLogs(1);
    await loadCost(costDays);
    await loadQuality(qualityDays);
    loadAccess();
  }

  async function loadAccess() {
    const r = await fetch('/api/admin/settings');
    if (r.ok) {
      const j = await r.json();
      setRegMode(j.registerMode);
      setBriefEnabled(j.briefEnabled !== false);
    }
    const ir = await fetch('/api/admin/invites');
    if (ir.ok) setInviteList(await ir.json());
  }

  async function changeRegMode(mode: string) {
    const r = await fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registerMode: mode }),
    });
    if (r.ok) {
      setRegMode(mode);
      message.success('已更新注册方式');
    } else {
      message.error('更新失败');
    }
  }

  async function changeBriefEnabled(on: boolean) {
    const r = await fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefEnabled: on }),
    });
    if (r.ok) {
      setBriefEnabled(on);
      message.success(on ? '已开启今日简报' : '已关闭今日简报（工作台改为数据摘要）');
    } else {
      message.error('更新失败');
    }
  }

  async function createInvite() {
    const r = await fetch('/api/admin/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: inviteRole }),
    });
    if (r.ok) {
      const j = await r.json();
      message.success(`邀请码：${j.code}`);
      loadAccess();
    }
  }

  async function removeInvite(id: string) {
    await fetch(`/api/admin/invites?id=${id}`, { method: 'DELETE' });
    loadAccess();
  }
  useEffect(() => {
    // 先用 /api/auth/me 确认角色，再决定是否拉数据：
    // 之前是无条件 loadAll()，非管理员会先看到完整的后台外壳（空表 + 一堆操作按钮）再被替换成「无权限」，
    // 既闪屏又白白打了 5 个注定 403 的接口。
    (async () => {
      try {
        const r = await fetch('/api/auth/me');
        if (r.status === 401) {
          window.location.href = '/login';
          return;
        }
        const me = r.ok ? await r.json() : null;
        if (!me || me.role !== 'admin') {
          setGate('denied');
          return;
        }
      } catch {
        setGate('denied');
        return;
      }
      setGate('ok');
      await loadAll();
    })();
  }, []);

  async function patchUser(id: string, body: any) {
    const r = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    });
    if (!r.ok) message.error((await r.json().catch(() => ({}))).error || '操作失败');
    await loadAll();
  }
  function resetPassword(u: User) {
    let val = '';
    modal.confirm({
      title: `重置「${u.name}」的密码`,
      content: (
        <Input.Password
          placeholder="输入新密码（至少 6 位）"
          onChange={(e) => (val = e.target.value)}
          style={{ marginTop: 8 }}
        />
      ),
      okText: '重置',
      cancelText: '取消',
      onOk: async () => {
        if (!val || val.length < 6) {
          message.warning('密码至少 6 位');
          return Promise.reject();
        }
        await patchUser(u.id, { password: val });
        message.success('密码已重置');
      },
    });
  }

  async function removeUser(id: string) {
    modal.confirm({
      title: '确认删除该用户？',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await fetch(`/api/admin/users?id=${id}`, { method: 'DELETE' });
        message.success('已删除');
        await loadAll();
        setDrawerUser(null);
      },
    });
  }
  async function setDefaultModel(id: string) {
    await fetch('/api/admin/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, isDefault: true }),
    });
    message.success('已设为默认');
    await loadAll();
  }
  async function toggleModel(id: string, enabled: boolean) {
    await fetch('/api/admin/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
    message.success(enabled ? '已启用' : '已停用');
    await loadAll();
  }
  async function saveModelKey() {
    if (!keyModalModel) return;
    const r = await fetch('/api/admin/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: keyModalModel.id, apiKey: keyInput }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      message.error(j.error || '保存失败');
      return;
    }
    message.success(keyInput.trim() ? 'Key 已保存' : 'Key 已清除');
    setKeyModalModel(null);
    setKeyInput('');
    await loadAll();
  }
  async function testModel(id: string) {
    const hide = message.loading('测试连通性…', 0);
    const r = await fetch('/api/admin/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const j = await r.json().catch(() => ({}));
    hide();
    if (j.ok) message.success(`连通正常（${j.ms}ms）${j.sample ? ' · ' + j.sample : ''}`);
    else message.error(j.error || '连通失败');
  }
  async function removeModel(id: string) {
    modal.confirm({
      title: '确认删除该模型？',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await fetch(`/api/admin/models?id=${id}`, { method: 'DELETE' });
        message.success('已删除');
        await loadAll();
      },
    });
  }

  async function submitUser() {
    const v = await safeValidate(userForm);
    if (!v) return;
    const r = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...v, monthlyLimit: Number(v.monthlyLimit) }),
    });
    if (r.ok) {
      message.success('已添加用户');
      userForm.resetFields();
      setUserModalOpen(false);
      loadAll();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '添加失败');
    }
  }
  async function submitModel() {
    const v = await safeValidate(modelForm);
    if (!v) return;
    const r = await fetch('/api/admin/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...v,
        visibleRoles: v.visibleRoles && v.visibleRoles.length ? v.visibleRoles : ['admin', 'member'],
      }),
    });
    if (r.ok) {
      message.success('已添加模型');
      modelForm.resetFields();
      setModelModalOpen(false);
      loadAll();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '添加失败');
    }
  }

  const userUsage = drawerUser ? usage.find((u) => u.userId === drawerUser.id) : undefined;
  const usedPct = userUsage
    ? Math.min(100, Math.round((userUsage.tokensUsed / Math.max(1, userUsage.monthlyLimit)) * 100))
    : 0;

  const userColumns = [
    { title: '昵称', dataIndex: 'name', key: 'name', width: 200 },
    { title: '邮箱', dataIndex: 'email', key: 'email', ellipsis: true },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (r: string) => <Tag color={r === 'admin' ? 'cyan' : r === 'guest' ? 'orange' : 'default'}>{r === 'admin' ? '管理员' : r === 'guest' ? '访客' : '成员'}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 92,
      render: (s: string) => <Tag color={s === 'active' ? 'green' : 'red'}>{s === 'active' ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '月度额度',
      dataIndex: 'monthlyLimit',
      key: 'monthlyLimit',
      width: 128,
      align: 'right' as const,
      render: (n: number) => n.toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      width: 168,
      align: 'right' as const,
      render: (_: any, record: User) => (
        <Space size={6} wrap={false} onClick={(e) => e.stopPropagation()}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDrawerUser(record)}>
            详情
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeUser(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const modelColumns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '供应商', dataIndex: 'provider', key: 'provider' },
    {
      title: '能力',
      dataIndex: 'capabilities',
      key: 'capabilities',
      render: (v: string) => {
        let caps: string[] = [];
        try {
          caps = JSON.parse(v || '[]');
        } catch {
          caps = [];
        }
        return <Space size={4} wrap>{caps.map((c) => <Tag key={c}>{c}</Tag>)}</Space>;
      },
    },
    { title: 'baseURL', dataIndex: 'baseUrl', key: 'baseUrl', render: (v: string) => <Text type="secondary">{v}</Text> },
    { title: '可见角色', dataIndex: 'visibleRoles', key: 'visibleRoles' },
    {
      title: '默认',
      dataIndex: 'isDefault',
      key: 'isDefault',
      render: (b: boolean) => (b ? <Tag color="gold">★ 默认</Tag> : ''),
    },
    { title: 'Key', dataIndex: 'hasKey', key: 'hasKey', render: (b: boolean) => (b ? '已配置' : '无') },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (b: boolean, record: Model) => <Switch checked={b} onChange={(v) => toggleModel(record.id, v)} size="small" />,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      align: 'right' as const,
      render: (_: any, record: Model) => (
        // 主操作「测试」单列，其余收进更多菜单，避免 4 个按钮挤成一行
        <Space size={6} wrap={false}>
          <Button size="small" icon={<ThunderboltOutlined />} onClick={() => testModel(record.id)}>
            测试
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'key',
                  icon: <KeyOutlined />,
                  label: '设置 Key',
                  onClick: () => {
                    setKeyModalModel(record);
                    setKeyInput('');
                  },
                },
                ...(record.isDefault
                  ? []
                  : [{ key: 'default', label: '设为默认', onClick: () => setDefaultModel(record.id) }]),
                { type: 'divider' as const },
                {
                  key: 'delete',
                  danger: true,
                  icon: <DeleteOutlined />,
                  label: '删除模型',
                  onClick: () =>
                    modal.confirm({
                      title: '删除模型？',
                      content: `将删除「${record.name}」，引用它的会话与技能需重新选择模型。`,
                      okText: '删除',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () => removeModel(record.id),
                    }),
                },
              ],
            }}
          >
            <Button size="small" icon={<MoreOutlined />} aria-label="模型更多操作" />
          </Dropdown>
        </Space>
      ),
    },
  ];

  const usageColumns = [
    {
      title: '用户',
      key: 'user',
      render: (_: any, r: Usage) => (
        <span>
          {r.name} <Text type="secondary">({r.email})</Text>
        </span>
      ),
    },
    { title: '周期', dataIndex: 'period', key: 'period' },
    { title: '已用', dataIndex: 'tokensUsed', key: 'tokensUsed', render: (n: number) => n.toLocaleString() },
    { title: '额度', dataIndex: 'monthlyLimit', key: 'monthlyLimit', render: (n: number) => n.toLocaleString() },
    {
      title: '进度',
      key: 'progress',
      render: (_: any, r: Usage) => {
        const pct = Math.min(100, Math.round((r.tokensUsed / Math.max(1, r.monthlyLimit)) * 100));
        const color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--accent)';
        return (
          <div style={{ width: 200 }}>
            <Progress percent={pct} strokeColor={color} size="small" />
          </div>
        );
      },
    },
  ];

  const logColumns = [
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: number) => new Date(v).toLocaleString() },
    { title: '用户', dataIndex: 'email', key: 'email', render: (v: string) => v || '系统' },
    { title: '动作', dataIndex: 'action', key: 'action' },
    { title: '对象', dataIndex: 'target', key: 'target', render: (v: string) => <Text type="secondary">{v || '-'}</Text> },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) =>
        v ? <Tag color={v === 'ok' ? 'green' : v === 'error' ? 'red' : 'default'}>{v}</Tag> : '-',
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      key: 'durationMs',
      render: (v: number) => (typeof v === 'number' ? `${v} ms` : '-'),
    },
  ];

  const costModelColumns = [
    { title: '模型', dataIndex: 'key', key: 'key', render: (v: string) => v || '（未知）' },
    { title: 'Token', dataIndex: 'tokens', key: 'tokens', render: (n: number) => n.toLocaleString() },
    { title: '调用', dataIndex: 'calls', key: 'calls', render: (n: number) => n.toLocaleString() },
    {
      title: '占比',
      key: 'pct',
      render: (_: any, r: any) =>
        cost?.total?.tokens ? `${Math.round((r.tokens / cost.total.tokens) * 1000) / 10}%` : '-',
    },
    // 金额来自后台「模型配置」里的单价（分/千 token），输入与输出分别计价。
    // 单元只展示能算出来的部分；算不出来的用灰色标注，避免 ¥0.00 被读成「没花钱」。
    {
      title: '花费(¥)',
      key: 'cost',
      render: (_: any, r: any) => (
        <>
          {(Math.round((r.costCents || 0)) / 100).toFixed(2)}
          {r.unpricedTokens > 0 && (
            <Tag color="default" style={{ marginLeft: 6 }}>
              未计价 {r.unpricedTokens.toLocaleString()}
            </Tag>
          )}
        </>
      ),
    },
  ];
  const costLabelColumns = [
    { title: '用途', dataIndex: 'key', key: 'key', render: (v: string) => v || '（未知）' },
    { title: 'Token', dataIndex: 'tokens', key: 'tokens', render: (n: number) => n.toLocaleString() },
    { title: '调用', dataIndex: 'calls', key: 'calls', render: (n: number) => n.toLocaleString() },
    {
      title: '占比',
      key: 'pct',
      render: (_: any, r: any) =>
        cost?.total?.tokens ? `${Math.round((r.tokens / cost.total.tokens) * 1000) / 10}%` : '-',
    },
    {
      title: '花费(¥)',
      key: 'cost',
      render: (_: any, r: any) => (Math.round(r.costCents || 0) / 100).toFixed(2),
    },
  ];

  // —— V8.7 通道健康度 ——
  // 通道名直接展示原始值（chat/skill/schedule/api）：这是给管理员排障用的，
  // 翻译成中文反而让日志里的值对不上。
  const qualityChannelColumns = [
    { title: '通道', dataIndex: 'channel', key: 'channel', render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '拦截级', dataIndex: 'failed', key: 'failed', width: 90 },
    { title: '仅告警', dataIndex: 'warned', key: 'warned', width: 90 },
    { title: '合计', dataIndex: 'total', key: 'total', width: 80 },
  ];
  const qualityRuleColumns = [
    { title: '规则', dataIndex: 'rule', key: 'rule' },
    {
      title: '级别',
      dataIndex: 'severity',
      key: 'severity',
      width: 90,
      render: (v: string) => <Tag color={v === 'block' ? 'red' : 'orange'}>{v === 'block' ? '拦截' : '告警'}</Tag>,
    },
    { title: '次数', dataIndex: 'count', key: 'count', width: 80 },
  ];
  const qualityLabelColumns = [
    { title: '通道', dataIndex: 'channel', key: 'channel', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '名称', dataIndex: 'label', key: 'label', ellipsis: true },
    { title: '问题数', dataIndex: 'total', key: 'total', width: 90 },
    { title: '拦截级', dataIndex: 'failed', key: 'failed', width: 90 },
    { title: '最常见规则', dataIndex: 'topRule', key: 'topRule', render: (v: string) => <Text type="secondary">{v || '—'}</Text> },
  ];
  const qualityRecentColumns = [
    { title: '时间', dataIndex: 'at', key: 'at', width: 180, render: (v: number) => new Date(v).toLocaleString() },
    { title: '通道', dataIndex: 'channel', key: 'channel', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '名称', dataIndex: 'label', key: 'label', width: 180, ellipsis: true, render: (v: string) => v || '—' },
    {
      title: '规则',
      dataIndex: 'issues',
      key: 'issues',
      render: (v: string, r: any) => (
        <Space size={4} wrap>
          {r.observe && <Tag color="gold">观察模式</Tag>}
          <Text type="secondary">{v}</Text>
        </Space>
      ),
    },
  ];

  /**
   * 告警状态摘要（V8.8）。
   *
   * 这一段存在的唯一目的是回答「配了告警，为什么没收到」。三种原因在界面上
   * 本来长得一模一样：没到阈值、在静默期、检查压根没跑过。不写出来，
   * 管理员只能去猜，然后开始怀疑功能坏了（或者反过来，以为一切正常）。
   */
  const alertSnap = (() => {
    const a = quality?.alerts;
    if (!a) return null;
    if (a.state === null) {
      return {
        type: 'warning' as const,
        message: '告警状态读不出来',
        description: '存储的告警状态无法解析，暂时判断不了是否曾告警。下一次检查会覆盖它。',
      };
    }
    const p = a.policy || {};
    const rule = `阈值：同一「通道 · 名称 · 规则」在 ${p.windowMin ?? '?'} 分钟内出现 ${p.minCount ?? '?'} 次；同一项 ${Math.round((p.cooldownMin ?? 0) / 60)} 小时内不重复提醒。`;
    if (!a.state.lastRunAt) {
      return {
        type: 'warning' as const,
        message: '告警检查还没跑过',
        description:
          '调度器可能已关闭（SCHEDULER_ENABLED=false），或服务刚启动（最长等 10 分钟）。' +
          '用「试算」可以立刻确认当前数据会不会触发告警。' +
          rule,
      };
    }
    const mins = Math.max(0, Math.round((Date.now() - a.state.lastRunAt) / 60000));
    /**
     * 外发状态（V8.9）。
     *
     * 单独一行，不塞进上面的规则描述：规则是「什么时候会发」，外发是「发出去没有」，
     * 两件事。而 `lastExternal === null` 有两种可能（没配 webhook / 还没产生过告警），
     * 所以措辞必须同时覆盖两者，不能写成「未配置」——那会把「配了但一直没告警」
     * 误报成配置问题，反过来又让人去查一个没坏的东西。
     */
    const ext = a.state.lastExternal;
    const externalLine = ext
      ? ext.failed > 0
        ? `外发：${ext.ok}/${ext.targets} 个目标成功，最近一次失败在 ${Math.max(0, Math.round((Date.now() - ext.at) / 60000))} 分钟前（${ext.error || ext.skipped || '原因未知'}）。`
        : `外发：${Math.max(0, Math.round((Date.now() - ext.at) / 60000))} 分钟前投递到 ${ext.targets} 个目标，全部成功。`
      : '外发：暂无记录（未配置 QUALITY_ALERT_WEBHOOK，或尚未产生过告警）。';
    const active = a.state.active || [];
    if (active.length) {
      return {
        type: 'warning' as const,
        message: `当前有 ${active.length} 项告警处于静默期`,
        description: `最近一次检查 ${mins} 分钟前。${rule} ${externalLine}`,
      };
    }
    const suppressed = a.state.lastResult?.suppressed ?? 0;
    return {
      type: 'success' as const,
      message: '告警正常',
      description:
        `最近一次检查 ${mins} 分钟前，没有处于静默期的告警项。` +
        (suppressed > 0 ? `本轮有 ${suppressed} 项命中但被静默期压住。` : '') +
        rule +
        ' ' +
        externalLine,
    };
  })();

  return (
    <div className="page">
        <PageHeader title="管理后台" />

        {gate === 'checking' ? (
          <div className="admin-gate">
            <Spin />
            <span>正在校验访问权限…</span>
          </div>
        ) : gate === 'denied' ? (
          <div className="notfound-wrap">
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔒 无访问权限</div>
            <div style={{ color: 'var(--muted)', marginBottom: 16 }}>管理后台仅对管理员开放，请联系管理员开通权限。</div>
            <a href="/work" className="antd-btn-hyper">返回工作台</a>
          </div>
        ) : (
        <Tabs
        className="page-tabs"
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'users',
            label: '用户管理',
            children: (
              <>
                <div className="toolbar">
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setUserModalOpen(true)}>
                    添加用户
                  </Button>
                </div>
                <Table
                  rowKey="id"
                  dataSource={users}
                  columns={userColumns}
                  pagination={{ pageSize: 10 }}
                  onRow={(record) => ({ onClick: () => setDrawerUser(record) })}
                  rowClassName={() => 'clickable-row'}
                />
              </>
            ),
          },
          {
            key: 'models',
            label: '模型配置',
            children: (
              <>
                <div className="toolbar">
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setModelModalOpen(true)}>
                    添加模型
                  </Button>
                  <span className="toolbar-hint">
                    向量模型要与 EMBED_DIM 配对：MiniMax embo-01 = 1536，BAAI/bge-m3 = 1024，text-embedding-3-small = 1536；默认 384 为本地降级向量。改完维度后需在知识库点「重新索引」。
                  </span>
                </div>
                <Table rowKey="id" dataSource={models} columns={modelColumns} pagination={{ pageSize: 10 }} />
              </>
            ),
          },
          {
            key: 'usage',
            label: '额度 / 用量',
            children: (
              <>
                {trend && (
                  <Card size="small" style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <Text strong>近 30 天 Token 消耗趋势</Text>
                      <Text type="secondary">
                        合计 {trend.total.toLocaleString()} Token · 估算花费 {trend.totalCost}
                        {trend.cache ? ` · 缓存命中率 ${trend.cache.rate}%（${trend.cache.hit}/${trend.cache.hit + trend.cache.miss}）` : ''}
                      </Text>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <MiniChart data={trend.series.map((d) => ({ label: d.date, value: d.tokens }))} height={140} />
                    </div>
                  </Card>
                )}
                <div className="toolbar">
                  <Button icon={<DownloadOutlined />} onClick={() => window.open('/api/usage/export', '_blank')}>
                    导出用量 CSV
                  </Button>
                </div>
                <Table rowKey="userId" dataSource={usage} columns={usageColumns} pagination={{ pageSize: 10 }} />
              </>
            ),
          },
          {
            key: 'logs',
            label: '操作日志',
            children: (
              <>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Input
                    placeholder="按 traceId 还原一次请求的链路（形如 tr1a2b3c4d5e6f7890）"
                    value={traceQuery}
                    onChange={(e) => setTraceQuery(e.target.value)}
                    onPressEnter={loadTrace}
                    allowClear
                    style={{ width: 380 }}
                  />
                  <Button onClick={loadTrace} disabled={!traceQuery.trim()}>
                    查链路
                  </Button>
                  {traceMode && (
                    <Button type="link" onClick={() => { setTraceQuery(''); loadLogs(1); }}>
                      返回列表
                    </Button>
                  )}
                  {traceMode && <Text type="secondary">当前按时间正序展示该链路的全部日志（最多 500 条）</Text>}
                </Space>
                <Table
                  rowKey="id"
                  dataSource={logs}
                  columns={logColumns}
                  pagination={
                    traceMode
                      ? false
                      : {
                          current: logsPage,
                          pageSize: 50,
                          total: logsTotal,
                          showSizeChanger: false,
                          onChange: (p: number) => loadLogs(p),
                        }
                  }
                />
              </>
            ),
          },
          {
            key: 'cost',
            label: '成本看板',
            children: cost ? (
              <>
                <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Space>
                    <Text>统计区间</Text>
                    <Select
                      value={costDays}
                      style={{ width: 110 }}
                      onChange={(v: number) => {
                        setCostDays(v);
                        loadCost(v);
                      }}
                      options={[
                        { value: 7, label: '近 7 天' },
                        { value: 30, label: '近 30 天' },
                        { value: 90, label: '近 90 天' },
                      ]}
                    />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    金额按「模型配置」里的单价（分/千 token、输入与输出分别计价）计算；
                    没填单价或历史行未拆分 token 的部分会标为「未计价」，不按 0 元计入。
                  </Text>
                </div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                  <Card size="small" style={{ flex: 1, minWidth: 160 }}>
                    <Statistic title={`近${cost.days}天 Token 总量`} value={cost.total.tokens} />
                  </Card>
                  <Card size="small" style={{ flex: 1, minWidth: 160 }}>
                    <Statistic title="调用次数" value={cost.total.calls} />
                  </Card>
                  <Card size="small" style={{ flex: 1, minWidth: 160 }}>
                    <Statistic title="花费(¥)" value={Math.round(cost.total.costCents || 0) / 100} precision={2} />
                    {!cost.total.fullyPriced && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        未计价 {(cost.total.unpriced?.unsplitTokens || 0) + (cost.total.unpriced?.noPriceTokens || 0)} token
                      </Text>
                    )}
                  </Card>
                  <Card size="small" style={{ flex: 1, minWidth: 160 }}>
                    <Statistic
                      title="失败率"
                      value={cost.total.failRate}
                      suffix="%"
                      precision={1}
                      valueStyle={{ color: cost.total.failRate > 5 ? 'var(--danger)' : undefined }}
                    />
                    {(cost.total.unknownOkCalls || 0) > 0 && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        另有 {cost.total.unknownOkCalls} 次成败未知（历史行），未计入分母
                      </Text>
                    )}
                  </Card>
                </div>
                {cost.byDay.length > 0 && (
                  <Card size="small" style={{ marginBottom: 16 }} title={`每日 Token 趋势（${cost.from} ~ ${cost.to}）`}>
                    <MiniChart data={cost.byDay.map((d: any) => ({ label: d.key, value: d.tokens }))} height={140} />
                  </Card>
                )}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <Card size="small" title="按模型分布" style={{ flex: 1, minWidth: 320 }}>
                    <Table rowKey="key" size="small" dataSource={cost.byModel} columns={costModelColumns} pagination={false} />
                  </Card>
                  <Card size="small" title="按用途分布" style={{ flex: 1, minWidth: 320 }}>
                    <Table rowKey="key" size="small" dataSource={cost.byLabel} columns={costLabelColumns} pagination={false} />
                  </Card>
                </div>
              </>
            ) : (
              <Empty description="加载中…" />
            ),
          },
          {
            key: 'eval',
            label: '评估',
            children: (
              <>
                <Card
                  size="small"
                  title="通道健康度"
                  style={{ marginBottom: 16 }}
                  extra={
                    <Space>
                      <Select
                        value={qualityDays}
                        style={{ width: 120 }}
                        onChange={(v) => {
                          setQualityDays(v);
                          loadQuality(v);
                        }}
                        options={[
                          { value: 1, label: '近 1 天' },
                          { value: 7, label: '近 7 天' },
                          { value: 30, label: '近 30 天' },
                        ]}
                      />
                      <Button size="small" onClick={() => loadQuality(qualityDays)}>
                        刷新
                      </Button>
                    </Space>
                  }
                >
                  <Paragraph type="secondary" style={{ marginBottom: 12 }}>
                    数据来自运行时校验（技能 / 定时任务 / 对话三条通道）与出口护栏的拦截记录。
                    <b>没有记录 = 这段时间没有触发规则</b>，不代表该通道没有运行。
                  </Paragraph>
                  {alertSnap && (
                    <Alert
                      type={alertSnap.type}
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={alertSnap.message}
                      description={
                        <>
                          <div>{alertSnap.description}</div>
                          {(quality?.alerts?.state?.active?.length ?? 0) > 0 && (
                            <Space size={4} wrap style={{ marginTop: 8 }}>
                              {quality.alerts.state.active.map((x: any) => (
                                <Tag key={x.key} color={x.observe ? 'gold' : 'red'}>
                                  {x.key} × {x.count}
                                </Tag>
                              ))}
                            </Space>
                          )}
                        </>
                      }
                      action={
                        <Button size="small" loading={trialLoading} onClick={runAlertTrial}>
                          试算
                        </Button>
                      }
                    />
                  )}
                  <Modal
                    open={trialOpen}
                    onCancel={() => setTrialOpen(false)}
                    title="告警试算（不发送）"
                    width={720}
                    footer={<Button onClick={() => setTrialOpen(false)}>知道了</Button>}
                  >
                    {trial && (
                      <>
                        <Paragraph type="secondary">
                          扫描 {trial.scanned ?? 0} 条记录，其中 {trial.unparsed ?? 0} 条无法解析；本轮会发出{' '}
                          {trial.issued ?? 0} 条通知，另有 {trial.suppressed ?? 0} 条被阈值或静默期压住。
                          {trial.truncated ? '（已达明细行数上限，只统计了最近一部分）' : ''}
                        </Paragraph>
                        {trial.planned?.length ? (
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            {trial.planned.map((n: any, i: number) => (
                              <Card key={i} size="small" title={n.title}>
                                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{n.body}</pre>
                              </Card>
                            ))}
                          </Space>
                        ) : (
                          <Empty description="按当前阈值与数据，这一轮不会发出任何通知" />
                        )}
                        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                          试算只读：不改动静默期状态。真正检查时仍按上次告警时间判断该不该发。
                        </Paragraph>
                      </>
                    )}
                  </Modal>
                  {quality ? (
                    <>
                      {(quality.unparsed > 0 || quality.truncated) && (
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message={[
                            quality.unparsed > 0 ? `${quality.unparsed} 条记录无法解析，统计可能不完整` : '',
                            quality.truncated ? '已达到明细行数上限，只统计了最近一部分记录' : '',
                          ]
                            .filter(Boolean)
                            .join('；')}
                        />
                      )}
                      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 12 }}>
                        <Statistic title="问题记录" value={quality.parsed ?? 0} />
                        <Statistic title="拦截级" value={quality.failed ?? 0} />
                        <Statistic title="仅告警" value={quality.warned ?? 0} />
                        <Statistic title="涉及通道" value={quality.channels?.length ?? 0} />
                      </div>
                      {(quality.parsed ?? 0) === 0 ? (
                        <Empty
                          description={
                            (quality.unparsed ?? 0) > 0
                              ? '有记录但都无法解析，请检查日志格式是否变化'
                              : '这段时间没有通道触发校验规则'
                          }
                        />
                      ) : (
                        <>
                          {quality.byDay?.length > 0 && (
                            <div style={{ marginBottom: 16 }}>
                              <MiniChart
                                data={quality.byDay.map((d: any) => ({
                                  label: String(d.day).slice(5),
                                  value: (d.failed || 0) + (d.warned || 0),
                                }))}
                                height={120}
                              />
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            <Card size="small" title="按通道" style={{ flex: 1, minWidth: 280 }}>
                              <Table
                                rowKey="channel"
                                size="small"
                                pagination={false}
                                dataSource={quality.channels || []}
                                columns={qualityChannelColumns}
                              />
                            </Card>
                            <Card size="small" title="按规则" style={{ flex: 1, minWidth: 280 }}>
                              <Table
                                rowKey="rule"
                                size="small"
                                pagination={false}
                                dataSource={quality.rules || []}
                                columns={qualityRuleColumns}
                              />
                            </Card>
                          </div>
                          {quality.labels?.length > 0 && (
                            <Card size="small" title="问题最多的技能 / 任务" style={{ marginTop: 16 }}>
                              <Table
                                rowKey={(r: any) => `${r.channel}/${r.label}`}
                                size="small"
                                pagination={false}
                                dataSource={quality.labels}
                                columns={qualityLabelColumns}
                              />
                            </Card>
                          )}
                          {quality.recent?.length > 0 && (
                            <Card size="small" title="最近记录" style={{ marginTop: 16 }}>
                              <Table
                                rowKey={(_: any, i: any) => String(i)}
                                size="small"
                                pagination={false}
                                dataSource={quality.recent}
                                columns={qualityRecentColumns}
                              />
                            </Card>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <Empty description="加载中…" />
                  )}
                </Card>
                <Card size="small" title="RAG 检索自检（recall@k）" style={{ marginBottom: 16 }}>
                  <Button onClick={runEval}>运行自检</Button>
                  {evalResult && (
                    <div style={{ marginTop: 8 }}>
                      <Text>通过 {evalResult.pass} / {evalResult.total}</Text>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>{evalResult.note}</Text>
                      </div>
                    </div>
                  )}
                </Card>
                <Card size="small" title="LLM-as-judge 回答质量评估">
                  <div style={{ marginBottom: 8 }}>
                    <Text>输入 / 问题</Text>
                    <Input.TextArea rows={3} value={judgeIn} onChange={(e) => setJudgeIn(e.target.value)} style={{ marginTop: 4 }} />
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <Text>待评估回答</Text>
                    <Input.TextArea rows={4} value={judgeOut} onChange={(e) => setJudgeOut(e.target.value)} style={{ marginTop: 4 }} />
                  </div>
                  <Button type="primary" onClick={runJudge}>
                    评估
                  </Button>
                  {judgeRes && (
                    <div style={{ marginTop: 12 }}>
                      <Tag color="blue">评分 {judgeRes.score ?? '—'} / 5</Tag>
                      <Paragraph style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{judgeRes.reason}</Paragraph>
                    </div>
                  )}
                </Card>
              </>
            ),
          },
          {
            key: 'access',
            label: '注册 / 邀请',
            children: (
              <>
                <Space style={{ marginBottom: 16 }}>
                  <span>注册方式</span>
                  <Select
                    value={regMode}
                    style={{ width: 220 }}
                    onChange={changeRegMode}
                    options={[
                      { value: 'open', label: '开放注册' },
                      { value: 'invite', label: '需要邀请码' },
                      { value: 'admin_only', label: '仅管理员添加' },
                    ]}
                  />
                  <span style={{ marginLeft: 12 }}>今日简报</span>
                  <Switch
                    checked={briefEnabled}
                    checkedChildren="开启"
                    unCheckedChildren="关闭"
                    onChange={changeBriefEnabled}
                  />
                </Space>
                <div style={{ marginBottom: 12 }}>
                  <Space>
                    <Select
                      value={inviteRole}
                      style={{ width: 120 }}
                      onChange={setInviteRole}
                      options={[
                        { value: 'member', label: '成员' },
                        { value: 'admin', label: '管理员' },
                        { value: 'guest', label: '访客' },
                      ]}
                    />
                    <Button type="primary" icon={<PlusOutlined />} onClick={createInvite}>
                      生成邀请码
                    </Button>
                  </Space>
                </div>
                <Table
                  rowKey="id"
                  dataSource={inviteList}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    { title: '邀请码', dataIndex: 'code', key: 'code', render: (v: string) => <Text code>{v}</Text> },
                    { title: '角色', dataIndex: 'role', key: 'role' },
                    { title: '状态', dataIndex: 'used', key: 'used', render: (b: boolean) => (b ? <Tag color="default">已使用</Tag> : <Tag color="green">可用</Tag>) },
                    { title: '使用者', dataIndex: 'usedBy', key: 'usedBy', render: (v: string) => v || '—' },
                    {
                      title: '操作',
                      key: 'action',
                      render: (_: any, r: any) => (
                        <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除邀请码" onClick={() => removeInvite(r.id)} disabled={r.used} />
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
        )}

      {/* 添加用户弹窗 */}
      <Modal title="添加用户" open={userModalOpen} onOk={submitUser} onCancel={() => setUserModalOpen(false)} okText="添加" cancelText="取消" width={560} destroyOnHidden>
        <Form form={userForm} layout="vertical">
          <Form.Item name="name" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
            <Input placeholder="昵称" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
            <Input placeholder="邮箱" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, min: 6, message: '至少 6 位' }]}>
            <Input.Password placeholder="密码" />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="member">
            <Select
              options={[
                { value: 'member', label: '成员' },
                { value: 'admin', label: '管理员' },
                { value: 'guest', label: '访客（只读）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="monthlyLimit" label="月度额度(Token)" initialValue={1000000}>
            <InputNumber style={{ width: '100%' }} min={0} step={10000} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 添加模型弹窗 */}
      <Modal title="添加模型" open={modelModalOpen} onOk={submitModel} onCancel={() => setModelModalOpen(false)} okText="添加" cancelText="取消" width={640} destroyOnHidden>
        <Form form={modelForm} layout="vertical">
          <Form.Item name="provider" label="供应商" initialValue="openai">
            <Select
              onChange={(p: string) => {
                const map: Record<string, string> = {
                  ollama: 'http://localhost:11434/v1',
                  openai: 'https://api.openai.com/v1',
                };
                if (map[p]) modelForm.setFieldValue('baseUrl', map[p]);
              }}
              options={[
                { value: 'openai', label: 'openai' },
                { value: 'openai-compatible', label: 'OpenAI 兼容(自定义)' },
                { value: 'ollama', label: 'ollama' },
                { value: 'deepseek', label: 'deepseek' },
                { value: 'anthropic', label: 'anthropic' },
              ]}
            />
          </Form.Item>
          <Form.Item name="name" label="模型名" rules={[{ required: true, message: '请输入模型名' }]}>
            <Input placeholder="如 gpt-4o-mini / llama3.2" />
          </Form.Item>
          <Form.Item name="baseUrl" label="baseURL" rules={[{ required: true, message: '请输入 baseURL' }]}>
            <Input placeholder="https://.../v1" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key（可空，Ollama 无需）">
            <Input.Password placeholder="sk-... 或留空" />
          </Form.Item>
          <Form.Item name="visibleRoles" label="可见角色" initialValue={['admin', 'member']}>
            <Select mode="multiple" options={[
              { value: 'admin', label: '管理员' },
              { value: 'member', label: '成员' },
              { value: 'guest', label: '访客' },
            ]} />
          </Form.Item>
          <Form.Item name="capabilities" label="能力标签" initialValue={['chat', 'tools']}>
            <Select
              mode="multiple"
              options={[
                { value: 'chat', label: 'chat 对话' },
                { value: 'tools', label: 'tools 工具调用' },
                { value: 'vision', label: 'vision 视觉' },
                { value: 'embedding', label: 'embedding 向量' },
                { value: 'rerank', label: 'rerank 重排' },
              ]}
            />
          </Form.Item>
          <Space>
            <Form.Item name="priceIn" label="输入单价(分/千token)" initialValue={0}>
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="priceOut" label="输出单价(分/千token)" initialValue={0}>
              <InputNumber min={0} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 设置 / 清除模型 Key */}
      <Modal
        title={`设置 Key · ${keyModalModel?.name || ''}`}
        open={!!keyModalModel}
        onOk={saveModelKey}
        onCancel={() => {
          setKeyModalModel(null);
          setKeyInput('');
        }}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            当前状态：{keyModalModel?.hasKey ? '已配置' : '未配置'}。Key 加密存储，页面不会回显；留空保存即清除已有 Key。
          </Text>
        </div>
        <Input.Password
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="粘贴 API Key，留空并保存表示清除"
          autoComplete="off"
        />
      </Modal>
      <Drawer
        title="用户详情"
        width={420}
        open={!!drawerUser}
        onClose={() => setDrawerUser(null)}
        extra={
          drawerUser && (
            <Button danger size="small" icon={<DeleteOutlined />} onClick={() => removeUser(drawerUser.id)}>
              删除
            </Button>
          )
        }
      >
        {drawerUser && (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="昵称">{drawerUser.name}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{drawerUser.email}</Descriptions.Item>
              <Descriptions.Item label="角色">
                <Tag color={drawerUser.role === 'admin' ? 'cyan' : 'default'}>
                  {drawerUser.role === 'admin' ? '管理员' : '成员'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={drawerUser.status === 'active' ? 'green' : 'red'}>
                  {drawerUser.status === 'active' ? '启用' : '禁用'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="月度额度">{drawerUser.monthlyLimit.toLocaleString()} Token</Descriptions.Item>
            </Descriptions>

            <Title level={5} style={{ marginTop: 24 }}>
              本月用量
            </Title>
            {userUsage ? (
              <>
                <div style={{ marginBottom: 8 }}>
                  已用 <Text strong>{userUsage.tokensUsed.toLocaleString()}</Text> / 额度{' '}
                  {userUsage.monthlyLimit.toLocaleString()}
                </div>
                <Progress
                  percent={usedPct}
                  strokeColor={usedPct > 90 ? 'var(--danger)' : usedPct > 70 ? 'var(--warning)' : 'var(--accent)'}
                />
                <Text type="secondary">周期：{userUsage.period}</Text>
              </>
            ) : (
              <Empty description="暂无用量数据" />
            )}

            <Title level={5} style={{ marginTop: 24 }}>
              快捷操作
            </Title>
            <Space wrap>
              <Button
                onClick={() =>
                  patchUser(drawerUser.id, { role: drawerUser.role === 'admin' ? 'member' : 'admin' })
                }
              >
                {drawerUser.role === 'admin' ? '降为成员' : '设为管理员'}
              </Button>
              <Button
                onClick={() =>
                  patchUser(drawerUser.id, {
                    status: drawerUser.status === 'active' ? 'disabled' : 'active',
                  })
                }
              >
                {drawerUser.status === 'active' ? '禁用' : '启用'}
              </Button>
              <Button icon={<KeyOutlined />} onClick={() => resetPassword(drawerUser)}>
                重置密码
              </Button>
            </Space>

            <Title level={5} style={{ marginTop: 24 }}>
              额度策略
            </Title>
            <Space wrap>
              <Select
                value={drawerUser.overQuotaAction}
                style={{ width: 160 }}
                onChange={(v) => patchUser(drawerUser.id, { overQuotaAction: v })}
                options={[
                  { value: 'block', label: '超限拦截' },
                  { value: 'downgrade', label: '降级继续' },
                  { value: 'warn', label: '仅告警' },
                ]}
              />
              <span style={{ color: 'var(--muted)' }}>告警阈值 %</span>
              <InputNumber
                min={0}
                max={100}
                value={drawerUser.alertThreshold}
                onChange={(v) => patchUser(drawerUser.id, { alertThreshold: Number(v) })}
              />
            </Space>
          </>
        )}
      </Drawer>
    </div>
  );
}
