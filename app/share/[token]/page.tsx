'use client';

import { use, useEffect, useState } from 'react';
import { Alert, Button, Space, Spin, Tag, Typography } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const { Title, Text } = Typography;

type Msg = { id: string; role: string; content: string; sources?: string[]; createdAt?: number };

export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  // Client Component 不能用 await，Next 15 起 params 是 Promise，
  // 官方约定用 React.use() 解包（会参与 Suspense 边界）。
  const { token } = use(params);
  const [data, setData] = useState<{ title: string; ownerName: string; messages: Msg[] } | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) setError(j.error || '加载失败');
        else setData(j);
      })
      .catch(() => setError('加载失败'))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    // P-03：从邮件 / IM 点进来的外部用户在这里原本只能靠浏览器后退（整页无链接、无按钮）。
    // 给一个明确出口：回首页或去登录。Button 带 href 渲染成 <a>，
    // 文字本身就是可访问名，读屏与键盘都能识别。
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Alert
          type="warning"
          showIcon
          message={error}
          description="分享链接可能已过期、被撤销，或当前账号没有访问权限。"
          action={
            <Space direction="vertical" size={8}>
              <Button type="primary" size="small" href="/">返回首页</Button>
              <Button size="small" href="/login">去登录</Button>
            </Space>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header style={{ borderBottom: '1px solid var(--border)', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 10 }}>
        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
          <ThunderboltOutlined /> AI Agent 平台
        </span>
        <Tag color="cyan">只读分享</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>由 {data?.ownerName} 分享</Text>
      </header>

      <div style={{ maxWidth: 820, margin: '0 auto', padding: '24px 16px 64px' }}>
        <Title level={4}>{data?.title}</Title>
        {data?.messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 20 }}>
            <div className={`chat-bubble ${m.role}`} style={{ display: 'inline-block', maxWidth: '88%' }}>
              {m.role === 'assistant' ? (
                <div className="md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
              ) : (
                <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
              )}
            </div>
            {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
              <div className="refs">
                {m.sources.map((s, i) => (
                  <span key={i} className="ref-chip" title={s}>
                    {i + 1}. {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
