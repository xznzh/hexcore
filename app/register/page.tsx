'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Form, Input, Button, App, Typography } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

export default function RegisterPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'open' | 'invite' | 'admin_only'>('open');
  const [form] = Form.useForm();

  useEffect(() => {
    fetch('/api/auth/register-mode')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setMode(d.mode))
      .catch(() => {});
  }, []);

  async function onFinish(values: { name: string; email: string; password: string; inviteCode?: string }) {
    setLoading(true);
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      message.error(j.error || '注册失败');
      return;
    }
    message.success('注册成功，首位注册者自动成为管理员');
    router.push('/chat');
  }

  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <div className="logo">
          <ThunderboltOutlined /> AI Agent Platform
        </div>
        <h1>你的智能体协作工作台</h1>
        <p>
          聚合对话、知识库、文件、技能编排与定时任务，让 AI 真正融入团队工作流。统一接入大模型，沉淀长期记忆，规模化落地业务智能。
        </p>
      </div>
      <div className="auth-form">
        <Card className="auth-card">
          <div className="logo" style={{ marginBottom: 18, color: 'var(--accent)' }}>
            <ThunderboltOutlined /> AI Agent Platform
          </div>
          <Title level={4} style={{ marginTop: 0 }}>
            注册
          </Title>
          <Text type="secondary">创建你的账号</Text>
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ marginTop: 16 }}>
            <Form.Item name="name" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
              <Input placeholder="昵称" />
            </Form.Item>
            <Form.Item
              name="email"
              label="邮箱"
              rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
            >
              <Input placeholder="you@example.com" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, min: 6, message: '至少 6 位' }]}>
              <Input.Password placeholder="至少 6 位" />
            </Form.Item>
            {mode === 'invite' && (
              <Form.Item name="inviteCode" label="邀请码" rules={[{ required: true, message: '请输入邀请码' }]}>
                <Input placeholder="请输入管理员提供的邀请码" />
              </Form.Item>
            )}
            {mode === 'admin_only' && (
              <div style={{ marginBottom: 12, color: 'var(--muted)', fontSize: 12 }}>当前注册已关闭，请联系管理员添加账号。</div>
            )}
            <Button type="primary" htmlType="submit" block loading={loading} disabled={mode === 'admin_only'}>
              注册
            </Button>
          </Form>
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">已有账号？</Text> <Link href="/login">登录</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
