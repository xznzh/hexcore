'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { useMe, useGuest } from '@/components/SessionContext';
import { getCache, cachedJson } from '@/lib/clientCache';
import { Card, Table, Button, Tag, Modal, Form, Input, Select, App, Space, Typography, Drawer, Descriptions, List } from 'antd';
import { PlusOutlined, FolderOutlined, DeleteOutlined } from '@ant-design/icons';
import { safeValidate } from '@/lib/form';

const { Title, Text, Paragraph } = Typography;

type Project = {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  visibility: string;
  isMember: boolean;
};

export default function ProjectsPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const me = useMe();
  const isGuest = useGuest();
  const [list, setList] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [directory, setDirectory] = useState<{ id: string; name: string; email: string }[]>([]);
  const [addMemberId, setAddMemberId] = useState<string>('');
  const [form] = Form.useForm();

  async function load() {
    const c = getCache<any[]>('/api/projects');
    if (c) setList(c);
    const d = await cachedJson<any[]>('/api/projects');
    if (d) setList(d);
  }
  useEffect(() => {
    load();
    fetch('/api/users')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setDirectory(d))
      .catch(() => {});
  }, []);

  async function reloadDetail(id: string) {
    const r = await fetch(`/api/projects/${id}`);
    if (r.ok) setDetail(await r.json());
  }

  async function addMember() {
    if (!detail || !addMemberId) return;
    await fetch(`/api/projects/${detail.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: addMemberId }),
    });
    setAddMemberId('');
    message.success('已添加成员');
    reloadDetail(detail.id);
  }

  async function removeMember(uid: string) {
    if (!detail) return;
    await fetch(`/api/projects/${detail.id}/members?userId=${uid}`, { method: 'DELETE' });
    message.success('已移除');
    reloadDetail(detail.id);
  }

  async function submit() {
    const v = await safeValidate(form);
    if (!v) return;
    const r = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    if (r.ok) {
      message.success('已创建项目');
      setOpen(false);
      form.resetFields();
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '创建失败');
    }
  }

  async function remove(id: string) {
    await fetch(`/api/projects?id=${id}`, { method: 'DELETE' });
    message.success('已删除');
    load();
  }

  async function openDetail(p: Project) {
    const r = await fetch(`/api/projects/${p.id}`);
    if (r.ok) setDetail(await r.json());
  }

  async function startConvInProject(p: Project) {
    const r = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: p.id, title: `「${p.name}」的会话` }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.id) router.push(`/chat?conv=${j.id}`);
    else message.error('创建会话失败');
  }

  const columns = [
    {
      title: '项目',
      key: 'name',
      render: (_: any, r: Project) => (
        <a onClick={() => openDetail(r)}>
          <FolderOutlined style={{ color: 'var(--accent)', marginRight: 8 }} />
          <strong>{r.name}</strong>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.description || '暂无描述'}
            </Text>
          </div>
        </a>
      ),
    },
    {
      title: '可见性',
      dataIndex: 'visibility',
      key: 'visibility',
      render: (v: string) => <Tag color={v === 'team' ? 'cyan' : v === 'members' ? 'blue' : 'default'}>{v === 'team' ? '团队' : v === 'members' ? '指定成员' : '个人'}</Tag>,
    },
    {
      title: '我的角色',
      key: 'role',
      render: (_: any, r: Project) => (r.ownerId === 'me' ? '' : r.isMember ? <Tag>成员</Tag> : <Tag>可加入</Tag>),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, r: Project) => (
        <Space>
          <Button size="small" onClick={() => openDetail(r)}>
            详情
          </Button>
          {(r.ownerId === me?.userId || me?.role === 'admin') && (
            <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除项目" onClick={() => remove(r.id)} />
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
        <PageHeader
          title={<><FolderOutlined /> 项目</>}
          desc="项目是「会话 + 文件 + 知识库 + 成员」的聚合容器，便于小团队协作。"
          extra={
            isGuest ? (
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>访客为只读角色，仅可查看可加入的项目</span>
            ) : (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                新建项目
              </Button>
            )
          }
        />
        <Card>
        <Table rowKey="id" dataSource={list} columns={columns} pagination={false} />
      </Card>

      <Modal title="新建项目" open={open} onOk={submit} onCancel={() => setOpen(false)} okText="创建" cancelText="取消" width={560} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：Q4 增长专项" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="项目目标 / 范围" />
          </Form.Item>
          <Form.Item name="visibility" label="可见性" initialValue="team">
            <Select
              options={[
                { value: 'personal', label: '个人' },
                { value: 'members', label: '指定成员' },
                { value: 'team', label: '团队' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="项目详情" open={!!detail} onClose={() => setDetail(null)} width={520}>
        {detail && (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="名称">{detail.name}</Descriptions.Item>
              <Descriptions.Item label="描述">{detail.description || '—'}</Descriptions.Item>
              <Descriptions.Item label="可见性">{detail.visibility === 'team' ? '团队' : detail.visibility === 'members' ? '指定成员' : '个人（仅自己）'}</Descriptions.Item>
            </Descriptions>
            <Title level={5} style={{ marginTop: 20 }}>
              成员（{detail.members?.length || 0}）
            </Title>
            {detail.visibility === 'personal' ? (
              <Text type="secondary">个人项目为私有，不共享给其他成员。如需团队协作，请把可见性改为「指定成员」或「团队」。</Text>
            ) : detail.ownerId === me?.userId || me?.role === 'admin' ? (
              <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
                <Select
                  style={{ flex: 1 }}
                  value={addMemberId || undefined}
                  onChange={setAddMemberId}
                  placeholder="选择成员"
                  options={directory
                    .filter((d) => !(detail.members || []).some((m: any) => m.id === d.id))
                    .map((d) => ({ value: d.id, label: `${d.name}（${d.email}）` }))}
                />
                <Button type="primary" onClick={addMember}>
                  添加
                </Button>
              </Space.Compact>
            ) : (
              <Text type="secondary">成员由「项目创建者或管理员」管理，你只能查看。</Text>
            )}
            <List
              size="small"
              dataSource={detail.members || []}
              renderItem={(m: any) => (
                <List.Item
                  actions={
                    detail.visibility !== 'personal' && (detail.ownerId === me?.userId || me?.role === 'admin')
                      ? [<a key="rm" onClick={() => removeMember(m.id)}>移除</a>]
                      : []
                  }
                >
                  {m.name} <Text type="secondary">({m.email})</Text>
                </List.Item>
              )}
            />
            <Title level={5} style={{ marginTop: 20 }}>
              项目文件（{detail.files?.length || 0}）
            </Title>
            <List
              size="small"
              dataSource={detail.files || []}
              renderItem={(f: any) => <List.Item>{f.filename}</List.Item>}
            />
            <Title level={5} style={{ marginTop: 20 }}>
              产物（{detail.artifacts?.length || 0}）
            </Title>
            <List
              size="small"
              dataSource={detail.artifacts || []}
              renderItem={(a: any) => (
                <List.Item actions={[<a key="d" href={`/api/artifacts/${a.id}`}>下载</a>]}>
                  <Tag color={a.type === 'ppt' ? 'blue' : 'green'}>{a.type === 'ppt' ? 'PPT' : '文档'}</Tag>
                  {a.title || a.filename}
                </List.Item>
              )}
            />
            <Button style={{ marginTop: 20 }} type="primary" onClick={() => startConvInProject(detail)}>
              发起会话
            </Button>
          </>
        )}
      </Drawer>
    </div>
  );
}
