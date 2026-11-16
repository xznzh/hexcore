'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ProjectSelect from '@/components/ProjectSelect';
import { getCache, cachedJson } from '@/lib/clientCache';
import { Card, Table, Button, Tag, Modal, Form, Input, Select, App, Space, Switch, Typography, Popconfirm, Drawer, Empty, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, PlayCircleOutlined, ClockCircleOutlined, HistoryOutlined } from '@ant-design/icons';
import { useGuest } from '@/components/SessionContext';
import { safeValidate } from '@/lib/form';

const { Title, Text, Paragraph } = Typography;

type Sch = {
  id: string;
  name: string;
  cron: string;
  target: string;
  skillId: string | null;
  prompt: string | null;
  scope: string;
  projectId?: string | null;
  notify: string;
  webhookUrl: string | null;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
};

export default function SchedulesPage() {
  const { message } = App.useApp();
  const isGuest = useGuest();
  const [list, setList] = useState<Sch[]>([]);
  const [open, setOpen] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const projName = (id?: string | null) => projects.find((p) => p.id === id)?.name || '项目';
  const [history, setHistory] = useState<{ open: boolean; name: string; scheduleId: string; rows: any[] }>({ open: false, name: '', scheduleId: '', rows: [] });
  const [form] = Form.useForm();
  const target = Form.useWatch('target', form);

  async function load() {
    const c = getCache<any[]>('/api/schedules');
    if (c) setList(c);
    const d = await cachedJson<any[]>('/api/schedules');
    if (d) setList(d);
  }
  useEffect(() => {
    load();
    fetch('/api/skills')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: any[]) => setSkills(d.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => {});
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setProjects(d))
      .catch(() => {});
  }, []);

  async function openHistory(s: Sch) {
    const r = await fetch(`/api/schedules/runs?id=${s.id}`);
    const rows = r.ok ? await r.json() : [];
    setHistory({ open: true, name: s.name, scheduleId: s.id, rows });
  }

  async function submit() {
    const v = await safeValidate(form);
    if (!v) return;
    const r = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    if (r.ok) {
      message.success('已创建定时任务');
      setOpen(false);
      form.resetFields();
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '创建失败');
    }
  }

  async function toggle(s: Sch) {
    await fetch('/api/schedules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id, enabled: !s.enabled }),
    });
    load();
  }

  async function remove(id: string) {
    await fetch(`/api/schedules?id=${id}`, { method: 'DELETE' });
    message.success('已删除');
    load();
  }

  async function runNow(s: { id: string }) {
    setRunBusy(s.id);
    try {
      const r = await fetch('/api/schedules/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id }),
      });
      const j = await r.json();
      if (r.ok) {
        setRunResult(j.result || '(空)');
        message.success('已执行');
        load();
      } else {
        message.error(j.error || '执行失败');
      }
    } finally {
      setRunBusy(null);
    }
  }

  const columns = [
    {
      title: '名称',
      key: 'name',
      render: (_: any, r: Sch) => (
        <Space size={4}>
          <span>{r.name}</span>
          {r.projectId && <Tag color="blue">项目：{projName(r.projectId)}</Tag>}
        </Space>
      ),
    },
    {
      title: '周期',
      dataIndex: 'cron',
      key: 'cron',
      render: (c: string) => <Tag color="blue">{c.startsWith('interval:') ? `每 ${c.split(':')[1]} 分钟` : c}</Tag>,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (b: boolean, r: Sch) => <Switch checked={b} onChange={() => toggle(r)} />,
    },
    {
      title: '上次运行',
      key: 'last',
      render: (_: any, r: Sch) => (
        <span>
          {r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : '—'}
          {r.lastStatus && <Tag color={r.lastStatus === 'ok' ? 'green' : 'red'} style={{ marginLeft: 6 }}>{r.lastStatus}</Tag>}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, r: Sch) => (
        <Space>
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => runNow(r)} loading={runBusy === r.id} disabled={!!runBusy && runBusy !== r.id}>
            立即运行
          </Button>
          <Button size="small" icon={<HistoryOutlined />} onClick={() => openHistory(r)}>
            历史
          </Button>
          {!isGuest && (
            <Popconfirm title="确认删除？" okText="删除" cancelText="取消" onConfirm={() => remove(r.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除定时任务" />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
        <PageHeader
          title={<><ClockCircleOutlined /> 定时任务</>}
          desc="周期执行一段 prompt（或技能）。服务端常驻调度器每分钟检查一次；“立即运行”用于测试。"
          extra={
            <Tooltip title={isGuest ? '访客为只读角色' : ''}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)} disabled={isGuest}>
                新建任务
              </Button>
            </Tooltip>
          }
        />
      <Card>
        <Table rowKey="id" dataSource={list} columns={columns} pagination={false} />
      </Card>

      <Modal title="新建定时任务" open={open} onOk={submit} onCancel={() => setOpen(false)} okText="创建" cancelText="取消" width={600} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="任务名" rules={[{ required: true, message: '请输入任务名' }]}>
            <Input placeholder="如：每日行业简报" />
          </Form.Item>
          <Form.Item name="cron" label="执行周期" rules={[{ required: true, message: '请填写周期' }]} initialValue="interval:60">
            <Input placeholder="interval:60 表示每 60 分钟；或标准 cron 表达式" />
          </Form.Item>
          <Form.Item name="target" label="任务类型" initialValue="prompt">
            <Select options={[{ value: 'prompt', label: '执行 prompt' }, { value: 'skill', label: '运行技能（多 Agent）' }]} />
          </Form.Item>
          {target === 'skill' ? (
            <>
              <Form.Item name="skillId" label="选择技能" rules={[{ required: true, message: '请选择技能' }]}>
                <Select options={skills.map((s) => ({ value: s.id, label: s.name }))} placeholder="选择要运行的技能" />
              </Form.Item>
              <Form.Item name="prompt" label="技能输入（可选）">
                <Input.TextArea rows={3} placeholder="交给技能处理的初始输入，留空则用任务名" />
              </Form.Item>
            </>
          ) : (
            <Form.Item name="prompt" label="执行内容（prompt）" rules={[{ required: true, message: '请输入 prompt' }]}>
              <Input.TextArea rows={4} placeholder="任务每次执行时发送给模型的提示词" />
            </Form.Item>
          )}
          <Form.Item name="notify" label="结果通知" initialValue="none">
            <Select
              options={[
                { value: 'none', label: '不通知' },
                { value: 'webhook', label: 'Webhook 推送' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p) => p.notify === 'webhook'}>
            {({ getFieldValue }) =>
              getFieldValue('notify') === 'webhook' ? (
                <Form.Item name="webhookUrl" label="Webhook URL" rules={[{ required: true, message: '请输入 URL' }]}>
                  <Input placeholder="https://..." />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="scope" label="归属" initialValue="personal">
            <Select
              options={[
                { value: 'personal', label: '个人' },
                { value: 'team', label: '团队共享' },
              ]}
            />
          </Form.Item>
          <Form.Item name="projectId" label="归属项目（可选）">
            <ProjectSelect />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="运行结果" open={!!runResult} onClose={() => setRunResult(null)} width={520}>
        <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{runResult}</Paragraph>
      </Drawer>

      <Drawer
        title={`执行历史：${history.name}`}
        open={history.open}
        onClose={() => setHistory({ open: false, name: '', scheduleId: '', rows: [] })}
        width={560}
      >
        {history.rows.length === 0 && <Empty description="暂无执行记录" />}
        {history.rows.map((r) => (
          <Card
            key={r.id}
            size="small"
            style={{ marginBottom: 10 }}
            title={
              <Space>
                <Tag color={r.status === 'ok' ? 'green' : 'red'}>{r.status === 'ok' ? '成功' : '失败'}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>{new Date(r.startedAt).toLocaleString()}</Text>
              </Space>
            }
            extra={
              <Button
                size="small"
                onClick={() => {
                  const sid = history.scheduleId;
                  setHistory({ open: false, name: '', scheduleId: '', rows: [] });
                  runNow({ id: sid });
                }}
              >
                重试
              </Button>
            }
          >
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{r.status === 'ok' ? r.result : r.error}</Paragraph>
          </Card>
        ))}
      </Drawer>
    </div>
  );
}
