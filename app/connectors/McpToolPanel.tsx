'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined, ThunderboltOutlined, ApiOutlined, ExclamationCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

type JsonSchemaProp = {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type?: string };
};

type McpTool = {
  name: string;
  /** 模型在对话里实际看到的函数名，由服务端按命名规则算出（不是前端拼的） */
  chatName?: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
    [k: string]: unknown;
  };
};

type CallResult = { ok: boolean; isError?: boolean; text?: string; error?: string; durationMs?: number };

type Props = {
  open: boolean;
  connector: { id: string; name: string } | null;
  onClose: () => void;
};

/** 参数 schema → 表单控件类型。只区分四类，嵌套结构退化为 JSON 文本 */
function fieldKind(p: JsonSchemaProp): 'enum' | 'number' | 'boolean' | 'json' | 'text' {
  if (Array.isArray(p?.enum) && p.enum.length) return 'enum';
  const t = String(p?.type || '');
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object' || t === 'array') return 'json';
  return 'text';
}

/** 把表单值组装成工具入参：json 字段要反序列化，空值一律不传 */
function buildArgs(values: Record<string, unknown>, props: Record<string, JsonSchemaProp>): { args: Record<string, unknown>; bad: string[] } {
  const args: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    const kind = fieldKind(props[k] || {});
    if (kind === 'json') {
      if (typeof v === 'string') {
        try {
          args[k] = JSON.parse(v);
        } catch {
          bad.push(k);
        }
      } else {
        args[k] = v;
      }
    } else {
      args[k] = v;
    }
  }
  return { args, bad };
}

