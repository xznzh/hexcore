'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 未读通知轮询：
 * - 页面可见时每 60s 拉一次；不可见不请求（省流量）；
 * - Tab 获得焦点 / 从 work 页标记变化后即时刷新；
 * - 返回 { unread, items, refresh }，通知面板数据与未读数共用一份请求。
 */
export type NotifItem = { id: string; title: string; body: string | null; read: boolean; createdAt: number };

export function useNotifications() {
  const [state, setState] = useState<{ unread: number; items: NotifItem[] }>({ unread: 0, items: [] });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    fetch('/api/notifications')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setState(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, 60_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', refresh);
    return () => {
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const markAllRead = useCallback(() => {
    fetch('/api/notifications', { method: 'PATCH' }).catch(() => {});
    setState((n) => ({ unread: 0, items: n.items.map((x) => ({ ...x, read: true })) }));
  }, []);

  return { ...state, refresh, markAllRead };
}
