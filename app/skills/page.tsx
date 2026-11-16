'use client';

// 技能编排（画布/抽屉较重），改为客户端懒加载分包
import dynamic from 'next/dynamic';
import { Spin } from 'antd';

const SkillsClient = dynamic(() => import('./SkillsClient'), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <Spin />
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>正在加载技能编排…</span>
      </div>
    </div>
  ),
});

export default function SkillsPage() {
  return <SkillsClient />;
}