'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Nav, { type Me } from './Nav';
import { SessionProvider } from './SessionContext';
import CommandPalette from './CommandPalette';
import OfflineBanner from './OfflineBanner';

const AUTH_PAGES = ['/login', '/register'];
const PUBLIC_PAGES = ['/share'];

/**
 * 应用外壳：常驻于根 layout，跨路由不重挂载，因此不再有「点击菜单整页刷新/重复请求」的开销。
 * - me 由服务端在首屏注入；登录后客户端跳转时若为空，兜底拉取一次并自愈。
 * - 登录 / 注册页不渲染侧边栏。
 */
export default function AppShell({ me: initialMe, children }: { me: Me | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(initialMe);
  const isAuthPage =
    AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(p + '/')) ||
    PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(p + '/'));

  useEffect(() => {
    if (isAuthPage) {
      setMe(null);
      return;
    }
    if (initialMe) {
      setMe(initialMe);
      return;
    }
    // 首屏无会话（例如登录后客户端跳转）：兜底获取一次
    let alive = true;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        if (d) setMe(d);
        else fetch('/api/auth/logout', { method: 'POST' }).finally(() => router.replace('/login'));
      })
      .catch(() => router.replace('/login'));
    return () => {
      alive = false;
    };
  }, [initialMe, isAuthPage, router]);

  if (isAuthPage) {
    return <SessionProvider me={null}>{children}</SessionProvider>;
  }

  if (!me) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--muted)' }}>正在加载…</span>
      </div>
    );
  }

  return (
    <SessionProvider me={me}>
      <OfflineBanner />
      <Nav me={me}>{children}</Nav>
      <CommandPalette />
    </SessionProvider>
  );
}
