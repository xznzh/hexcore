'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Form, Input, Button, App, Typography } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  async function onFinish(values: { email: string; password: string }) {
    setLoading(true);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      message.error(j.error || '登录失败');
      return;
    }
    router.push('/work');
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
            登录
          </Title>
          <Text type="secondary">登录你的智能体协作平台</Text>
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ marginTop: 16 }}>
            <Form.Item
              name="email"
              label="邮箱"
              rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
            >
              <Input placeholder="you@example.com" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password placeholder="密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">还没有账号？</Text> <Link href="/register">注册</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
