'use client';

import { useEffect, useMemo, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useMe } from '@/components/SessionContext';
import { getCache, cachedJson } from '@/lib/clientCache';
import Link from 'next/link';
import {
  Card,
  Table,
  Button,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  App,
  Space,
  Typography,
  Popconfirm,
  Drawer,
  Descriptions,
  Alert,
  Divider,
  Empty,
  Tooltip,
  Tabs,
  Checkbox,
  Dropdown,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  CloudDownloadOutlined,
  HeartOutlined,
  ReloadOutlined,
  StopOutlined,
  TeamOutlined,
  EditOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import McpToolPanel from './McpToolPanel';
import { safeValidate } from '@/lib/form';

const { Paragraph, Text } = Typography;

type Conn = {
  id: string;
  name: string;
  type: string;
  config: string;
  enabled: boolean;
  visibleRoles: string;
  status?: string;
  specUrl?: string;
  baseUrl?: string;
  healthStatus?: string;
  healthAt?: number | null;
  lastError?: string | null;
  revision?: number;
  capabilityCount?: number;
  /** V8.5：MCP 工具审批策略 */
  mcpApproval?: string;
};

type Candidate = {
  key: string;
  name: string;
  description: string;
  method: string;
  path: string;
  parameters: any[];
  inputSchema: any;
  /** 协议扩展元数据（不含密钥） */
  meta?: any;
};

type AuthScheme = {
  name: string;
  in: 'query' | 'header' | 'cookie';
  description?: string;
};

type Grant = {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectLabel?: string;
};

type RefreshPreview = {
  title: string;
  version: string;
  baseUrl: string;
  added: { key: string; name: string; method: string; path: string }[];
  updated: { key: string; name: string; method: string; path: string }[];
  unchanged: number;
  removed: { key: string; name: string }[];
};

export default function ConnectorsPage() {
  const { message, modal } = App.useApp();
  const me = useMe();
  const isAdmin = me?.role === 'admin';

  const [list, setList] = useState<Conn[]>([]);
  const [open, setOpen] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState<{ id: string; kind: 'test' | 'health' } | null>(null);
  const [form] = Form.useForm();
  /**
   * 配置示例按类型切换：MCP 只认 {url, headers, protocolVersion}，给 HTTP 的示例会误导填写。
   *
   * 不用 Form.useWatch('type', form)：该 Form 位于 Modal 内且 destroyOnHidden，
   * 首屏（弹窗未打开）时 form 实例尚未绑定任何 <Form>，useWatch 会让 antd 打
   * 「Instance created by useForm is not connected to any Form element」的 console.error，
   * Next 15 开发浮层会把它计成 Issue。改成受控 state，由 onValuesChange 同步即可。
   */
  const [addType, setAddType] = useState<string>('http');
  const isMcpType = addType === 'mcp';

  // 发现向导
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [specMode, setSpecMode] = useState<'url' | 'json'>('url');
  const [specUrl, setSpecUrl] = useState('');
  const [specText, setSpecText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [queryText, setQueryText] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [discovered, setDiscovered] = useState<{
    title: string;
    version: string;
    baseUrl: string;
    candidates: Candidate[];
  } | null>(null);
  const [authSchemes, setAuthSchemes] = useState<AuthScheme[]>([]);
  const [authValues, setAuthValues] = useState<Record<string, string>>({});
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [connName, setConnName] = useState('');
  const [visibleRoles, setVisibleRoles] = useState<string[]>(['admin', 'member']);
  /** V8.5：MCP 工具审批策略（编辑配置弹窗用；非 MCP 连接器不显示该控件） */
  const [approvalValue, setApprovalValue] = useState<'auto' | 'always' | 'never'>('auto');

  // 刷新
  const [refreshConn, setRefreshConn] = useState<Conn | null>(null);
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // 成员授权
  const [memberConn, setMemberConn] = useState<Conn | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string; email: string; role: string }[]>([]);
  const [grantType, setGrantType] = useState<'user' | 'role'>('user');
  const [grantSubject, setGrantSubject] = useState<string>('');

  // 编辑原始配置（补 appKey / 固定查询参数等）
  const [configTarget, setConfigTarget] = useState<Conn | null>(null);
  const [configText, setConfigText] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  // MCP 工具面板：仅 mcp 类型连接器可用（看工具清单 + 按 schema 试调）
  const [mcpPanel, setMcpPanel] = useState<Conn | null>(null);

  async function load() {
    const c = getCache<Conn[]>('/api/connectors');
    if (c) setList(c);
    const d = await cachedJson<Conn[]>('/api/connectors');
    if (d) setList(d);
  }
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!memberConn) return;
    fetch(`/api/connectors/${memberConn.id}/members`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setGrants(d))
      .catch(() => {});
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setUsers(d))
      .catch(() => {});
  }, [memberConn]);

  async function submit() {
    const v = await safeValidate(form);
    if (!v) return;
    let config: any = {};
    try {
      config = v.config ? JSON.parse(v.config) : {};
    } catch {
      message.error('配置必须是合法 JSON');
      return;
    }
    const r = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...v, config }),
    });
    if (r.ok) {
      message.success('已添加连接器');
      setOpen(false);
      form.resetFields();
      setAddType('http');
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '添加失败');
    }
  }

  async function test(c: Conn) {
    setTesting({ id: c.id, kind: 'test' });
    try {
      const r = await fetch('/api/connectors/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id }),
      });
      const j = await r.json();
      if (r.ok) setTestResult(j.result || '(空)');
      else message.error(j.error || '测试失败');
    } finally {
      setTesting(null);
    }
  }

  async function health(c: Conn) {
    setTesting({ id: c.id, kind: 'health' });
    try {
      const r = await fetch(`/api/connectors/${c.id}/health`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        if (j.status === 'ok') message.success(j.detail || '健康检查通过');
        else message.error(j.detail || '健康检查失败');
        load();
      } else message.error(j.error || '健康检查失败');
    } finally {
      setTesting(null);
    }
  }

  async function remove(id: string) {
    const r = await fetch(`/api/connectors?id=${id}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return message.error(j.error || '删除失败');
    if (j.credentialRevoked === false) {
      message.warning(`已删除，但远端凭据撤销失败：${j.revokeDetail || '请手动在 Provider 侧作废'}`);
    } else {
      message.success(j.removedCapabilities ? `已删除，同时移除 ${j.removedCapabilities} 个能力` : '已删除');
    }
    load();
  }

  async function revoke(c: Conn) {
    const r = await fetch(`/api/connectors/${c.id}/revoke`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return message.error(j.error || '撤销失败');
    if (j.credentialRevoked === false) {
      message.warning(`连接器已撤销，但远端凭据撤销失败：${j.revokeDetail || '请手动在 Provider 侧作废'}`);
    } else {
      message.success('已撤销连接器及其能力');
    }
    load();
  }

  // 返回三态：undefined=没填（合法，不传该字段）/ null=填了但不是 JSON 对象（调用方要中止）/ 对象=正常。
  // 之前签名只写了 `| undefined` 却在 catch 里 return null，调用方的 `=== null` 判断在类型上不成立。
  function parseHeaders(): Record<string, string> | null | undefined {
    const t = headersText.trim();
    if (!t) return undefined;
    try {
      const v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      message.error('请求头必须是 JSON 对象');
      return null;
    }
  }

  function parseQuery(): Record<string, string> | null | undefined {
    const t = queryText.trim();
    if (!t) return undefined;
    try {
      const v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      message.error('固定查询参数必须是 JSON 对象');
      return null;
    }
  }

  /** 把管理员填写的 API Key 按文档声明的 in 写入 headers / query（cookie 合并进 Cookie 头） */
  function collectAuth(baseHeaders?: Record<string, string>, baseQuery?: Record<string, string>) {
    const headers: Record<string, string> = { ...(baseHeaders || {}) };
    const query: Record<string, string> = { ...(baseQuery || {}) };
    for (const a of authSchemes) {
      const v = (authValues[a.name] || '').trim();
      if (!v) continue;
      if (a.in === 'header') headers[a.name] = v;
      else if (a.in === 'cookie') headers.Cookie = [headers.Cookie, `${a.name}=${encodeURIComponent(v)}`].filter(Boolean).join('; ');
      else query[a.name] = v;
    }
    return { headers, query };
  }

  function openConfig(c: Conn) {
    let cfg: any = {};
    try {
      cfg = JSON.parse(c.config || '{}');
    } catch {
      cfg = {};
    }
    setConfigTarget(c);
    setApprovalValue((c.mcpApproval as 'auto' | 'always' | 'never') || 'auto');
    setConfigText(JSON.stringify(cfg, null, 2));
  }

  async function saveConfig() {
    if (!configTarget) return;
    let cfg: any;
    try {
      cfg = JSON.parse(configText || '{}');
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error();
    } catch {
      message.error('配置必须是 JSON 对象');
      return;
    }
    setSavingConfig(true);
    try {
      const r = await fetch('/api/connectors', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // 非 MCP 连接器不带这个字段：PATCH 只更新传了的键，避免把 http 连接器的库值改坏
        body: JSON.stringify({
          id: configTarget.id,
          config: cfg,
          ...(configTarget.type === 'mcp' ? { mcpApproval: approvalValue } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return message.error(j.error || '保存失败');
      message.success('配置已保存，熔断状态已重置');
      setConfigTarget(null);
      load();
    } finally {
      setSavingConfig(false);
    }
  }

  /** 按当前模式取出文档地址或内联 spec；返回 null 表示校验失败（已提示） */
  function resolveSpecSource(): { specUrl?: string; spec?: any } | null {
    if (specMode === 'json') {
      const t = specText.trim();
      if (!t) {
        message.warning('请粘贴 OpenAPI JSON 文档');
        return null;
      }
      try {
        return { spec: JSON.parse(t) };
      } catch {
        message.error('OpenAPI 文档不是合法 JSON');
        return null;
      }
    }
    if (!specUrl.trim()) {
      message.warning('请填写 OpenAPI JSON 地址');
      return null;
    }
    return { specUrl: specUrl.trim() };
  }

  async function runDiscover() {
    setDiscovering(true);
    setDiscovered(null);
    try {
      const source = resolveSpecSource();
      if (!source) return;
      const headers = parseHeaders();
      if (headers === null) return;
      const r = await fetch('/api/connectors/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...source, headers, baseUrl: baseUrlInput.trim() || undefined }),
      });
      const j = await r.json();
      if (!r.ok) return message.error(j.error || '解析失败');
      setDiscovered(j);
      setAuthSchemes(Array.isArray(j.auth) ? j.auth : []);
      setAuthValues({});
      setSelectedKeys((j.candidates || []).map((x: Candidate) => x.key));
      if (!connName) setConnName(j.title || '');
      message.success(`解析到 ${j.total} 个接口`);
    } finally {
      setDiscovering(false);
    }
  }

  async function install() {
    if (!discovered) return;
    if (!connName.trim()) return message.warning('请填写连接器名称');
    if (!selectedKeys.length) return message.warning('请至少选择一个能力');
    setInstalling(true);
    try {
      const source = resolveSpecSource();
      if (!source) return;
      const headers = parseHeaders();
      if (headers === null) return;
      const query = parseQuery();
      if (query === null) return;
      const auth = collectAuth(headers, query);
      const payload = {
        name: connName.trim(),
        ...source,
        headers: auth.headers,
        query: auth.query,
        baseUrl: baseUrlInput.trim() || undefined,
        visibleRoles,
        selectedKeys,
      };
      const r = await fetch('/api/connectors/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) return message.error(j.error || '安装失败');
      message.success(`已安装 ${j.inserted + j.updated} 个能力`);
      setDiscoverOpen(false);
      setDiscovered(null);
      setSpecUrl('');
      setSpecText('');
      setHeadersText('');
      setQueryText('');
      setBaseUrlInput('');
      load();
    } finally {
      setInstalling(false);
    }
  }

  async function openRefresh(c: Conn) {
    setRefreshConn(c);
    setRefreshPreview(null);
    await loadRefreshPreview(c);
  }

  async function loadRefreshPreview(c: Conn) {
    setPreviewing(true);
    try {
      const r = await fetch(`/api/connectors/${c.id}/refresh/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        message.error(j.error || '刷新预览失败');
        setRefreshConn(null);
        return;
      }
      setRefreshPreview(j);
    } finally {
      setPreviewing(false);
    }
  }

  async function applyRefresh() {
    if (!refreshConn) return;
    setRefreshing(true);
    try {
      const r = await fetch(`/api/connectors/${refreshConn.id}/refresh/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return message.error(j.error || '应用失败');
      message.success(`刷新完成：新增 ${j.inserted}，更新 ${j.updated}，下架 ${j.disabled}`);
      setRefreshConn(null);
      setRefreshPreview(null);
      load();
    } finally {
      setRefreshing(false);
    }
  }

  async function addGrant() {
    if (!memberConn || !grantSubject) return message.warning('请选择授权对象');
    const r = await fetch(`/api/connectors/${memberConn.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectType: grantType, subjectId: grantSubject }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return message.error(j.error || '授权失败');
    setGrantSubject('');
    const d = await fetch(`/api/connectors/${memberConn.id}/members`).then((x) => x.json());
    if (Array.isArray(d)) setGrants(d);
    message.success('已授权');
  }

  async function removeGrant(grantId: string) {
    if (!memberConn) return;
    await fetch(`/api/connectors/${memberConn.id}/members?grantId=${grantId}`, { method: 'DELETE' });
    setGrants((g) => g.filter((x) => x.id !== grantId));
  }

  const filteredCandidates = useMemo(() => {
    const list = discovered?.candidates || [];
    const k = candidateSearch.trim().toLowerCase();
    if (!k) return list;
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(k) ||
        c.path.toLowerCase().includes(k) ||
        (c.description || '').toLowerCase().includes(k),
    );
  }, [discovered, candidateSearch]);

  const roleLabel: Record<string, string> = { admin: '管理员', member: '成员', guest: '访客' };
  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '类型', dataIndex: 'type', key: 'type', width: 110, render: (t: string) => <Tag>{t}</Tag> },
    {
      title: '状态',
      key: 'status',
      render: (_: any, r: Conn) => (
        <Space size={4} wrap>
          {r.status === 'revoked' ? <Tag color="red">已撤销</Tag> : <Tag color={r.enabled ? 'green' : 'default'}>{r.enabled ? '启用' : '停用'}</Tag>}
          {r.healthStatus === 'ok' && <Tag color="success">健康</Tag>}
          {r.healthStatus === 'error' && <Tag color="error">异常</Tag>}
        </Space>
      ),
    },
    {
      title: '能力',
      dataIndex: 'capabilityCount',
      key: 'capabilityCount',
      render: (n: number) => (n ? <Tag>{n} 个</Tag> : <Text type="secondary">—</Text>),
    },
    {
      title: '可见角色',
      dataIndex: 'visibleRoles',
      key: 'visibleRoles',
      render: (v: string) => (v ? (JSON.parse(v) as string[]).map((r) => roleLabel[r] || r).join('，') : ''),
    },
    {
      title: '操作',
      key: 'action',
      width: 128,
      align: 'right' as const,
      render: (_: any, r: Conn) => (
        // 主操作「测试」单列，其余（健康/刷新/配置/可见角色/撤销/删除）收进更多菜单
        <Space size={6} wrap={false}>
          {r.type === 'mcp' ? (
            <Tooltip title="查看该 MCP 暴露了哪些工具，并可填参数直接试调">
              <Button size="small" icon={<ApiOutlined />} onClick={() => setMcpPanel(r)}>
                工具
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title="调用一次，检查接口是否可用">
              <Button size="small" icon={<ThunderboltOutlined />} onClick={() => test(r)} loading={testing?.id === r.id && testing.kind === 'test'}>
                测试
              </Button>
            </Tooltip>
          )}
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'health',
                  icon: <HeartOutlined />,
                  label: '健康检查',
                  onClick: () => health(r),
                },
                ...(isAdmin && (r.specUrl || (r.capabilityCount || 0) > 0)
                  ? [{ key: 'refresh', icon: <ReloadOutlined />, label: '刷新能力', onClick: () => openRefresh(r) }]
                  : []),
                ...(isAdmin
                  ? [{ key: 'config', icon: <EditOutlined />, label: '编辑配置', onClick: () => openConfig(r) }]
                  : []),
                ...(isAdmin
                  ? [{ key: 'roles', icon: <TeamOutlined />, label: '可见角色', onClick: () => setMemberConn(r) }]
                  : []),
                ...(isAdmin
                  ? [
                      { type: 'divider' as const },
                      {
                        key: 'revoke',
                        icon: <StopOutlined />,
                        danger: true,
                        label: '撤销连接器',
                        disabled: r.status === 'revoked',
                        onClick: () =>
                          modal.confirm({
                            title: '撤销连接器？',
                            content: '撤销后该连接器及其全部能力将不可用。',
                            okText: '撤销',
                            okButtonProps: { danger: true },
                            cancelText: '取消',
                            onOk: () => revoke(r),
                          }),
                      },
                      {
                        key: 'delete',
                        icon: <DeleteOutlined />,
                        danger: true,
                        label: '删除连接器',
                        onClick: () =>
                          modal.confirm({
                            title: '彻底删除？',
                            content: '连接器及其能力会一并删除，历史调用记录保留。',
                            okText: '删除',
                            okButtonProps: { danger: true },
                            cancelText: '取消',
                            onOk: () => remove(r.id),
                          }),
                      },
                    ]
                  : []),
              ],
            }}
          >
            <Button size="small" icon={<MoreOutlined />} aria-label="连接器更多操作" />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={
          <>
            <ApiOutlined /> 连接器
          </>
        }
        desc="连接器承载三方接口与 MCP。可从 OpenAPI 文档发现能力、确认安装、健康检查、刷新差异并撤销；能力统一在「能力目录」管理与调用。"
        extra={
          isAdmin && (
            <Space>
              <Link href="/capabilities">
                <Button icon={<ThunderboltOutlined />}>能力目录</Button>
              </Link>
              <Button icon={<PlusOutlined />} onClick={() => { setAddType('http'); setOpen(true); }}>
                手动添加
              </Button>
              <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => setDiscoverOpen(true)}>
                发现并安装能力
              </Button>
            </Space>
          )
        }
      />
      <Card>
        <Table rowKey="id" dataSource={list} columns={columns} pagination={false} scroll={{ x: 980 }} />
      </Card>

      {/* 编辑连接器配置（补密钥 / 固定参数） */}
      <Modal
        title={`编辑配置${configTarget ? ` · ${configTarget.name}` : ''}`}
        open={!!configTarget}
        onOk={saveConfig}
        onCancel={() => setConfigTarget(null)}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingConfig}
        width={720}
        destroyOnHidden
      >
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {configTarget?.type === 'mcp' && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text strong>MCP 工具审批策略</Text>
              <Select
                value={approvalValue}
                onChange={(v) => setApprovalValue(v)}
                options={[
                  { value: 'auto', label: '自动：写操作审批，读操作放行' },
                  { value: 'always', label: '全部审批（管理员也要审）' },
                  { value: 'never', label: '不审批' },
                ]}
              />
              <Text type="secondary">
                审批记录进「能力 · 待审批」，管理员放行后按本次参数执行一次。选「不审批」前请确认该服务没有写副作用。
              </Text>
            </Space>
          )}
          <Alert
            type="info"
            showIcon
            message="凭证请填在 headers / query 里，调用能力时会自动带上"
            description={
              <Text type="secondary">
                例如 DemoAPI：{'{'}"query": {'{'} "appKey": "你的Key" {'}'}{'}'}；也支持 {'{'} "headers": {'{'} "appKey": "你的Key" {'}'}{'}'}。
                修改后会自动重置该连接器的熔断状态。
              </Text>
            }
          />
          <Input.TextArea
            rows={16}
            style={{ fontFamily: 'monospace' }}
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
          />
        </Space>
      </Modal>

      {/* 手动添加 */}
      <Modal title="添加连接器" open={open} onOk={submit} onCancel={() => setOpen(false)} okText="添加" cancelText="取消" width={560} destroyOnHidden>
        <Form form={form} layout="vertical" onValuesChange={(_, all) => setAddType(all.type ?? 'http')}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：内部天气 API" />
          </Form.Item>
          <Form.Item name="type" label="类型" initialValue="http" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'http', label: 'HTTP 请求' },
                { value: 'db', label: '数据库（只读 SQL，配置 {connectionString, query}）' },
                { value: 'builtin:file', label: '内置：读取文件（配置 {"fileId":"..."}）' },
                { value: 'builtin:sandbox', label: '内置：代码沙箱（配置 {code}）' },
                { value: 'browser', label: '浏览器抓取（Playwright，配置 {url}）' },
                { value: 'mcp', label: 'MCP 端点（对话中自动获得其工具）' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="config"
            label="配置（JSON）"
            rules={[{ required: true, message: '请填写 JSON 配置' }]}
            extra={
              isMcpType
                ? '必填 url（就是 MCP 服务端地址，通常以 /mcp 结尾）；headers 填服务端要求的认证头；protocolVersion 可省略，默认 2025-06-18。保存后点该行的「工具」能列出清单，说明握手成功。'
                : '① {{input}} 占位符：模型参数会替换到 url / body / headers。② 字段映射：extract 取子树、pick 提取并重命名（支持 path/100 缩放）、limit 截断数组。③ 腾讯/新浪行情返回 GBK 文本，已自动解码。'
            }
          >
            <Input.TextArea
              rows={6}
              placeholder={
                isMcpType
                  ? '{\n  "url": "https://mcp.example.com/mcp",\n  "headers": { "Authorization": "Bearer <你的 token>" }\n}'
                  : '{\n  "method": "GET",\n  "url": "https://api.example.com/quotes?code={{input}}",\n  "headers": { "Authorization": "Bearer xxx" },\n  "extract": "data.diff",\n  "pick": { "代码": "f12", "名称": "f14", "现价": "f2/100", "涨跌幅": "f3/100" },\n  "limit": 20\n}'
              }
            />
          </Form.Item>
          <Form.Item name="visibleRoles" label="可见角色" initialValue={['admin', 'member']}>
            <Select mode="multiple" options={[{ value: 'admin', label: '管理员' }, { value: 'member', label: '成员' }]} />
          </Form.Item>
          {isMcpType && (
            <Form.Item
              name="mcpApproval"
              label="MCP 工具审批"
              initialValue="auto"
              extra="写语义工具（create / delete / run…）与认不出来的工具需要管理员在「能力 · 待审批」放行；读语义工具（get / list / search…）直接执行。"
            >
              <Select
                options={[
                  { value: 'auto', label: '自动：写操作审批，读操作放行' },
                  { value: 'always', label: '全部审批（管理员也要审，给高危服务用）' },
                  { value: 'never', label: '不审批（已确认该服务无副作用）' },
                ]}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 从 OpenAPI 发现 */}
      <Drawer
        title="发现并安装能力"
        open={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        width={960}
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="支持 OpenAPI 3.x / Swagger 2.0 的 JSON 文档"
            description="发现过程只读，不会修改数据；确认安装后才会写入连接器与能力。"
          />
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Tabs
              size="small"
              activeKey={specMode}
              onChange={(k) => {
                setSpecMode(k as 'url' | 'json');
                setDiscovered(null);
              }}
              items={[
                {
                  key: 'url',
                  label: '文档地址',
                  children: (
                    <Input
                      placeholder="OpenAPI 地址，如 https://api.example.com/openapi.json"
                      value={specUrl}
                      onChange={(e) => setSpecUrl(e.target.value)}
                    />
                  ),
                },
                {
                  key: 'json',
                  label: '粘贴 JSON',
                  children: (
                    <Space direction="vertical" size="small" style={{ width: '100%' }}>
                      <Text type="secondary">
                        离线场景可用：粘贴 OpenAPI / Swagger 的 JSON 全文。安装后会缓存到连接器配置，后续刷新无需再次粘贴。
                      </Text>
                      <Input.TextArea
                        rows={10}
                        style={{ fontFamily: 'monospace' }}
                        placeholder={'{\n  "openapi": "3.0.0",\n  "info": { "title": "示例 API", "version": "1.0.0" },\n  "paths": { ... }\n}'}
                        value={specText}
                        onChange={(e) => setSpecText(e.target.value)}
                      />
                    </Space>
                  ),
                },
              ]}
            />
            <Input
              placeholder="接口基地址（可选，留空则用文档 servers / spec 地址推导）"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
            />
            <Input.TextArea
              rows={3}
              placeholder={'可选：请求头 JSON，如 {"Authorization":"Bearer xxx"}'}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
            />
            <Input.TextArea
              rows={3}
              placeholder={'可选：固定查询参数 JSON，如 {"appKey":"xxx"}（接口自身参数优先，避免覆盖调用入参）'}
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
            />
          </Space>
          <Button type="primary" onClick={runDiscover} loading={discovering} icon={<CloudDownloadOutlined />}>
            解析文档
          </Button>

          {discovered && (
            <>
              <Divider />
              <Descriptions size="small" column={3}>
                <Descriptions.Item label="文档">{discovered.title}</Descriptions.Item>
                <Descriptions.Item label="版本">{discovered.version || '—'}</Descriptions.Item>
                <Descriptions.Item label="基地址">{discovered.baseUrl || '—'}</Descriptions.Item>
              </Descriptions>
              {authSchemes.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message="该文档要求 API Key 认证"
                  description={
                    <Space direction="vertical" size="small" style={{ width: '100%' }}>
                      <Text type="secondary">
                        填写后会自动写入连接器的 {authSchemes.map((a) => `${a.in}.${a.name}`).join('、')}，不必每次调用都传。
                      </Text>
                      {authSchemes.map((a) => (
                        <Input.Password
                          key={`${a.in}:${a.name}`}
                          addonBefore={`${a.name}（${a.in}）`}
                          placeholder={a.description || '填写 API Key'}
                          value={authValues[a.name] || ''}
                          onChange={(e) => setAuthValues((prev) => ({ ...prev, [a.name]: e.target.value }))}
                        />
                      ))}
                    </Space>
                  }
                />
              )}
              <Input.Search
                placeholder="搜索接口名 / 路径 / 说明"
                allowClear
                value={candidateSearch}
                onChange={(e) => setCandidateSearch(e.target.value)}
              />
              <Table
                rowKey="key"
                size="small"
                dataSource={filteredCandidates}
                pagination={{ pageSize: 8, showSizeChanger: false }}
                rowSelection={{
                  selectedRowKeys: selectedKeys,
                  onChange: (keys) => setSelectedKeys(keys as string[]),
                }}
                columns={[
                  { title: '能力名', dataIndex: 'name', key: 'name', width: 180 },
                  {
                    title: '方法',
                    dataIndex: 'method',
                    key: 'method',
                    width: 80,
                    render: (m: string) => <Tag color="blue">{m}</Tag>,
                  },
                  { title: '路径', dataIndex: 'path', key: 'path', width: 260 },
                  {
                    title: '说明',
                    dataIndex: 'description',
                    key: 'description',
                    ellipsis: true,
                  },
                ]}
              />
              <Divider />
              <Form layout="vertical">
                <Form.Item label="连接器名称" required>
                  <Input value={connName} onChange={(e) => setConnName(e.target.value)} placeholder="如：订单系统" />
                </Form.Item>
                <Form.Item label="可见角色">
                  <Select
                    mode="multiple"
                    value={visibleRoles}
                    onChange={setVisibleRoles}
                    options={[
                      { value: 'admin', label: '管理员' },
                      { value: 'member', label: '成员' },
                    ]}
                  />
                </Form.Item>
              </Form>
              <Button type="primary" onClick={install} loading={installing}>
                安装所选 {selectedKeys.length} 个能力
              </Button>
            </>
          )}
        </Space>
      </Drawer>

      {/* 刷新预览 */}
      <Modal
        title={refreshConn ? `刷新连接器：${refreshConn.name}` : '刷新连接器'}
        open={!!refreshConn}
        onCancel={() => {
          setRefreshConn(null);
          setRefreshPreview(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setRefreshConn(null);
                setRefreshPreview(null);
              }}
            >
              取消
            </Button>
            <Button type="primary" onClick={applyRefresh} loading={refreshing} disabled={!refreshPreview}>
              应用变更
            </Button>
          </Space>
        }
        width={720}
      >
        {!refreshPreview ? (
          <Empty description="正在对比最新文档…" />
        ) : (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={`文档：${refreshPreview.title} ${refreshPreview.version || ''}`}
              description={`新增 ${refreshPreview.added.length}，变更 ${refreshPreview.updated.length}，未变 ${refreshPreview.unchanged}，下架 ${refreshPreview.removed.length}`}
            />
            {refreshPreview.added.length > 0 && (
              <div>
                <Text strong>新增能力</Text>
                <Paragraph type="secondary" style={{ marginBottom: 4 }}>
                  {refreshPreview.added.map((x) => `${x.method} ${x.path}`).join('；')}
                </Paragraph>
              </div>
            )}
            {refreshPreview.updated.length > 0 && (
              <div>
                <Text strong>结构变更</Text>
                <Paragraph type="secondary" style={{ marginBottom: 4 }}>
                  {refreshPreview.updated.map((x) => `${x.method} ${x.path}`).join('；')}
                </Paragraph>
              </div>
            )}
            {refreshPreview.removed.length > 0 && (
              <div>
                <Text strong>文档中已移除（将置为停用）</Text>
                <Paragraph type="secondary" style={{ marginBottom: 4 }}>
                  {refreshPreview.removed.map((x) => x.name).join('；')}
                </Paragraph>
              </div>
            )}
            {!refreshPreview.added.length && !refreshPreview.updated.length && !refreshPreview.removed.length && (
              <Empty description="文档没有变化" />
            )}
            <Text type="secondary">管理员配置（审批、权限、响应映射）在刷新时会保留。</Text>
          </Space>
        )}
      </Modal>

      {/* 成员授权 */}
      <Drawer title={memberConn ? `成员授权：${memberConn.name}` : '成员授权'} open={!!memberConn} onClose={() => setMemberConn(null)} width={520}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="授权白名单"
            description="添加授权后，只有名单内的用户或角色可调用该连接器（管理员始终可用）。未添加任何授权时，按「可见角色」放行。"
          />
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
            locale={{ emptyText: '暂无授权（当前按可见角色放行）' }}
            columns={[
              {
                title: '类型',
                dataIndex: 'subjectType',
                key: 'subjectType',
                width: 80,
                render: (t: string) => <Tag>{t === 'role' ? '角色' : '用户'}</Tag>,
              },
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

      <Drawer title="测试结果" open={!!testResult} onClose={() => setTestResult(null)} width="min(560px, 92vw)">
        <pre className="result-block" style={{ maxHeight: 420 }}>
          {testResult || '—'}
        </pre>
      </Drawer>

      <McpToolPanel open={!!mcpPanel} connector={mcpPanel ? { id: mcpPanel.id, name: mcpPanel.name } : null} onClose={() => setMcpPanel(null)} />
    </div>
  );
}
