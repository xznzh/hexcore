// 路由级加载骨架：切换菜单时立即给出反馈，避免白屏等待。
export default function Loading() {
  return (
    <div className="page">
      <div className="skeleton-box" style={{ width: 200, height: 26, marginBottom: 8 }} />
      <div className="skeleton-box" style={{ width: 320, height: 14, marginBottom: 24 }} />
      <div className="skeleton-box" style={{ width: '100%', height: 110, marginBottom: 16, borderRadius: 12 }} />
      <div className="skeleton-box" style={{ width: '100%', height: 300, borderRadius: 12 }} />
    </div>
  );
}
