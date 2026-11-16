'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Input, Tag } from 'antd';
import { SearchOutlined, MessageOutlined, FileTextOutlined, DatabaseOutlined, BulbOutlined, ThunderboltOutlined, EnterOutlined, AppstoreOutlined } from '@ant-design/icons';
import { matchNavRoutes } from '@/lib/nav-routes';

type Row = { type: string; id: string; title: string; subtitle: string; url: string };

const TYPE_ICON: Record<string, React.ReactNode> = {
  功能: <AppstoreOutlined />,
  会话: <MessageOutlined />,
  消息: <MessageOutlined />,
  文件: <FileTextOutlined />,
  知识: <DatabaseOutlined />,
  记忆: <BulbOutlined />,
  技能: <ThunderboltOutlined />,
};

const normalize = (r: any): Row => ({ type: String(r?.type || '结果'), id: String(r?.id || ''), title: String(r?.title || ''), subtitle: String(r?.subtitle || ''), url: String(r?.url || '/') });

const QUICK_ACTIONS: Row[] = [
  { type: '动作', id: 'a1', title: '新建对话', subtitle: '去对话区发起新问题', url: '/chat' },
  { type: '动作', id: 'a2', title: '生成文档 / PPT', subtitle: '进入创作区', url: '/docs' },
  { type: '动作', id: 'a3', title: '上传知识库文档', subtitle: '知识库', url: '/knowledge' },
  { type: '动作', id: 'a4', title: '查看今日简报', subtitle: '工作台', url: '/work' },
];

/**
 * 全局命令面板（Ctrl/Cmd + K）：跨 会话/消息/文件/知识库/记忆/技能 搜索 + 快捷动作。
 * 由 AppShell 挂载一次；Nav 中的搜索按钮通过 CustomEvent 唤起。
 */
export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setRows([]);
    setActive(0);
  }, []);

  // 功能入口走本地匹配：打字即出，不等网络；「搜知识库」的第一条应该是知识库页面，而不是谁在对话里提过它
  const navRows = useMemo<Row[]>(
    () =>
      matchNavRoutes(q, 4).map((r) => ({
        type: '功能',
        id: r.path,
        title: r.label,
        subtitle: `${r.group} · ${r.desc}`,
        url: r.path,
      })),
    [q],
  );

  const list = useMemo<Row[]>(() => {
    if (!q.trim()) return QUICK_ACTIONS;
    // 入口在前、内容在后；同一条会话/消息不必重复
    return [...navRows, ...rows].slice(0, 16);
  }, [q, navRows, rows]);

  // 聚合搜索（250ms 防抖 + AbortController 取消旧请求）
  useEffect(() => {
    if (!open) return;
    if (!q.trim()) {
      setRows([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ac.signal })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d) => setRows(Array.isArray(d?.results) ? d.results.map(normalize) : []))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    const onOpenEvt = () => setOpen(true);
    window.addEventListener('cmdk:open', onOpenEvt);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('cmdk:open', onOpenEvt);
    };
  }, [close]);

  function go(r: Row) {
    close();
    router.push(r.url);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, list.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      const r = list[active];
      if (r) go(r);
    }
  }

  if (!open) return null;

  return (
    <div className="cmdk-mask" onMouseDown={close}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <SearchOutlined style={{ color: 'var(--muted)' }} />
          <input
            ref={inputRef}
            value={q}
            placeholder="搜索会话、消息、文件、知识库、记忆、技能…（Enter 打开，Esc 关闭）"
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <Tag style={{ fontSize: 11 }}>Esc</Tag>
        </div>
        <div className="cmdk-list">
          {!q.trim() && <div className="cmdk-group">快捷动作</div>}
          {list.length === 0 && <div className="cmdk-empty">没有找到与「{q}」相关的内容</div>}
          {list.map((r, i) => {
            const prev = list[i - 1];
            const isNav = r.type === '功能';
            const head = isNav ? (!prev || prev.type !== '功能') : prev && prev.type === '功能';
            return (
              <Fragment key={`${r.type}-${r.id}`}>
                {head ? <div className="cmdk-group">{isNav ? '功能入口' : '内容'}</div> : null}
                <Link
                  href={r.url}
                  className={`cmdk-row ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={(e) => {
                    // 拦截默认跳转，走统一关闭 + router.push
                    e.preventDefault();
                    go(r);
                  }}
                >
                  <span className="cmdk-icon">{TYPE_ICON[r.type] || <ThunderboltOutlined />}</span>
                  <span className="cmdk-title">
                    {r.title || r.subtitle}
                    {r.subtitle ? <span className="cmdk-sub">{r.subtitle}</span> : null}
                  </span>
                  <Tag color={isNav ? 'blue' : undefined} style={{ fontSize: 10, lineHeight: '15px', flexShrink: 0 }}>
                    {r.type}
                  </Tag>
                  <span className="cmdk-enter">{i === active && <EnterOutlined />}</span>
                </Link>
              </Fragment>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span>↑↓ 切换</span>
          <span>Enter 打开</span>
          <span>⌘/Ctrl+K 呼出</span>
        </div>
      </div>
    </div>
  );
}
