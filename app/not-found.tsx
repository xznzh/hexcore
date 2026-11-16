import Link from 'next/link';

// 自定义 404：避免 Next 默认黑底白字风格与产品不符
export default function NotFound() {
  return (
    <div className="notfound-wrap">
      <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: '-0.02em' }}>404</div>
      <div style={{ color: 'var(--muted)', margin: '6px 0 18px' }}>这个页面不存在或已被移动。</div>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link href="/work" className="antd-btn-hyper">
          返回工作台
        </Link>
        <Link href="/chat" className="antd-btn-hyper">
          去对话
        </Link>
      </div>
    </div>
  );
}
