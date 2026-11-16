'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import SectionTabs from '@/components/SectionTabs';
import { getCache, cachedJson } from '@/lib/clientCache';
import { useGuest } from '@/components/SessionContext';
import { Card, Upload, Button, Table, Tag, App, Space, Progress, Typography, Tooltip, Select, Input, Drawer, Modal, Tabs } from 'antd';
import { UploadOutlined, DownloadOutlined, DeleteOutlined, DatabaseOutlined, EditOutlined, EyeOutlined, SwapOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UploadProps } from 'antd';

const { Title, Text, Paragraph } = Typography;

type FileItem = {
  id: string;
  filename: string;
  size: number;
  scope: string;
  projectId?: string | null;
  createdAt: number;
};

type Project = { id: string; name: string };

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilesPage() {
  const { message, modal } = App.useApp();
  const isGuest = useGuest();
  const [list, setList] = useState<FileItem[]>([]);
  const [fileList, setFileList] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [quota, setQuota] = useState({ used: 0, total: 1073741824 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<any>(null);
  const [moveFile, setMoveFile] = useState<FileItem | null>(null);
  const [moveTo, setMoveTo] = useState<string>('none');
  const [kbFile, setKbFile] = useState<FileItem | null>(null);
  const [kbTo, setKbTo] = useState<string>('');
  const [kbs, setKbs] = useState<{ id: string; name: string }[]>([]);

  async function load() {
    const c = getCache<any[]>('/api/files');
    if (c) {
      setList(c);
      setQuota((q) => ({ ...q, used: c.reduce((s, f) => s + f.size, 0) }));
    }
    const data = await cachedJson<FileItem[]>('/api/files');
    if (data) {
      setList(data);
      setQuota((q) => ({ ...q, used: data.reduce((s, f) => s + f.size, 0) }));
    }
    const pr = getCache<any[]>('/api/projects') || (await cachedJson<any[]>('/api/projects'));
    if (pr) setProjects(pr);
    const kr = getCache<any[]>('/api/knowledge') || (await cachedJson<any[]>('/api/knowledge'));
    if (kr) setKbs(kr);
  }
  useEffect(() => {
    load();
  }, []);

  const uploadProps: UploadProps = {
    fileList,
    beforeUpload: (file) => {
      setFileList([file]);
      return false;
    },
    onRemove: () => setFileList([]),
  };

  async function handleUpload() {
    if (!fileList.length) return;
    setUploading(true);
    const fd = new FormData();
    fd.append('file', fileList[0] as any);
    if (projectId) fd.append('projectId', projectId);
    const r = await fetch('/api/files', { method: 'POST', body: fd });
    setUploading(false);
    if (r.ok) {
      message.success('已上传');
      setFileList([]);
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '上传失败');
    }
  }

  async function download(id: string, name: string) {
    const r = await fetch(`/api/files/${id}`);
    if (!r.ok) {
      message.error('下载失败');
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function del(id: string) {
    await fetch(`/api/files/${id}`, { method: 'DELETE' });
    message.success('已删除');
    load();
  }

  function rename(f: FileItem) {
    let val = f.filename;
    modal.confirm({
      title: '重命名文件',
      content: <Input defaultValue={f.filename} onChange={(e) => (val = e.target.value)} style={{ marginTop: 8 }} />,
      okText: '保存',
      cancelText: '取消',
      onOk: async () => {
        const name = val.trim();
        if (!name) {
          message.warning('文件名不能为空');
          return;
        }
        const r = await fetch(`/api/files/${f.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: name }),
        });
        if (r.ok) {
          message.success('已重命名');
          load();
        } else {
          message.error((await r.json().catch(() => ({}))).error || '重命名失败');
        }
      },
    });
  }

  async function doPreview(f: FileItem) {
    const r = await fetch(`/api/files/${f.id}?preview=1`);
    if (!r.ok) {
      message.error('无法预览');
      return;
    }
    const j = await r.json();
    setPreview({ id: f.id, filename: f.filename, ...j });
  }

  function openMove(f: FileItem) {
    setMoveFile(f);
    setMoveTo(f.projectId || 'none');
  }

  async function submitMove() {
    if (!moveFile) return;
    const r = await fetch(`/api/files/${moveFile.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: moveTo === 'none' ? null : moveTo }),
    });
    if (r.ok) {
      message.success('已移动');
      setMoveFile(null);
      load();
    } else {
      message.error('移动失败');
    }
  }

  function openAddKb(f: FileItem) {
    setKbFile(f);
    setKbTo(kbs[0]?.id || '');
  }

  async function submitAddKb() {
    if (!kbFile || !kbTo) {
      message.warning('请选择知识库');
      return;
    }
    const blob = await fetch(`/api/files/${kbFile.id}`).then((r) => r.blob());
    const fd = new FormData();
    fd.append('file', new File([blob], kbFile.filename));
    fd.append('kbId', kbTo);
    const r = await fetch('/api/knowledge', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      message.success(`已加入知识库（切分 ${j.chunks ?? 0} 片段）`);
      setKbFile(null);
    } else {
      message.error(j.error || '加入失败');
    }
  }

  const pct = Math.min(100, Math.round((quota.used / quota.total) * 100));
  const columns = [
    { title: '文件名', dataIndex: 'filename', key: 'filename' },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      render: (n: number) => fmtSize(n),
    },
    {
      title: '范围',
      dataIndex: 'scope',
      key: 'scope',
      render: (s: string) => <Tag color={s === 'team' ? 'cyan' : 'default'}>{s === 'team' ? '团队' : '个人'}</Tag>,
    },
    {
      title: '上传时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: number) => new Date(v).toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, r: FileItem) => (
        <Space>
          <Tooltip title="预览">
            <Button size="small" icon={<EyeOutlined />} aria-label="预览文件" onClick={() => doPreview(r)} />
          </Tooltip>
          <Tooltip title="下载">
            <Button size="small" icon={<DownloadOutlined />} aria-label="下载文件" onClick={() => download(r.id, r.filename)} />
          </Tooltip>
          <Tooltip title="重命名">
            <Button size="small" icon={<EditOutlined />} aria-label="重命名文件" onClick={() => rename(r)} />
          </Tooltip>
          <Tooltip title="移动/归属项目">
            <Button size="small" icon={<SwapOutlined />} aria-label="移动文件到项目" onClick={() => openMove(r)} />
          </Tooltip>
          <Tooltip title="加入知识库">
            <Button size="small" icon={<DatabaseOutlined />} aria-label="加入知识库" onClick={() => openAddKb(r)} />
          </Tooltip>
          <Tooltip title="删除">
            <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除文件" onClick={() => del(r.id)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
        <PageHeader
          title={<><DatabaseOutlined /> 文件管理</>}
          desc="管理项目与个人文件，支持上传、下载与存储用量监控。"
        />
        <SectionTabs
          options={[
            { value: 'kb', label: '知识库', url: '/knowledge' },
            { value: 'files', label: '文件', url: '/files' },
          ]}
        />
        <Card style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <Text>存储用量：</Text>
          <Text strong>{fmtSize(quota.used)}</Text> / {fmtSize(quota.total)}
          <Progress percent={pct} strokeColor={pct > 90 ? 'var(--danger)' : 'var(--accent)'} size="small" style={{ marginTop: 6 }} />
        </div>
        <div className="toolbar">
          <Upload {...uploadProps} maxCount={1} disabled={isGuest}>
            <Button icon={<UploadOutlined />} disabled={isGuest}>选择文件</Button>
          </Upload>
          <Select
            allowClear
            placeholder="归属项目（可选）"
            style={{ width: 220 }}
            value={projectId}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Button type="primary" loading={uploading} onClick={handleUpload} disabled={isGuest}>
            {isGuest ? '访客为只读角色，无法上传' : '上传'}
          </Button>
        </div>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          文件默认存于本地文件系统（data/files）。如需纳入知识库检索，可在「知识库」页上传同一文件。
        </Paragraph>
      </Card>
      <Card>
        <Table rowKey="id" dataSource={list} columns={columns} pagination={{ pageSize: 10 }} />
      </Card>

      <Modal
        title={preview?.filename || '预览'}
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={null}
        width="92%"
        style={{ top: 24, maxWidth: 1200 }}
        destroyOnHidden
      >
        <div style={{ marginBottom: 10 }}>
          <Space>
            {preview?.id && (
              <a href={`/api/files/${preview.id}`} download>
                下载原文件
              </a>
            )}
            {preview?.kind === 'pdf' && preview?.url && (
              <a href={preview.url} target="_blank" rel="noreferrer">
                新窗口打开
              </a>
            )}
            {preview?.kind === 'sheet' && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                如需编辑，请下载后用 Excel 打开
              </Text>
            )}
          </Space>
        </div>
        <div style={{ maxHeight: '76vh', overflow: 'auto' }}>
          {preview?.kind === 'markdown' && (
            <div className="md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.text || ''}</ReactMarkdown>
            </div>
          )}
          {preview?.kind === 'text' && (
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0 }}>{preview.text}</pre>
          )}
          {preview?.kind === 'image' && (
            <img alt={preview.filename} src={`data:${preview.mime};base64,${preview.data}`} style={{ maxWidth: '100%' }} />
          )}
          {preview?.kind === 'sheet' && (
            <Tabs
              items={(preview.sheets || []).map((s: any, si: number) => ({
                key: String(si),
                label: s.name,
                children: (
                  <Table
                    size="small"
                    scroll={{ x: 'max-content' }}
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    rowKey="key"
                    columns={(s.headers || []).map((h: string, i: number) => ({
                      title: h || `列${i + 1}`,
                      dataIndex: i,
                      key: i,
                      ellipsis: true,
                      width: 160,
                    }))}
                    dataSource={(s.rows || []).map((r: string[], ri: number) => {
                      const o: any = { key: ri };
                      r.forEach((v, ci) => (o[ci] = v));
                      return o;
                    })}
                  />
                ),
              }))}
            />
          )}
          {preview?.kind === 'doc' && (
            <div className="docx-preview" dangerouslySetInnerHTML={{ __html: preview.html || '' }} />
          )}
          {preview?.kind === 'pdf' && (
            <iframe src={preview.url} title="pdf-preview" style={{ width: '100%', height: '76vh', border: 0 }} />
          )}
          {preview?.kind === 'unsupported' && <Text type="secondary">{preview.message || '暂不支持预览'}</Text>}
          {preview?.kind === 'binary' && <Text type="secondary">该类型暂不支持内联预览，请下载后查看。</Text>}
        </div>
      </Modal>

      <Modal title="移动文件" open={!!moveFile} onOk={submitMove} onCancel={() => setMoveFile(null)} okText="保存" cancelText="取消">
        <Select
          style={{ width: '100%', marginTop: 8 }}
          value={moveTo}
          onChange={setMoveTo}
          options={[{ value: 'none', label: '个人文件（不归属项目）' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </Modal>

      <Modal title="加入知识库" open={!!kbFile} onOk={submitAddKb} onCancel={() => setKbFile(null)} okText="加入" cancelText="取消">
        {kbs.length === 0 ? (
          <Text type="secondary">暂无知识库，请先到「知识库」页新建。</Text>
        ) : (
          <Select
            style={{ width: '100%', marginTop: 8 }}
            value={kbTo}
            onChange={setKbTo}
            options={kbs.map((k) => ({ value: k.id, label: k.name }))}
          />
        )}
      </Modal>
    </div>
  );
}
