'use client';

import { ReactNode } from 'react';

export default function PageHeader({
  title,
  desc,
  extra,
}: {
  title: ReactNode;
  desc?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {desc && <div className="desc">{desc}</div>}
      </div>
      {extra && <div className="page-header-extra">{extra}</div>}
    </div>
  );
}
