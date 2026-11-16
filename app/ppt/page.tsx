'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import SectionTabs from '@/components/SectionTabs';
import ProjectSelect from '@/components/ProjectSelect';
import { useGuest } from '@/components/SessionContext';
import { getCache, cachedJson } from '@/lib/clientCache';
import { Card, Input, Select, Button, App, Typography, Space, Checkbox, List } from 'antd';
import { FilePptOutlined, DownloadOutlined } from '@ant-design/icons';

const { Text } = Typography;

type ModelOption = { id: string; name: string; provider: string; isDefault?: boolean };
type Art = { id: string; title: string; filename: string; projectId?: string | null; createdAt: number };

export default function PptPage() {
  const { message } = App.useApp();
  const isGuest = useGuest();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  const [useKb, setUseKb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [arts, setArts] = useState<Art[]>([]);

  function loadArts(force = false) {
    const key = '/api/artifacts?type=ppt';
    // force（生成成功后刷新）：不走内存缓存，也不信浏览器缓存，保证列表与后端一致
    if (!force) {
      const c = getCache<Art[]>(key);
      if (c) setArts(c);
    }
    cachedJson<Art[]>(key, { force }).then((d) => d && setArts(d));
  }

  useEffect(() => {
    const cm = getCache<ModelOption[]>('/api/models');
    if (cm) {
      setModels(cm);
      const def = cm.find((m) => m.isDefault) || cm[0];
      if (def) setModelId(def.id);
    }
    cachedJson<ModelOption[]>('/api/models').then((d) => {
      if (!d) return;
      setModels(d);
      const def = d.find((m) => m.isDefault) || d[0];
      if (def) setModelId(def.id);
    });
    loadArts();
  }, []);

  async function generate() {
    if (!brief.trim()) {
      message.warning('请先输入主题或要点');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/ppt/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, modelId, useKb, projectId }),
      });
      if (!r.ok) {
        message.error((await r.json().catch(() => ({}))).error || '生成失败');
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `演示_${Date.now()}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('已生成并下载 .pptx（已归档）');
      loadArts(true);
    } catch (e: any) {
      const raw = String(e?.message || '');
      message.error(
        /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(raw)
          ? '网络中断，生成失败。请检查网络后重试'
          : raw || '生成失败',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={<><FilePptOutlined /> PPT 生成（演示文稿）</>}
        desc="输入主题或要点，AI 生成带封面与分页大纲的演示文稿并导出 .pptx；可归档到项目，在项目详情中查看。"
      />
      <SectionTabs
        options={[
          { value: 'doc', label: 'Word 文档', url: '/docs' },
          { value: 'ppt', label: 'PPT 演示', url: '/ppt' },
        ]}
      />
      <Card>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text>生成模型</Text>
            <Select
              value={modelId || undefined}
              onChange={setModelId}
              style={{ width: '100%', marginTop: 6 }}
              options={models.map((m) => ({ value: m.id, label: `${m.name}（${m.provider}）` }))}
              placeholder="选择模型"
            />
          </div>
          <div>
            <Text>归属项目（可选）</Text>
            <div style={{ marginTop: 6 }}>
              <ProjectSelect value={projectId} onChange={setProjectId} />
            </div>
          </div>
          <div>
            <Text>模板 / 配色</Text>
            <div style={{ marginTop: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                由 AI 根据内容自动匹配（科技 / 商务 / 暖色 / 绿色 / 极简），无需手动选择。
              </Text>
            </div>
          </div>
          <div>
            <Text>主题 / 要点（支持多行）</Text>
            <Input.TextArea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={8}
              style={{ marginTop: 6 }}
              placeholder={'例如：\n产品发布会 Keynote\n- 市场背景\n- 核心功能\n- 客户案例\n- roadmap'}
            />
          </div>
          <Checkbox checked={useKb} onChange={(e) => setUseKb(e.target.checked)}>
            引用知识库素材自动成文
          </Checkbox>
          <Button type="primary" icon={<DownloadOutlined />} loading={busy} onClick={generate} disabled={isGuest}>
            {isGuest ? '访客为只读角色，无法生成' : '生成并下载 .pptx'}
          </Button>
        </Space>
      </Card>

      <Card title="最近产物" style={{ marginTop: 16 }}>
        {arts.length === 0 ? (
          <Text type="secondary">暂无</Text>
        ) : (
          <List
            size="small"
            dataSource={arts}
            renderItem={(a) => (
              <List.Item actions={[<a key="d" href={`/api/artifacts/${a.id}`}>下载</a>]}>
                <Text>{a.title || a.filename}</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  {new Date(a.createdAt).toLocaleString()}
                </Text>
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
