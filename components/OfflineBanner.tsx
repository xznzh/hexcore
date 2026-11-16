'use client';

import { useEffect, useState } from 'react';

/**
 * 断网提示条。
 *
 * 为什么需要：弱网/断网时，页面本身还能渲染（已在内存里），但接口全部失败。
 * 用户看到的往往是「点了没反应 / 一直转圈 / 白屏」，不知道是系统坏了还是网断了。
 * 这里在顶部给一条常驻提示，恢复后自动消失，给出「现在别做写操作」的明确信号。
 */
export default function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    // 只有「断网 → 恢复」才短暂提示；首次挂载本来就是在线，不该弹「网络已恢复」
    let wasOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const sync = () => {
      const off = typeof navigator !== 'undefined' && navigator.onLine === false;
      setOffline(off);
      if (wasOffline && !off) {
        setRecovered(true);
        setTimeout(() => setRecovered(false), 3000);
      }
      wasOffline = off;
    };
    sync();
    window.addEventListener('offline', sync);
    window.addEventListener('online', sync);
    return () => {
      window.removeEventListener('offline', sync);
      window.removeEventListener('online', sync);
    };
  }, []);

  if (!offline && !recovered) return null;

  return (
    // 颜色/定位都在 app/globals.css 的 .offline-banner 里，跟着主题变量走
    <div className={`offline-banner${offline ? '' : ' is-recovered'}`} role="status" aria-live="polite">
      {offline ? '网络已断开：页面展示的是缓存数据，发送/保存等操作会失败，恢复网络后自动可用。' : '网络已恢复'}
    </div>
  );
}
