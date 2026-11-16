'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Select } from 'antd';

/** 归属项目选择器：可选，不选＝个人。antd Form 可直接用（受控 value/onChange）。 */
export default function ProjectSelect({
  value,
  onChange,
  style,
}: {
  value?: string | null;
  onChange?: (v: string | null) => void;
  style?: CSSProperties;
}) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setProjects(d))
      .catch(() => {});
  }, []);
  return (
    <Select
      allowClear
      style={{ width: '100%', ...style }}
      placeholder="归属项目（可选，不选＝个人）"
      value={value ?? undefined}
      onChange={(v) => onChange?.(v ?? null)}
      options={projects.map((p) => ({ value: p.id, label: p.name }))}
    />
  );
}
