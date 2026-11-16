'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { Card, Typography, Form, Input, Button, App, InputNumber, Segmented, Progress, Space, Divider, Row, Col, Skeleton, Select } from 'antd';
import { useThemeCfg, ACCENTS } from '@/components/ThemeProvider';
import { safeValidate } from '@/lib/form';

const { Title, Text, Paragraph } = Typography;

type Profile = {
  email: string;
  name: string;
  role: string;
  monthlyLimit: number;
  usedTokens: number;
  storageQuota: number;
  usedStorage: number;
  overQuotaAction: string;
  alertThreshold: number;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function SettingsPage() {
  const { message } = App.useApp();
  const { cfg, setCfg, ready } = useThemeCfg();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pwForm] = Form.useForm();
  const [nameForm] = Form.useForm();
  const [quotaForm] = Form.useForm();
  const [savingPw, setSavingPw] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [savingQuota, setSavingQuota] = useState(false);

  async function load() {
    const r = await fetch('/api/settings');
    if (!r.ok) return;
    setProfile(await r.json());
  }

  /**
   * 表单回填必须放在 profile 生效后的 effect 里：
   * 首次渲染 profile 为空，页面走 Skeleton 分支，三个 <Form> 根本还没挂载；
   * 若在 load() 里紧跟 setProfile 调 setFieldsValue，antd 会判定「useForm 实例未连接 Form」并打 console.error
   * （Next 15 开发浮层会把它算成 Issue）。
   */
  useEffect(() => {
    if (!profile) return;
    nameForm.setFieldsValue({ name: profile.name });
    quotaForm.setFieldsValue({
      monthlyLimit: profile.monthlyLimit,
      overQuotaAction: profile.overQuotaAction,
      alertThreshold: profile.alertThreshold,
    });
  }, [profile, nameForm, quotaForm]);
  useEffect(() => {
    load();
  }, []);

  async function saveName() {
    const v = await safeValidate(nameForm);
    if (!v) return;
    setSavingName(true);
    const r = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: v.name }),
    });
    setSavingName(false);
    if (r.ok) {
      message.success('昵称已更新');
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '更新失败');
    }
  }

  async function savePassword() {
    const v = await safeValidate(pwForm);
    if (!v) return;
    setSavingPw(true);
    const r = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: v.currentPassword, newPassword: v.newPassword }),
    });
    setSavingPw(false);
    if (r.ok) {
      message.success('密码已修改');
      pwForm.resetFields();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '修改失败');
    }
  }

  async function saveQuota() {
    const v = await safeValidate(quotaForm);
    if (!v) return;
    setSavingQuota(true);
    const r = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monthlyLimit: v.monthlyLimit,
        overQuotaAction: v.overQuotaAction,
        alertThreshold: v.alertThreshold,
      }),
    });
    setSavingQuota(false);
    if (r.ok) {
      message.success('额度已更新');
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '更新失败');
    }
  }

  if (!profile) {
    return (
      <div className="page">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  const tokenPct = Math.min(100, Math.round((profile.usedTokens / (profile.monthlyLimit || 1)) * 100));
  const storagePct = Math.min(100, Math.round((profile.usedStorage / (profile.storageQuota || 1)) * 100));

  return (
    <div className="page">
        <PageHeader
          title="设置"
          desc="管理你的账号、安全、外观偏好与资源额度。"
        />

        <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title="账号信息" style={{ marginBottom: 16 }}>
            <Form form={nameForm} layout="vertical">
              <Form.Item label="邮箱" tooltip="登录账号，暂不支持修改">
                <Input value={profile.email} disabled />
              </Form.Item>
              <Form.Item label="角色">
                <Input value={profile.role === 'admin' ? '管理员' : '成员'} disabled />
              </Form.Item>
              <Form.Item name="name" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
                <Input placeholder="显示名称" />
              </Form.Item>
              <Button type="primary" loading={savingName} onClick={saveName}>
                保存昵称
              </Button>
            </Form>
          </Card>

          <Card title="安全 · 修改密码" style={{ marginBottom: 16 }}>
            <Form form={pwForm} layout="vertical">
              <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
                <Input.Password placeholder="当前密码" />
              </Form.Item>
              <Form.Item
                name="newPassword"
                label="新密码"
                rules={[
                  { required: true, message: '请输入新密码' },
                  { min: 6, message: '至少 6 位' },
                ]}
              >
                <Input.Password placeholder="至少 6 位" />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认新密码"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: '请再次输入' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                      return Promise.reject(new Error('两次输入不一致'));
                    },
                  }),
                ]}
              >
                <Input.Password placeholder="再次输入新密码" />
              </Form.Item>
              <Button type="primary" loading={savingPw} onClick={savePassword}>
                修改密码
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="外观" style={{ marginBottom: 16 }}>
            <Text type="secondary">主题与配色会即时生效并保存在本地浏览器。</Text>
            <Divider style={{ margin: '12px 0' }} />
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <Text strong>主题模式</Text>
              </div>
              <Segmented
                value={cfg.mode}
                onChange={(v) => setCfg({ ...cfg, mode: v as 'dark' | 'light' })}
                options={[
                  { label: '深色', value: 'dark' },
                  { label: '浅色', value: 'light' },
                ]}
                disabled={!ready}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <Text strong>界面风格</Text>
              </div>
              <Segmented
                value={cfg.style}
                onChange={(v) => setCfg({ ...cfg, style: v as 'mini' | 'classic' })}
                options={[
                  { label: '小程序', value: 'mini' },
                  { label: '经典', value: 'classic' },
                ]}
                disabled={!ready}
              />
              <div style={{ marginTop: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  小程序：实体气泡、柔和阴影与轻动效；经典：原透明气泡与紧凑质感。
                </Text>
              </div>
            </div>
            <div>
              <div style={{ marginBottom: 8 }}>
                <Text strong>主色调</Text>
              </div>
              <Space>
                {ACCENTS.map((a) => (
                  <div
                    key={a.key}
                    onClick={() => setCfg({ ...cfg, accent: a.color })}
                    title={a.key}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      cursor: 'pointer',
                      background: a.color,
                      border: cfg.accent === a.color ? '3px solid var(--text)' : '3px solid transparent',
                      boxShadow: cfg.accent === a.color ? `0 0 0 2px ${a.color}` : 'none',
                    }}
                  />
                ))}
              </Space>
            </div>
          </Card>

          <Card title="Token 使用额度">
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text strong>本月已用 Token</Text>
                <Text>
                  {profile.usedTokens.toLocaleString()} / {profile.monthlyLimit.toLocaleString()}
                </Text>
              </div>
              <Progress
                percent={tokenPct}
                strokeColor={tokenPct > 90 ? 'var(--danger)' : cfg.accent}
                size="small"
                style={{ marginTop: 6 }}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text strong>存储用量</Text>
                <Text>
                  {fmtSize(profile.usedStorage)} / {fmtSize(profile.storageQuota)}
                </Text>
              </div>
              <Progress
                percent={storagePct}
                strokeColor={storagePct > 90 ? 'var(--danger)' : cfg.accent}
                size="small"
                style={{ marginTop: 6 }}
              />
            </div>
            <Form form={quotaForm} layout="horizontal" labelCol={{ span: 8 }} wrapperCol={{ span: 14 }}>
              <Form.Item name="monthlyLimit" label="月度额度">
                {/* antd 5.22 起 InputNumber 的 addonAfter 已废弃，统一改用 suffix（渲染在输入框内右侧） */}
                <InputNumber min={0} max={100000000} style={{ width: '100%' }} suffix="tokens" />
              </Form.Item>
              <Form.Item name="overQuotaAction" label="超限策略">
                <Select
                  options={[
                    { value: 'block', label: '超限拦截' },
                    { value: 'downgrade', label: '降级到默认模型' },
                    { value: 'warn', label: '仅告警继续' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="alertThreshold" label="告警阈值(%)">
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Button type="primary" loading={savingQuota} onClick={saveQuota}>
                保存额度
              </Button>
            </Form>
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              个人平台下可自调；若由管理员统一管控，请以管理后台为准。
            </Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
