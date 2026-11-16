'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Avatar, Popover, App, Tooltip, Input, Badge, Empty } from 'antd';
import { useNotifications } from './useNotifications';
import {
  MessageOutlined,
  DatabaseOutlined,
  ToolOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  SettingOutlined,
  LogoutOutlined,
  UserOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  FilePptOutlined,
  FolderOpenOutlined,
  ProjectOutlined,
  BulbOutlined,
  MenuUnfoldOutlined,
  MenuFoldOutlined,
  BgColorsOutlined,
  CommentOutlined,
  ControlOutlined,
  BellOutlined,
  HomeOutlined,
  SearchOutlined,
  DownOutlined,
  BarChartOutlined,
} from '@ant-design/icons';

export type Me = { userId: string; email: string; name: string; role: string };
type NavItem = { key: string; icon: React.ReactNode; label: string };
/** collapsible：低频分组默认收起，点击分组标题展开，减少一级导航密度 */
type NavGroup = { title: string; items: NavItem[]; collapsible?: boolean };

export default function Nav({ me, children }: { me: Me | null; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { modal, message } = App.useApp();
  // 默认固定展开；用户可手动收起，收起后保持固定不随鼠标缩放
  const [collapsed, setCollapsed] = useState(false);
  // 窄屏下展开态 = 覆盖式抽屉，需要一个遮罩承接「点空白处关闭」
  const [isMobile, setIsMobile] = useState(false);
  // 可折叠分组的展开态；未写入 key 时按「激活项是否在该组内」自动决定
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [userOpen, setUserOpen] = useState(false);
  const { unread, items: notifItems, markAllRead } = useNotifications();
  const notifs = { unread, items: notifItems };

  // 断点跟随：≤1100px 默认收起成图标栏（点「展开菜单」才变抽屉），
  // 否则 force-open 会从首屏起就把侧栏固定成抽屉盖住主内容。
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    const apply = (matches: boolean) => {
      setIsMobile(matches);
      if (matches) setCollapsed(true);
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  function openNotifs(open: boolean) {
    if (open && notifs.unread > 0) markAllRead();
  }

  function logout() {
    modal.confirm({
      title: '确认退出登录？',
      okText: '退出',
      cancelText: '取消',
      onOk: async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        message.success('已退出');
        router.replace('/login');
      },
    });
  }

  function feedback() {
    let val = '';
    modal.confirm({
      title: '意见反馈',
      content: (
        <Input.TextArea
          placeholder="说说你的建议或遇到的问题…"
          autoSize={{ minRows: 3, maxRows: 6 }}
          onChange={(e) => (val = e.target.value)}
          style={{ marginTop: 8 }}
        />
      ),
      okText: '提交',
      cancelText: '取消',
      onOk: async () => {
        if (!val.trim()) {
          message.warning('请填写反馈内容');
          return;
        }
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: val.trim() }),
        });
        message.success('感谢反馈！');
      },
    });
  }

  // IA 2.0：一级入口收敛为「工作台 / 对话」双主入口 + 创建 + 知识 + 自动化 + 系统 4 组
  const groups: NavGroup[] = [
    {
      title: '工作区',
      items: [
        { key: '/work', icon: <HomeOutlined />, label: '工作台' },
        { key: '/chat', icon: <MessageOutlined />, label: '对话' },
      ],
    },
    {
      title: '创作与知识',
      items: [
        { key: '/docs', icon: <FileTextOutlined />, label: '文档' },
        { key: '/ppt', icon: <FilePptOutlined />, label: 'PPT' },
        { key: '/knowledge', icon: <DatabaseOutlined />, label: '知识库' },
        { key: '/files', icon: <FolderOpenOutlined />, label: '文件' },
        { key: '/projects', icon: <ProjectOutlined />, label: '项目' },
      ],
    },
    {
      title: '自动化',
      items: [
        { key: '/skills', icon: <ToolOutlined />, label: '技能编排' },
        { key: '/schedules', icon: <ClockCircleOutlined />, label: '定时任务' },
      ],
    },
    {
      title: '更多',
      collapsible: true,
      items: [
        { key: '/memory', icon: <BulbOutlined />, label: '记忆' },
        { key: '/connectors', icon: <ApiOutlined />, label: '连接器' },
        { key: '/capabilities', icon: <ThunderboltOutlined />, label: '能力目录' },
      ],
    },
    {
      title: '系统',
      items: [
        { key: '/usage', icon: <BarChartOutlined />, label: '用量看板' },
        { key: '/settings', icon: <SettingOutlined />, label: '设置' },
        ...(me?.role === 'admin'
          ? [{ key: '/admin', icon: <ControlOutlined />, label: '管理后台' }]
          : []),
      ],
    },
  ];

  if (!me) return null;

  const isActive = (key: string) => pathname === key || pathname.startsWith(key + '/');

  return (
    <div className="app-shell">
      {/* 窄屏抽屉遮罩：点空白处收起，避免侧栏压住主内容又无法退出 */}
      {isMobile && !collapsed && (
        <div className="rail-backdrop" onClick={() => setCollapsed(true)} aria-hidden="true" />
      )}
      <aside className={`rail ${collapsed ? 'collapsed' : 'expanded'}${isMobile && !collapsed ? ' force-open' : ''}`}>
        <Link href="/work" className="rail-logo">
          <ThunderboltOutlined />
          <span className="rail-logo-text">AI Agent 平台</span>
        </Link>

        <nav className="rail-nav">
          {groups.map((g) => {
            const groupActive = g.items.some((it) => isActive(it.key));
            const userSet = openGroups[g.title];
            // 收起态只有图标，分组标题本就隐藏，直接平铺；未手动操作过时跟随「是否在当前分组内」
            const open = collapsed || !g.collapsible || (userSet === undefined ? groupActive : userSet);
            return (
              <div key={g.title}>
                {g.collapsible && !collapsed ? (
                  <button
                    type="button"
                    className={`rail-group-title rail-group-toggle ${open ? 'open' : ''}`}
                    aria-expanded={open}
                    onClick={() => setOpenGroups((m) => ({ ...m, [g.title]: !open }))}
                  >
                    <span>{g.title}</span>
                    <DownOutlined className="rail-group-chevron" />
                  </button>
                ) : (
                  <div className="rail-group-title">{g.title}</div>
                )}
                {open &&
                  g.items.map((it) => (
                    <Tooltip key={it.key} title={collapsed ? it.label : ''} placement="right" mouseEnterDelay={0.3}>
                      <Link
                        href={it.key}
                        className={`rail-item ${isActive(it.key) ? 'active' : ''}`}
                        onClick={(e) => {
                          // 断网时客户端导航拿不到 RSC 载荷，页面会直接白屏。
                          // 这里先拦住并提示，比让用户对着空白页发呆要好。
                          if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                            e.preventDefault();
                            message.error('网络已断开，暂时无法切换页面；恢复后会自动可用');
                            return;
                          }
                          // 移动端抽屉态：点击导航项后自动收起，避免遮挡主内容区
                          if (isMobile) setCollapsed(true);
                        }}
                      >
                        <span className="rail-icon">{it.icon}</span>
                        <span className="rail-label">{it.label}</span>
                      </Link>
                    </Tooltip>
                  ))}
              </div>
            );
          })}
        </nav>

        <div className="rail-footer">
          <button
            className="rail-item"
            style={{ width: 'calc(100% - 16px)', textAlign: 'left' }}
            onClick={() => window.dispatchEvent(new CustomEvent('cmdk:open'))}
          >
            <span className="rail-icon">
              <SearchOutlined />
            </span>
            <span className="rail-label">全局搜索 ⌘K</span>
          </button>
          <Popover
            trigger={['click']}
            placement="topRight"
            arrow={false}
            onOpenChange={openNotifs}
            styles={{ body: { padding: '12px 10px', width: 300, maxHeight: 420, overflow: 'auto' } }}
            content={
              notifs.items.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知" />
              ) : (
                notifs.items.map((n) => (
                  <div key={n.id} style={{ padding: '8px 4px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{n.title}</div>
                    {n.body && <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{n.body}</div>}
                    <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                ))
              )
            }
          >
            <button className="rail-item" style={{ width: 'calc(100% - 16px)', textAlign: 'left' }}>
              <span className="rail-icon">
                <Badge count={notifs.unread} size="small" offset={[2, -2]} overflowCount={99}>
                  <BellOutlined />
                </Badge>
              </span>
              <span className="rail-label">通知</span>
            </button>
          </Popover>
          <button
            className="rail-item"
            style={{ width: 'calc(100% - 16px)', textAlign: 'left' }}
            // 收起态下文字被 CSS 隐藏，读屏/自动化拿不到名字，这里显式给一个
            aria-label={collapsed ? '展开菜单' : '收起菜单'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            <span className="rail-icon">{collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}</span>
            <span className="rail-label">{collapsed ? '展开菜单' : '收起菜单'}</span>
          </button>
          <Popover
            open={userOpen}
            onOpenChange={setUserOpen}
            placement="topRight"
            trigger={['click']}
            arrow={false}
            styles={{ body: { padding: '12px 10px' } }}
            content={
              <div className="user-panel">
                <div className="user-panel-head">
                  <Avatar size={40} style={{ backgroundColor: 'var(--accent)', color: 'var(--user-bubble-text)', flexShrink: 0 }} icon={<UserOutlined />} />
                  <div className="user-panel-meta">
                    <div className="user-panel-name">
                      <span>{me.name}</span>
                      {me.role === 'admin' && <span className="user-panel-role">管理员</span>}
                    </div>
                    <div className="user-panel-email">{me.email}</div>
                  </div>
                </div>
                <div className="user-panel-menu">
                  <button onClick={() => { setUserOpen(false); router.push('/settings'); }}>
                    <SettingOutlined /><span>设置</span>
                  </button>
                  <button onClick={() => { setUserOpen(false); router.push('/settings#appearance'); }}>
                    <BgColorsOutlined /><span>外观</span>
                  </button>
                  {me.role === 'admin' && (
                    <button onClick={() => { setUserOpen(false); router.push('/admin'); }}>
                      <ThunderboltOutlined /><span>管理后台</span>
                    </button>
                  )}
                  <button onClick={() => { setUserOpen(false); setTimeout(feedback, 100); }}>
                    <CommentOutlined /><span>意见反馈</span>
                  </button>
                </div>
                <div className="user-panel-sep" />
                <button className="user-panel-logout" onClick={logout}>
                  <LogoutOutlined /><span>退出登录</span>
                </button>
              </div>
            }
          >
            <button className="rail-user">
              <Avatar size={26} style={{ backgroundColor: 'var(--accent)', color: 'var(--user-bubble-text)', flexShrink: 0 }} icon={<UserOutlined />} />
              <span className="rail-user-name">
                <span className="rail-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {me.name}
                </span>
                {me.role === 'admin' && <span className="rail-user-role">管理员</span>}
              </span>
            </button>
          </Popover>
        </div>
      </aside>

      <main className="app-main">{children}</main>
    </div>
  );
}
