'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { App, Button, Checkbox, Empty, Input, Spin, Tag, Tooltip } from 'antd';
import TrendChart from '@/components/TrendChart';
import {
  MessageOutlined,
  ThunderboltOutlined,
  CopyOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  FolderOpenOutlined,
  BellOutlined,
  DashOutlined,
  ReloadOutlined,
  SendOutlined,
  FileTextOutlined,
  FilePptOutlined,
  RobotOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';

type WorkbenchData = {
  greeting: string;
  date: string;
  name?: string;
  conversations: { id: string; title: string; createdAt: number; pinned: boolean }[];
  files: { id: string; filename: string; mime: string | null; size: number; createdAt: number }[];
  todos: { id: string; title: string; source: string; createdAt: number }[];
  schedules: { id: string; name: string; cron: string; enabled: boolean; lastRunAt: number | null; lastStatus: string | null }[];
  schedulesRecentRuns: { id: string; scheduleId: string; status: string; startedAt: number }[];
  notifications: { unread: number };
  artifacts: { id: string; type: string; title: string | null; filename: string; createdAt: number }[];
  quota: { used: number; limit: number; percent: number; period: string; trend?: number[]; trendLabels?: string[] };
};

type BriefData = { items: string[]; generatedBy: 'ai' | 'template'; disabled?: boolean };

const SOURCE_LABEL: Record<string, string> = { chat: '对话', skill: '技能', schedule: '定时', manual: '手动' };

function fmtSize(n = 0) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

export default function WorkPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [convFilter, setConvFilter] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    fetch('/api/workbench')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);

  const loadBrief = useCallback(() => {
    setBriefBusy(true);
    fetch('/api/brief')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setBrief(d && d.chatAvailable !== false ? { items: d.items || [], generatedBy: d.generatedBy } : { items: [], generatedBy: 'template' }))
      .catch(() => setBrief({ items: [], generatedBy: 'template' }))
      .finally(() => setBriefBusy(false));
  }, []);

  useEffect(() => {
    load();
    loadBrief();
  }, [load, loadBrief]);

  async function completeTodo(id: string) {
    setDoneIds((s) => new Set(s).add(id));
    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'done' }),
    }).catch(() => {});
    message.success('已完成，好评！');
  }

  async function regenBrief() {
    setBriefBusy(true);
    try {
      const r = await fetch('/api/brief', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setBrief({ items: j.items || [], generatedBy: j.generatedBy || 'ai' });
        message.success('已重新生成');
      } else {
        message.warning(j.error || '重新生成失败');
      }
    } finally {
      setBriefBusy(false);
    }
  }

  function launch(text: string) {
    const t = text.trim();
    if (!t) return;
    // new=1：从工作台发起的提问属于「新任务」，不能被对话页恢复成上次那个会话
    router.push(`/chat?draft=${encodeURIComponent(t)}&new=1`);
  }

  if (!data) {
    return (
      <div className="work-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '70vh' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Spin />
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>正在加载工作台…</span>
        </div>
      </div>
    );
  }

  const failedRunIds = new Set(data.schedulesRecentRuns.filter((r) => r.status === 'error').map((r) => r.scheduleId));
  const filteredConvs = data.conversations.filter((c) => c.title.toLowerCase().includes(convFilter.trim().toLowerCase()));
  const filteredFiles = data.files.filter((f) => f.filename.toLowerCase().includes(fileFilter.trim().toLowerCase()));

  return (
    <div className="work-shell">
      {/* 问候区 */}
      <div className="work-greet">
        <h1>
          {data.greeting}，{data.name || ''}
        </h1>
        <p>这是你的能力一览：AI、待办、任务与文件都从这里出发。</p>
      </div>

      {/* 快速发起（大输入框） */}
      <div className="work-input">
        <Input.TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`把今天的工作交给 AI：提问、找资料、写周报（Enter 带入对话页，确认后发送）`}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              launch(draft);
              setDraft('');
            }
          }}
          className="work-input-box"
        />
        <div className="work-input-bar">
          <span className="hint">Enter 带入对话页，确认后发送 · 那边可用 / 技能、@ 引用与附件</span>
          <Button
            type="primary"
            shape="circle"
            icon={<SendOutlined />} aria-label="发送"
            onClick={() => {
              launch(draft);
              setDraft('');
            }}
            className="work-send"
          />
        </div>
      </div>

      {/* 今日简报 */}
      <section className="work-card work-brief">
        <div className="work-card-head">
          <h3>
            <ThunderboltOutlined /> 今日简报
          </h3>
          <span className="meta">
            {brief?.generatedBy === 'ai' ? 'AI 生成' : '数据摘要'} · {data.date}
            <Tooltip title="重新生成（每日限 2 次）">
              <Button type="text" size="small" icon={<ReloadOutlined />} aria-label="重新生成数据摘要" onClick={regenBrief} loading={briefBusy} />
            </Tooltip>
          </span>
        </div>
        {briefBusy && !brief ? (
          <Spin size="small" />
        ) : brief && brief.items.length ? (
          <ul className="work-brief-list">
            {brief.items.map((it, i) => (
              <li key={i}>
                <RobotOutlined /> <span>{it}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="work-brief-empty">今天暂无待处理事项，从这里开始新的一天。</div>
        )}
      </section>

      {/* 卡片行 */}
      <div className="work-grid">
        {/* 待办 */}
        <section className="work-card">
          <div className="work-card-head">
            <h3>
              <CheckOutlined /> 待办收件箱
            </h3>
            <span className="more">{data.todos.length > 0 ? `${data.todos.length} 项` : ''}</span>
          </div>
          {data.todos.length === 0 && <div className="tile-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办 · 在对话里说「记一下：…」即可生成" /></div>}
          {data.todos.map((t) => (
            <div key={t.id} className={`work-todo ${doneIds.has(t.id) ? 'done' : ''}`}>
              <Checkbox checked={doneIds.has(t.id)} onChange={() => completeTodo(t.id)} />
              <Tooltip title={t.source !== 'manual' ? `来自${SOURCE_LABEL[t.source] || '其他来源'}：${t.title}` : ''}>
                <span className="title">{t.title}</span>
              </Tooltip>
              {t.source !== 'manual' && (
                <Tag color="cyan" style={{ fontSize: 11, lineHeight: '16px', flexShrink: 0 }}>
                  {SOURCE_LABEL[t.source] || t.source}
                </Tag>
              )}
            </div>
          ))}
        </section>

        {/* 继续上次 */}
        <section className="work-card">
          <div className="work-card-head">
            <h3>
              <MessageOutlined /> 继续对话
            </h3>
            <Link href="/chat" className="more">
              对话区 <RightOutlined />
            </Link>
          </div>
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            placeholder="筛选对话"
            value={convFilter}
            onChange={(e) => setConvFilter(e.target.value)}
            style={{ marginBottom: 10, maxWidth: 220 }}
          />
          {data.conversations.length === 0 ? (
            <div className="tile-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话 · 点左侧「新建对话」开始" /></div>
          ) : filteredConvs.length === 0 ? (
            <div className="tile-empty">没有匹配的对话</div>
          ) : (
            filteredConvs.map((c) => (
              <Link key={c.id} href={`/chat?conv=${c.id}`} className="work-row">
                <span className="icon"><MessageOutlined /></span>
                <span className="title">{c.pinned && <CopyOutlined style={{ color: 'var(--accent)', marginRight: 4 }} />}{c.title}</span>
                <span className="time">{new Date(c.createdAt).toLocaleDateString()}</span>
              </Link>
            ))
          )}
        </section>

        {/* 最近文件 */}
        <section className="work-card">
          <div className="work-card-head">
            <h3>
              <FolderOpenOutlined /> 最近文件
            </h3>
            <Link href="/files" className="more">
              文件区 <RightOutlined />
            </Link>
          </div>
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            placeholder="筛选文件"
            value={fileFilter}
            onChange={(e) => setFileFilter(e.target.value)}
            style={{ marginBottom: 10, maxWidth: 220 }}
          />
          {data.files.length === 0 ? (
            <div className="tile-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有文件 · 到「文件」页上传，或在对话里直接发" /></div>
          ) : filteredFiles.length === 0 ? (
            <div className="tile-empty">没有匹配的文件</div>
          ) : (
            filteredFiles.map((f) => (
              <Link key={f.id} href="/files" className="work-row">
                <span className="icon">
                  <FileTextOutlined />
                </span>
                <span className="title">{f.filename}</span>
                <span className="time">{fmtSize(f.size)}</span>
              </Link>
            ))
          )}
        </section>

        {/* 定时任务 */}
        <section className="work-card">
          <div className="work-card-head">
            <h3>
              <ClockCircleOutlined /> 定时任务
            </h3>
            <Link href="/schedules" className="more">
              管理 <RightOutlined />
            </Link>
          </div>
          {data.schedules.length === 0 && <div className="tile-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无定时任务 · 到「定时任务」页创建" /></div>}
          {data.schedules.map((sc) => {
            const failed = failedRunIds.has(sc.id);
            return (
              <div key={sc.id} className="work-row-static">
                <span className="icon"><ClockCircleOutlined /></span>
                <span className="title">
                  {sc.name}
                  {!sc.enabled && <Tag color="default" style={{ fontSize: 11, lineHeight: '16px', marginLeft: 6 }}>停用</Tag>}
                  {failed && <Tag color="red" style={{ fontSize: 11, lineHeight: '16px', marginLeft: 6 }}>近 24h 失败</Tag>}
                </span>
                <span className="time">
                  {sc.lastStatus ? (sc.lastStatus === 'ok' ? '上次成功' : '上次失败') : '未运行'}
                </span>
              </div>
            );
          })}
        </section>

        {/* 额度 */}
        <section className="work-card">
          <div className="work-card-head">
            <h3>
              <DashOutlined /> 本月额度
            </h3>
            <span className="work-card-meta">
              <Tag style={{ fontSize: 11, marginInlineEnd: 0 }}>{data.quota.period}</Tag>
              <Link href="/usage" className="more">
                详情 <RightOutlined />
              </Link>
            </span>
          </div>
          <div className="work-quota">
            <div className="bar">
              <div
                className="fill"
                style={{
                  width: `${data.quota.percent}%`,
                  background: data.quota.percent > 80 ? 'var(--danger)' : data.quota.percent > 60 ? 'var(--warning)' : 'var(--accent)',
                }}
              />
            </div>
            <div className="num">
              已用 {data.quota.percent}% · {data.quota.used.toLocaleString()} / {data.quota.limit.toLocaleString()} tokens
            </div>
            {data.quota.trend && data.quota.trend.some((v) => v > 0) && (
              <div className="work-quota-trend">
                <TrendChart data={data.quota.trend} width={260} height={48} ariaLabel="近 6 个月 token 用量趋势" />
                <div className="work-quota-trend-labels">
                  {(data.quota.trendLabels || []).map((m) => (
                    <span key={m}>{m.slice(2)}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="work-notif">
            <BellOutlined style={{ color: 'var(--muted)' }} />
            <span>
              {data.notifications.unread > 0 ? `有 ${data.notifications.unread} 条未读通知（左下角 🔔 查看）` : '暂无未读通知'}
            </span>
          </div>
        </section>

        {/* 最近产物 */}
        <section className="work-card">
          <div className="work-card-head">
            <h3>
              <FilePptOutlined /> 最近产物
            </h3>
            <Link href="/docs" className="more">
              创作区 <RightOutlined />
            </Link>
          </div>
          {data.artifacts.length === 0 && <div className="tile-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有产物 · 在对话里让 AI 生成文档或 PPT" /></div>}
          {data.artifacts.map((a) => (
            <div key={a.id} className="work-row-static">
              <span className="icon">{a.type === 'ppt' ? <FilePptOutlined /> : <FileTextOutlined />}</span>
              <span className="title">{a.title || a.filename}</span>
              <span className="time">{new Date(a.createdAt).toLocaleDateString()}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
