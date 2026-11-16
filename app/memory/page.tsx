'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ProjectSelect from '@/components/ProjectSelect';
import { getCache, cachedJson } from '@/lib/clientCache';
import { Card, Button, Tag, Modal, Form, Input, Select, App, Space, Typography, Popconfirm, Empty, Segmented } from 'antd';
import { PlusOutlined, DeleteOutlined, BulbOutlined, EditOutlined } from '@ant-design/icons';
import { useGuest } from '@/components/SessionContext';
import { safeValidate } from '@/lib/form';

const { Title, Text, Paragraph } = Typography;

type Mem = {
  id: string;
  content: string;
  type: string;
  scope: string;
  projectId?: string | null;
  userId: string;
  ownerName?: string;
  canManage?: boolean;
  createdAt: number;
};

export default function MemoryPage() {
  const { message } = App.useApp();
  const isGuest = useGuest();
  const [list, setList] = useState<Mem[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [edit, setEdit] = useState<{ open: boolean; id: string }>({ open: false, id: '' });
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const projName = (id?: string | null) => projects.find((p) => p.id === id)?.name || '项目';

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setProjects(d))
      .catch(() => {});
  }, []);

  function openEdit(m: Mem) {
    setEdit({ open: true, id: m.id });
    editForm.setFieldsValue({ content: m.content, type: m.type, scope: m.scope, projectId: m.projectId || null });
  }

  async function submitEdit() {
    const v = await safeValidate(editForm);
    if (!v) return;
    const r = await fetch('/api/memories', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: edit.id, ...v }),
    });
    if (r.ok) {
      message.success('已更新');
      setEdit({ open: false, id: '' });
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '更新失败');
    }
  }

  async function load() {
    const c = getCache<any[]>('/api/memories');
    if (c) setList(c);
    const d = await cachedJson<any[]>('/api/memories');
    if (d) setList(d);
  }
  useEffect(() => {
    load();
  }, []);

  async function submit() {
    const v = await safeValidate(form);
    if (!v) return;
    const r = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    if (r.ok) {
      message.success('已存入记忆');
      setOpen(false);
      form.resetFields();
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '添加失败');
    }
  }

  async function remove(id: string) {
    await fetch(`/api/memories?id=${id}`, { method: 'DELETE' });
    message.success('已删除');
    load();
  }

  const shown = list.filter((m) => filter === 'all' || m.scope === filter);

  return (
    <div className="page">
        <PageHeader
          title={<><BulbOutlined /> 记忆系统</>}
          desc="事实记忆会作为「应遵守的事实/偏好」注入；情景记忆作为「相关经历/背景」参考。个人记忆仅你可用，团队记忆全团队可用。"
          extra={
            <Space>
              <Segmented
                value={filter}
                onChange={(v) => setFilter(v as string)}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '个人', value: 'personal' },
                  { label: '团队', value: 'team' },
                ]}
              />
              {isGuest ? null : (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                  添加记忆
                </Button>
              )}
            </Space>
          }
        />
      <Card>
        {shown.length === 0 && <Empty description="暂无记忆" />}
        {shown.map((m) => (
          <div
            key={m.id}
            style={{
              padding: '12px 14px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              marginBottom: 10,
              background: 'var(--bg)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.content}</Paragraph>
                <div style={{ marginTop: 8 }}>
                  <Tag color={m.scope === 'team' ? 'cyan' : 'default'}>{m.scope === 'team' ? '团队' : '个人'}</Tag>
                  <Tag>{m.type === 'fact' ? '事实' : '情景'}</Tag>
                  {m.projectId && <Tag color="blue">项目：{projName(m.projectId)}</Tag>}
                  {m.scope === 'team' && <Tag>创建者：{m.ownerName || '成员'}</Tag>}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(m.createdAt).toLocaleString()}
                  </Text>
                </div>
              </div>
              {m.canManage && !isGuest && (
                <Space size={4}>
                  <Button size="small" icon={<EditOutlined />} aria-label="编辑记忆" onClick={() => openEdit(m)} />
                  <Popconfirm title="确认删除该记忆？" okText="删除" cancelText="取消" onConfirm={() => remove(m.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除记忆" />
                  </Popconfirm>
                </Space>
              )}
            </div>
          </div>
        ))}
      </Card>

      <Modal title="添加记忆" open={open} onOk={submit} onCancel={() => setOpen(false)} okText="保存" cancelText="取消" width={560} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="content" label="记忆内容" rules={[{ required: true, message: '请输入内容' }]}>
            <Input.TextArea rows={4} placeholder="例如：用户偏好使用 TypeScript；本项目使用 Postgres + Redis" />
          </Form.Item>
          <Form.Item name="type" label="类型" initialValue="fact">
            <Select
              options={[
                { value: 'fact', label: '事实记忆（稳定事实/偏好，作为约束）' },
                { value: 'episodic', label: '情景记忆（经历/事件，作为背景参考）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="scope" label="作用域" initialValue="personal">
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

      <Modal title="编辑记忆" open={edit.open} onOk={submitEdit} onCancel={() => setEdit({ open: false, id: '' })} okText="保存" cancelText="取消" width={560} destroyOnHidden>
        <Form form={editForm} layout="vertical">
          <Form.Item name="content" label="记忆内容" rules={[{ required: true, message: '请输入内容' }]}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="type" label="类型">
            <Select
              options={[
                { value: 'fact', label: '事实记忆' },
                { value: 'episodic', label: '情景记忆' },
              ]}
            />
          </Form.Item>
          <Form.Item name="scope" label="作用域">
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
    </div>
  );
}
