'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import SectionTabs from '@/components/SectionTabs';
import ProjectSelect from '@/components/ProjectSelect';
import { getCache, cachedJson } from '@/lib/clientCache';
import { useGuest, useMe } from '@/components/SessionContext';
import {
  Card,
  Upload,
  Button,
  Table,
  Input,
  Tag,
  App,
  Space,
  Typography,
  Modal,
  Form,
  Select,
  Empty,
  Tooltip,
  Popconfirm,
  InputNumber,
  Dropdown,
} from 'antd';
import {
  UploadOutlined,
  SearchOutlined,
  DeleteOutlined,
  PlusOutlined,
  DatabaseOutlined,
  EditOutlined,
  ReloadOutlined,
  ScissorOutlined,
  FileSyncOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { safeValidate } from '@/lib/form';

const { Text, Paragraph, Title } = Typography;

/** 在文本中高亮首个命中词（大小写不敏感），用于检索结果预览 */
function highlight(text: string, q: string) {
  const kw = q.trim();
  if (!kw) return text;
  const idx = text.toLowerCase().indexOf(kw.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="hit-hl">{text.slice(idx, idx + kw.length)}</mark>
      {text.slice(idx + kw.length)}
    </>
  );
}

type KB = { id: string; name: string; scope: string; projectId?: string | null; embeddingModel: string; docCount: number; chunkCount: number; canManage: boolean };
type Doc = { id: string; filename: string; status: string; chunks: number; degraded?: boolean };
type Hit = { content: string; source: string; score: number };
type EmbModel = { id: string; name: string; provider: string; enabled: boolean; hasKey: boolean };

export default function KnowledgePage() {
  const { message, modal } = App.useApp();
  const isGuest = useGuest();
  const isAdmin = useMe()?.role === 'admin';
  const [kbs, setKbs] = useState<KB[]>([]);
  const [activeKb, setActiveKb] = useState<string>('');
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [fileList, setFileList] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexingDoc, setReindexingDoc] = useState('');
  const [rechunkingDoc, setRechunkingDoc] = useState('');
  const [reextractingDoc, setReextractingDoc] = useState('');
  const [query, setQuery] = useState('');
  const [docFilter, setDocFilter] = useState('');
  const [topK, setTopK] = useState(3);
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState(false);
  const [kbModal, setKbModal] = useState(false);
  const [editing, setEditing] = useState<KB | null>(null);
  const [embModels, setEmbModels] = useState<EmbModel[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const projName = (id?: string | null) => projects.find((p) => p.id === id)?.name || '项目';

  /** 向量模型引用 → 展示名（'auto' 跟随全局默认，历史自由文本按 id 再按名称兜底） */
  const embLabel = (ref?: string | null) => {
    const v = (ref || '').trim();
    if (!v || v.toLowerCase() === 'lexical' || v === 'auto') return '自动';
    if (v === 'local') return '本地降级';
    const m = embModels.find((x) => x.id === v) || embModels.find((x) => x.name === v);
    return m ? m.name : v;
  };
  const embOptions = [
    { value: 'auto', label: '自动（跟随全局默认模型）' },
    ...embModels.map((m) => ({
      value: m.id,
      label: `${m.name}${m.provider ? ` · ${m.provider}` : ''}${!m.enabled || !m.hasKey ? '（未配置 Key / 已停用）' : ''}`,
      disabled: !m.enabled || !m.hasKey,
    })),
  ];

  async function loadKbs(selectId?: string) {
    const c = getCache<KB[]>('/api/knowledge');
    if (c) {
      setKbs(c);
      const cid = selectId || activeKb || c[0]?.id || '';
      setActiveKb(cid);
      if (cid) loadDocs(cid);
    }
    const list = await cachedJson<KB[]>('/api/knowledge');
    if (list) {
      setKbs(list);
      const id = selectId || activeKb || list[0]?.id || '';
      setActiveKb(id);
      if (id) loadDocs(id);
      else setDocs([]);
    }
  }

  async function loadDocs(kbId: string) {
    const key = `/api/knowledge/${kbId}`;
    const c = getCache<Doc[]>(key);
    if (c) {
      setDocs(c);
      setDocsLoading(false);
    } else {
      // 切库时先亮加载态，避免旧列表残留让人以为没切换
      setDocsLoading(true);
    }
    const d = await cachedJson<Doc[]>(key);
    if (d) setDocs(d);
    setDocsLoading(false);
  }

  useEffect(() => {
    loadKbs();
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setProjects(d))
      .catch(() => {});
    fetch('/api/knowledge/embedding-models')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setEmbModels(Array.isArray(d) ? d : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectKb(id: string) {
    setActiveKb(id);
    setHits([]);
    setSearched(false);
    loadDocs(id);
  }

  async function createKb() {
    const v = await safeValidate(form);
    if (!v) return;
    const r = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    if (r.ok) {
      const j = await r.json();
      message.success('知识库已创建');
      setKbModal(false);
      form.resetFields();
      loadKbs(j.id);
    } else {
      message.error((await r.json().catch(() => ({}))).error || '创建失败');
    }
  }

  // 编辑弹窗未挂载时不能 setFieldsValue（会触发 useForm 未连接警告），改为 initialValues 注入
  function openEditKb(k: KB) {
    setEditing(k);
  }

  async function saveEditKb() {
    if (!editing) return;
    const v = await safeValidate(editForm);
    if (!v) return;
    const modelChanged = (v.embeddingModel || 'auto') !== (editing.embeddingModel || 'auto');
    const r = await fetch('/api/knowledge', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editing.id, name: v.name, embeddingModel: v.embeddingModel }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return message.error(j.error || '保存失败');
    message.success(modelChanged ? '已切换向量模型，正在后台清空并重建该库向量' : '已保存');
    setEditing(null);
    loadKbs(editing.id);
  }

  function deleteKb(k: KB) {
    modal.confirm({
      title: `删除知识库「${k.name}」？`,
      content: '其下所有文档与切片会被一并删除，不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await fetch(`/api/knowledge?id=${k.id}`, { method: 'DELETE' });
        message.success('已删除');
        setActiveKb('');
        loadKbs();
      },
    });
  }

  const uploadProps: UploadProps = {
    fileList,
    beforeUpload: (file) => {
      setFileList([file]);
      return false;
    },
    onRemove: () => setFileList([]),
  };

  async function handleUpload() {
    if (!activeKb) return message.warning('请先选择或创建知识库');
    if (fileList.length === 0) return message.warning('请先选择文件');
    setUploading(true);
    const fd = new FormData();
    fd.append('file', fileList[0] as any);
    fd.append('kbId', activeKb);
    const r = await fetch('/api/knowledge', { method: 'POST', body: fd });
    setUploading(false);
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      if (j.chunks > 0) message.success(`已入库，切分为 ${j.chunks} 个片段`);
      else message.warning(j.warning || '已入库，但未解析到文本片段');
      setFileList([]);
      loadKbs(activeKb);
    } else {
      message.error(j.error || '上传失败');
    }
  }

  async function refreshDocs(kbId: string) {
    if (!kbId) return;
    const d = await cachedJson<Doc[]>(`/api/knowledge/${kbId}`);
    if (d) setDocs(d);
  }

  const hasIndexing = docs.some((d) => d.status === 'indexing' || d.status === 'parsing');
  useEffect(() => {
    if (!hasIndexing || !activeKb) return;
    const t = setInterval(() => refreshDocs(activeKb), 3000);
    return () => clearInterval(t);
  }, [hasIndexing, activeKb]);

  async function handleReindex() {
    setReindexing(true);
    const r = await fetch('/api/knowledge/reindex', { method: 'POST' });
    setReindexing(false);
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      message.success(j.message || '回填任务已开始');
      loadKbs(activeKb);
    } else {
      message.error(j.error || '重新索引失败');
    }
  }

  async function reindexDoc(id: string) {
    setReindexingDoc(id);
    const r = await fetch(`/api/knowledge/documents/${id}/reindex`, { method: 'POST' });
    setReindexingDoc('');
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      message.success(j.message || '已开始重建该文档的向量');
      refreshDocs(activeKb);
    } else {
      message.error(j.error || '重新索引失败');
    }
  }

  async function rechunkDoc(id: string) {
    setRechunkingDoc(id);
    const r = await fetch(`/api/knowledge/documents/${id}/rechunk`, { method: 'POST' });
    setRechunkingDoc('');
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      message.success(j.message || '已重建切片');
      refreshDocs(activeKb);
    } else {
      message.error(j.error || '重建切片失败');
    }
  }

  async function reextractDoc(id: string) {
    setReextractingDoc(id);
    const r = await fetch(`/api/knowledge/documents/${id}/reextract`, { method: 'POST' });
    setReextractingDoc('');
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      message.success(j.message || '已重新解析');
      refreshDocs(activeKb);
    } else {
      message.error(j.error || '重新解析失败');
    }
  }

  async function delDoc(id: string) {    const r = await fetch(`/api/knowledge/documents/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      message.error((await r.json().catch(() => ({}))).error || '删除失败');
      return;
    }
    message.success('已删除');
    loadKbs(activeKb);
  }

  async function runQuery() {
    if (!query.trim()) return;
    setSearched(true);
    const r = await fetch('/api/knowledge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, kbId: activeKb, topK }),
    });
    if (r.ok) setHits(await r.json());
  }

  const columns = [
    { title: '文件名', dataIndex: 'filename', key: 'filename' },
    { title: '切片数', dataIndex: 'chunks', key: 'chunks', render: (n: number) => <Tag color={n > 0 ? 'cyan' : 'red'}>{n}</Tag> },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (s: string, r: Doc) => {
        const map: Record<string, { c: string; t: string }> = {
          indexed: { c: 'green', t: '已索引' },
          indexing: { c: 'processing', t: '索引中' },
          ready: { c: 'default', t: '待索引' },
          parsing: { c: 'gold', t: '解析中' },
          failed: { c: 'red', t: '失败' },
        };
        const m = map[s] || { c: 'default', t: s };
        return (
          <Space size={4} wrap>
            <Tag color={m.c}>{m.t}</Tag>
            {r.degraded && (
              <Tooltip title="embedding 模型调用失败，这批切片已退化为本地哈希向量，检索质量会明显下降。点行内「重新索引」可重试。">
                <Tag color="orange">向量降级</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      align: 'right' as const,
      render: (_: any, r: Doc) => (
        <Space size={4}>
          <Popconfirm
            title="重新索引该文档？"
            description="会清空并重建该文档的向量，耗时取决于切片数量。"
            okText="开始"
            cancelText="取消"
            onConfirm={() => reindexDoc(r.id)}
          >
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              loading={reindexingDoc === r.id}
              disabled={isGuest || r.status === 'indexing'}
            >
              重新索引
            </Button>
          </Popconfirm>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'rechunk',
                  icon: <ScissorOutlined />,
                  label: '重建切片',
                  disabled: isGuest || r.status === 'indexing' || !r.chunks,
                },
                {
                  key: 'reextract',
                  icon: <FileSyncOutlined />,
                  label: '重新解析',
                  disabled: isGuest || r.status === 'indexing',
                },
                { type: 'divider' as const },
                { key: 'del', icon: <DeleteOutlined />, danger: true, label: '删除' },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'rechunk') {
                  modal.confirm({
                    title: '重建切片？',
                    content: '会先按当前分块策略重新切分（切片数会变化），再重建向量。检索期间可能暂时变少。',
                    okText: '开始',
                    cancelText: '取消',
                    onOk: () => rechunkDoc(r.id),
                  });
                }
                if (key === 'reextract') {
                  modal.confirm({
                    title: '重新解析？',
                    content:
                      '会用最新的解析规则从原始文件重抽文本（表格会按行列还原），再重新切片并重建向量。原始文件已不在服务器上时会提示重新上传。',
                    okText: '开始',
                    cancelText: '取消',
                    onOk: () => reextractDoc(r.id),
                  });
                }
                if (key === 'del') {
                  modal.confirm({
                    title: '删除该文档？',
                    content: '其切片会一并删除，不可恢复。',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => delDoc(r.id),
                  });
                }
              },
            }}
          >
            <Tooltip title="更多操作">
              <Button type="text" size="small" icon={<MoreOutlined />} aria-label="文档更多操作" loading={rechunkingDoc === r.id} disabled={isGuest} />
            </Tooltip>
          </Dropdown>
        </Space>
      ),
    },
  ];

  const cur = kbs.find((k) => k.id === activeKb);
  const filteredDocs = docs.filter((d) =>
    d.filename.toLowerCase().includes(docFilter.trim().toLowerCase()),
  );

  return (
    <div className="page">
      <PageHeader
        title={<><DatabaseOutlined /> 知识库</>}
        desc="支持多知识库（个人 / 团队），混合向量召回（PDF / Word / Excel / 文本）。"
        extra={
          isGuest ? (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>访客为只读角色</span>
          ) : (
            <Space>
              {isAdmin && (
                <Tooltip title="扫描所有文档，为缺失向量的切片重新生成向量（管理员维护用）">
                  <Button icon={<ReloadOutlined />} loading={reindexing} onClick={handleReindex}>
                    回填缺失向量
                  </Button>
                </Tooltip>
              )}
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setKbModal(true)}>
                新建知识库
              </Button>
            </Space>
          )
        }
      />
      <SectionTabs
        options={[
          { value: 'kb', label: '知识库', url: '/knowledge' },
          { value: 'files', label: '文件', url: '/files' },
        ]}
      />

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 左：知识库列表 */}
        <Card title="知识库" style={{ width: 300, flexShrink: 0 }}>
          {kbs.length === 0 && <Empty description="暂无知识库" />}
          {kbs.map((k) => (
            <div
              key={k.id}
              onClick={() => selectKb(k.id)}
              className={`kb-item ${k.id === activeKb ? 'active' : ''}`}
            >
              <div className="kb-item-head">
                <span className="kb-name">{k.name}</span>
                <Tag color={k.scope === 'team' ? 'cyan' : 'default'} className="kb-scope">
                  {k.scope === 'team' ? '团队' : '个人'}
                </Tag>
              </div>
              <div className="kb-meta">
                {k.docCount} 文档 · {k.chunkCount} 片段{k.projectId ? ` · 项目：${projName(k.projectId)}` : ''}
              </div>
              <div className="kb-meta">向量模型：{embLabel(k.embeddingModel)}</div>
              {k.canManage && (
                <Space size={2} className="kb-actions" onClick={(e) => e.stopPropagation()}>
                  <Tooltip title="编辑名称 / 向量模型">
                    <Button type="text" size="small" icon={<EditOutlined />} aria-label="编辑知识库" onClick={() => openEditKb(k)} />
                  </Tooltip>
                  <Popconfirm title="删除该知识库？" okText="删除" cancelText="取消" onConfirm={() => deleteKb(k)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除知识库" />
                  </Popconfirm>
                </Space>
              )}
            </div>
          ))}
        </Card>

        {/* 右：文档 + 检索 */}
        <div style={{ flex: 1, minWidth: 360 }}>
          <Card style={{ marginBottom: 16 }}>
            <Title level={5}>上传到「{cur?.name || '—'}」</Title>
            <Text type="secondary">
              支持 .txt/.md/.json/.csv/.pdf/.docx/.xlsx 等（自动切片并向量化；无 embedding 模型时降级词法+子串召回）。
            </Text>
            <div style={{ marginTop: 6 }}>
              <Text type="secondary">当前向量模型：</Text>
              <Tag color="blue">{embLabel(cur?.embeddingModel)}</Tag>
              {cur?.canManage && (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openEditKb(cur)}>
                  切换
                </Button>
              )}
            </div>
            <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
              <Upload {...uploadProps} maxCount={1} disabled={isGuest}>
                <Button icon={<UploadOutlined />} disabled={isGuest}>选择文件</Button>
              </Upload>
              <Button type="primary" loading={uploading} onClick={handleUpload} disabled={!activeKb || isGuest}>
                {isGuest ? '访客为只读角色' : '上传并切片'}
              </Button>
            </div>
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <Title level={5}>文档列表</Title>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="按文件名筛选"
              value={docFilter}
              onChange={(e) => setDocFilter(e.target.value)}
              style={{ marginBottom: 12, maxWidth: 280 }}
            />
            <Table
              rowKey="id"
              loading={docsLoading}
              dataSource={filteredDocs}
              columns={columns}
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
              locale={{ emptyText: docFilter ? '没有匹配的文件' : '暂无文档' }}
            />
          </Card>

          <Card>
            <Title level={5}>检索测试（对话会自动带上相关片段）</Title>
            <div className="toolbar" style={{ marginBottom: 12 }}>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="输入查询，测试知识库召回"
                style={{ width: 300 }}
                onPressEnter={runQuery}
              />
              <span style={{ color: 'var(--muted)' }}>TopK</span>
              <InputNumber min={1} max={20} value={topK} onChange={(v) => setTopK(Number(v) || 3)} style={{ width: 76 }} />
              <Button type="primary" icon={<SearchOutlined />} onClick={runQuery} disabled={!activeKb}>
                检索
              </Button>
            </div>
            {hits.map((h, i) => (
              <Card key={i} size="small" style={{ marginTop: 10 }}>
                <Space>
                  <Tag color="cyan">来源：{h.source}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>score {h.score}</Text>
                </Space>
                <div className="hit-score">
                  <i style={{ width: `${Math.max(0, Math.min(1, h.score)) * 100}%` }} />
                </div>
                <Paragraph style={{ marginTop: 6, whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                  {highlight(h.content, query)}
                </Paragraph>
              </Card>
            ))}
            {searched && hits.length === 0 && <Text type="secondary">无命中（请确认该库已上传相关内容的文件）</Text>}
          </Card>
        </div>
      </div>

      <Modal title="新建知识库" open={kbModal} onOk={createKb} onCancel={() => setKbModal(false)} okText="创建" cancelText="取消" destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：产品手册" />
          </Form.Item>
          <Form.Item name="scope" label="可见范围" initialValue="team">
            <Select options={[{ value: 'personal', label: '个人私有' }, { value: 'team', label: '团队共享' }]} />
          </Form.Item>
          <Form.Item name="projectId" label="归属项目（可选）">
            <ProjectSelect />
          </Form.Item>
          <Form.Item name="embeddingModel" label="向量模型（Embedding）" initialValue="auto" extra="索引与检索都按该模型执行；切换后会自动重建该库向量。">
            <Select options={embOptions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑知识库"
        open={!!editing}
        onOk={saveEditKb}
        onCancel={() => setEditing(null)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          preserve={false}
          initialValues={{ name: editing?.name, embeddingModel: editing?.embeddingModel || 'auto' }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：产品手册" />
          </Form.Item>
          <Form.Item
            name="embeddingModel"
            label="向量模型（Embedding）"
            extra="切换模型会清空该库现有向量并在后台重建，期间检索可能暂时变少。"
          >
            <Select options={embOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
