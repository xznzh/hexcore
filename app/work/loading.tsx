// 工作台骨架：与 /work 页面结构一致的加载占位
export default function Loading() {
  return (
    <div className="work-shell">
      <div style={{ display: 'flex', gap: 40, alignItems: 'center' }}>
        <div className="skeleton-box" style={{ width: 260, height: 30 }} />
        <div className="skeleton-box" style={{ width: 180, height: 16 }} />
      </div>
      <div className="skeleton-box" style={{ width: '100%', height: 88, margin: '24px 0', borderRadius: 16 }} />
      <div className="skeleton-box" style={{ width: '100%', height: 120, marginBottom: 14, borderRadius: 14 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton-box" style={{ width: '100%', height: 170, borderRadius: 14 }} />
        ))}
      </div>
    </div>
  );
}
