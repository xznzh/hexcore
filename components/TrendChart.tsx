'use client';

import React from 'react';

type Props = {
  data: number[];
  width?: number;
  height?: number;
  /** 线条/渐变颜色，可传 CSS 变量如 'var(--accent)' */
  color?: string;
  /** 是否绘制面积渐变填充（默认 true） */
  fill?: boolean;
  /** 是否绘制数据点圆点（默认 false） */
  dots?: boolean;
  ariaLabel?: string;
  className?: string;
};

/**
 * 零依赖 SVG 趋势图（面积 / 折线）。
 * 用于成本、调用量、token 消耗的轻量可视化，跟随主题色。
 * 不依赖任何图表库，避免为本就偏重的界面再引入打包体积。
 */
export default function TrendChart({
  data,
  width = 240,
  height = 64,
  color = 'var(--accent)',
  fill = true,
  dots = false,
  ariaLabel,
  className,
}: Props) {
  // Hook 必须在任何提前 return 之前调用：若放在 `if (!data.length) return null` 之后，
  // 数据从「有」变「空」时本次渲染的 hook 数量会变少，React 直接抛
  // "Rendered fewer hooks than expected"（筛选/刷新把曲线清空时必然复现）。
  const gradId = `trend-${React.useId().replace(/:/g, '')}`;

  if (!data.length) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pad = 3;
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;

  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - pad * 2) - pad;
    return [x, y] as [number, number];
  });

  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
    .join(' ');
  const area = `${line} L${width.toFixed(1)},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gradId})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {dots &&
        pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={2} fill={color} />
        ))}
    </svg>
  );
}
