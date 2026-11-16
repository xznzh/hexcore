'use client';

// 管理后台较重（抽屉/表格/评估面板），改为客户端懒加载分包，减小首包体积
import dynamic from 'next/dynamic';
import { Spin } from 'antd';

const AdminClient = dynamic(() => import('./AdminClient'), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <Spin />
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>正在加载管理后台…</span>
      </div>
    </div>
  ),
});

export default function AdminPage() {
  return <AdminClient />;
}