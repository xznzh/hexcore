'use client';

// 路由级通用错误边界：给出可操作的提示而不是白屏裸报错
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="notfound-wrap">
      <div style={{ fontSize: 30, marginBottom: 6 }}>⚠️ 页面加载出错</div>
      <div style={{ color: 'var(--muted)', maxWidth: 480, wordBreak: 'break-all', margin: '0 0 18px' }}>
        {error?.message || '未知错误'}（{error?.digest || '无追踪 ID'}）
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <a
          href="/work"
          className="antd-btn-hyper"
        >
          返回工作台
        </a>
        <a
          onClick={reset}
          className="antd-btn-hyper"
        >
          重试
        </a>
      </div>
    </div>
  );
}