export default function McpToolPanel({ open, connector, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tools, setTools] = useState<McpTool[]>([]);
  const [meta, setMeta] = useState<{ url?: string; serverInfo?: { name?: string; version?: string } | null; protocolVersion?: string | null }>({});
  const [picked, setPicked] = useState<McpTool | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      if (!connector) return;
      setLoading(true);
      setError('');
      try {
        const r = await fetch('/api/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectorId: connector.id, action: 'tools', force }),
        });
        const j = await r.json();
        if (!r.ok || !j?.ok) {
          setError(String(j?.error || `请求失败（HTTP ${r.status}）`));
          setTools([]);
        } else {
          setTools((j.tools || []) as McpTool[]);
          setMeta({ url: j.url, serverInfo: j.serverInfo, protocolVersion: j.protocolVersion });
        }
      } catch (e: any) {
        setError(String(e?.message || e));
        setTools([]);
      } finally {
        setLoading(false);
      }
    },
    [connector],
  );

  // 打开时拉一次；关闭时清掉，避免下次看到上一条连接器的残留
  useEffect(() => {
    if (open && connector) load(false);
    if (!open) {
      setTools([]);
      setMeta({});
      setError('');
      setPicked(null);
    }
  }, [open, connector, load]);

  const columns = useMemo(
    () => [
      {
        title: '工具名',
        dataIndex: 'name',
        key: 'name',
        width: 185,
        ellipsis: true,
        render: (v: string) => <Text code>{v}</Text>,
      },
      {
        title: (
          <Tooltip title="模型在对话中实际看到的函数名，形如 mcp__<连接器>__<工具>；中文或特殊字符会被净化">
            <span>对话中的工具名</span>
          </Tooltip>
        ),
        dataIndex: 'chatName',
        key: 'chatName',
        width: 275,
        render: (_: unknown, t: McpTool) => {
          const chatName = t.chatName || '';
          if (!chatName) return <Text type="secondary">—</Text>;
          // 与「原始名字直接拼出来」的结果不一致，就说明被净化过（空格、中文、'/' 等都会被改写）。
          // 这里只做字符串比较，命名规则本身仍然只在服务端实现一处。
          const renamed = chatName !== `mcp__${connector?.name || ''}__${t.name}`;
          return (
            <Tooltip
              title={
                renamed
                  ? `${chatName}\n原工具名含中文、空格或特殊字符，已按函数名规范净化——名字一样的工具会互相覆盖`
                  : chatName
              }
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                <Text
                  code
                  style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {chatName}
                </Text>
                {renamed ? (
                  <ExclamationCircleOutlined style={{ color: 'var(--warning)', fontSize: 12, flexShrink: 0 }} />
                ) : null}
              </div>
            </Tooltip>
          );
        },
      },
      {
        title: '参数',
        key: 'params',
        width: 175,
        ellipsis: true,
        render: (_: unknown, t: McpTool) => {
          const props = t.inputSchema?.properties || {};
          const req = new Set(t.inputSchema?.required || []);
          const names = Object.keys(props);
          if (!names.length) return <Text type="secondary">无参数</Text>;
          return (
            <Space size={4} wrap>
              {names.map((n) => (
                <Tag key={n} color={req.has(n) ? 'blue' : 'default'}>
                  {n}
                  {req.has(n) ? ' *' : ''}
                </Tag>
              ))}
            </Space>
          );
        },
      },
      {
        title: '说明',
        dataIndex: 'description',
        key: 'description',
        ellipsis: true,
        render: (v: string) => v || <Text type="secondary">—</Text>,
      },
      {
        title: '操作',
        key: 'act',
        width: 84,
        align: 'right' as const,
        render: (_: unknown, t: McpTool) => (
          <Button size="small" icon={<ThunderboltOutlined />} onClick={() => setPicked(t)}>
            试调
          </Button>
        ),
      },
    ],
    [connector?.name],
  );

  return (
    <>
      <Drawer
        title={connector ? `MCP 工具：${connector.name}` : 'MCP 工具'}
        open={open}
        onClose={onClose}
        width={980}
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>
            重新获取
          </Button>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="服务" span={1}>
              {meta.serverInfo?.name ? (
                <Space size={6}>
                  <ApiOutlined />
                  <Text>{meta.serverInfo.name}</Text>
                  <Tag>{meta.serverInfo.version || '—'}</Tag>
                </Space>
              ) : (
                <Text type="secondary">—</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="协议版本" span={1}>
              {meta.protocolVersion ? <Tag color="cyan">{meta.protocolVersion}</Tag> : <Text type="secondary">—</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="端点" span={2}>
              <Text ellipsis style={{ maxWidth: 620 }}>
                {meta.url || '—'}
              </Text>
            </Descriptions.Item>
          </Descriptions>

          {error ? (
            <Alert
              type="error"
              showIcon
              message="获取工具失败"
              description={
                <Space direction="vertical" size={4}>
                  <Text>{error}</Text>
                  <Text type="secondary">
                    常见原因：地址还是文档示例（example.com）没换成真实地址、地址不是 MCP 端点、对端不支持 Streamable HTTP、或服务在私网被安全策略拦下。
                  </Text>
                </Space>
              }
              action={
                <Button size="small" onClick={() => load(true)}>
                  重试
                </Button>
              }
            />
          ) : null}

          {loading && !tools.length ? (
            <div style={{ padding: '48px 0', textAlign: 'center' }}>
              <Spin tip="正在握手并读取工具清单…">
                <div style={{ height: 48 }} />
              </Spin>
            </div>
          ) : null}

          {!loading && !error && !tools.length ? (
            <Empty description="该端点没有暴露任何工具" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : null}

          {tools.length ? (
            <Table
              rowKey="name"
              size="small"
              tableLayout="fixed"
              dataSource={tools}
              columns={columns as any}
              pagination={false}
              expandable={{
                expandedRowRender: (t: McpTool) => (
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      background: 'var(--result-bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      maxHeight: 240,
                      overflow: 'auto',
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: 'var(--text-secondary)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {JSON.stringify(t.inputSchema || {}, null, 2)}
                  </pre>
                ),
                rowExpandable: (t: McpTool) => Boolean(t.inputSchema?.properties && Object.keys(t.inputSchema.properties).length),
              }}
            />
          ) : null}

          {tools.length ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              展开行可查看完整参数 schema。第三列是模型在对话里看到的函数名（中间段接连接器名、末段是工具名）；
              中文、空格、&apos;/&apos; 会被净化成 ASCII，整段没有可用字符时用 <Text code>t_xx</Text> 短哈希代替。
              名字后面带 <ExclamationCircleOutlined style={{ color: 'var(--warning)' }} /> 说明发生过净化，
              净化后可能与别的连接器撞名——撞名时只有先注册的那个能用，日志里会记一条「工具名冲突」。
            </Text>
          ) : null}
        </Space>
      </Drawer>

      <McpCallModal connectorId={connector?.id || ''} tool={picked} onClose={() => setPicked(null)} />
    </>
  );
}

function McpCallModal({ connectorId, tool, onClose }: { connectorId: string; tool: McpTool | null; onClose: () => void }) {
  const [form] = Form.useForm();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);

  const props = (tool?.inputSchema?.properties || {}) as Record<string, JsonSchemaProp>;
  const required = new Set(tool?.inputSchema?.required || []);

  /**
   * 上一个打开过的工具：用来区分「首次挂载」与「弹窗关闭后重置」。
   * 首次挂载时 tool 为 null、Modal 未渲染、form 还没绑定任何 <Form>，
   * 此时调 resetFields 会触发 antd「useForm is not connected to any Form element」告警
   * （Next 15 开发浮层会把它计成 Issue）。只有真正打开过再关闭，才需要清空。
   */
  const prevToolRef = useRef<McpTool | null>(null);

  useEffect(() => {
    if (!tool) {
      setResult(null);
      if (prevToolRef.current) form.resetFields();
    }
    prevToolRef.current = tool;
  }, [tool, form]);

  const submit = async () => {
    if (!tool) return;
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const { args, bad } = buildArgs(values, props);
    if (bad.length) {
      setResult({ ok: false, error: `这些字段不是合法 JSON：${bad.join('、')}` });
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId, action: 'call', name: tool.name, args }),
      });
      const j = await r.json();
      setResult({
        ok: Boolean(j?.ok),
        isError: j?.isError,
        text: typeof j?.text === 'string' ? j.text : undefined,
        error: j?.error ? String(j.error) : undefined,
        durationMs: j?.durationMs,
      });
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={tool ? `试调：${tool.name}` : '试调'}
      open={!!tool}
      onCancel={onClose}
      width={680}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={running} onClick={submit}>
            调用
          </Button>
        </Space>
      }
    >
      {tool?.description ? (
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          {tool.description}
        </Text>
      ) : null}

      <Form form={form} layout="vertical" size="small">
        {Object.entries(props).map(([name, p]) => {
          const kind = fieldKind(p);
          const label = (
            <Space size={6}>
              <Text>{name}</Text>
              {required.has(name) ? <Tag color="red">必填</Tag> : null}
              {p.type ? <Tag>{p.type}</Tag> : null}
            </Space>
          );
          const tip = p.description ? <Text type="secondary" style={{ fontSize: 12 }}>{p.description}</Text> : undefined;
          // key 不能塞进 common 再展开：React 19 起「展开 props 携带 key」会被忽略并告警，
          // 列表项因此失去稳定标识（参数表单重渲染时输入框会丢焦点）。
          const common = { name, label, extra: tip, rules: required.has(name) ? [{ required: true, message: `请填写 ${name}` }] : undefined };

          if (kind === 'enum') {
            return (
              <Form.Item key={name} {...common}>
                <Select allowClear options={(p.enum || []).map((v) => ({ value: v, label: v }))} placeholder="请选择" />
              </Form.Item>
            );
          }
          if (kind === 'number') {
            return (
              <Form.Item key={name} {...common}>
                <InputNumber style={{ width: '100%' }} placeholder={p.type === 'integer' ? '整数' : '数字'} />
              </Form.Item>
            );
          }
          if (kind === 'boolean') {
            return (
              <Form.Item key={name} {...common} valuePropName="checked" initialValue={false}>
                <Switch />
              </Form.Item>
            );
          }
          if (kind === 'json') {
            return (
              <Form.Item key={name} {...common} tooltip='按 JSON 填写，例如 ["a","b"] 或 {"k":1}'>
                <Input.TextArea rows={3} placeholder={p.type === 'array' ? '["a","b"]' : '{"k":1}'} />
              </Form.Item>
            );
          }
          return (
            <Form.Item key={name} {...common}>
              <Input placeholder="文本" />
            </Form.Item>
          );
        })}
        {!Object.keys(props).length ? <Text type="secondary">该工具无需参数</Text> : null}
      </Form>

      {result ? (
        <div style={{ marginTop: 12 }}>
          <Space size={8} style={{ marginBottom: 6 }}>
            <Tag color={result.ok ? 'green' : result.isError ? 'orange' : 'red'}>
              {result.ok ? '调用成功' : result.isError ? '业务失败（isError）' : '调用失败'}
            </Tag>
            {typeof result.durationMs === 'number' ? <Text type="secondary">{result.durationMs}ms</Text> : null}
          </Space>
          <Tooltip title="返回内容会原样展示，包含服务端的报错原文">
            <pre
              style={{
                margin: 0,
                padding: 12,
                background: 'var(--result-bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                maxHeight: 300,
                overflow: 'auto',
                fontSize: 12,
                lineHeight: 1.65,
                whiteSpace: 'pre-wrap',
                color: 'var(--text-secondary)',
              }}
            >
              {result.text || result.error || '(空)'}
            </pre>
          </Tooltip>
        </div>
      ) : null}
    </Modal>
  );
}
