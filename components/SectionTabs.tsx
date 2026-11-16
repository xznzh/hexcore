'use client';

import { Segmented } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * IA 2.0 的区段切换条：在相关页面顶部提供 Segmented 导航（保留原 URL，零迁移）。
 * 例如 文档↔PPT、知识库↔文件 之间一键切换。
 */
export default function SectionTabs({
  options,
}: {
  options: { value: string; label: string; url: string }[];
}) {
  const pathname = usePathname();
  const current = options.find((o) => pathname === o.url || pathname.startsWith(o.url + '/'));
  return (
    <div className="section-tabs">
      <Segmented
        value={current?.value ?? options[0]?.value}
        options={options.map((o) => ({
          value: o.value,
          label: (
            <Link href={o.url} style={{ color: 'inherit', padding: '0 6px' }}>
              {o.label}
            </Link>
          ),
        }))}
      />
    </div>
  );
}
