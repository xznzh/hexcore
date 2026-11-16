'use client';

import { ConfigProvider, App as AntdApp, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createContext, useContext, useEffect, useState, useMemo } from 'react';

export type ThemeStyle = 'mini' | 'classic';
export type ThemeCfg = { mode: 'dark' | 'light'; accent: string; style: ThemeStyle };
export const ACCENTS: { key: string; color: string }[] = [
  { key: 'cyan', color: '#22d3ee' },
  { key: 'blue', color: '#3b82f6' },
  { key: 'purple', color: '#a855f7' },
  { key: 'green', color: '#22c55e' },
  { key: 'orange', color: '#f97316' },
  { key: 'pink', color: '#ec4899' },
];

const DEFAULT: ThemeCfg = { mode: 'dark', accent: '#22d3ee', style: 'mini' };
const STORAGE_KEY = 'agent-platform-theme';

type Ctx = { cfg: ThemeCfg; setCfg: (c: ThemeCfg) => void; ready: boolean };
const ThemeCtx = createContext<Ctx>({ cfg: DEFAULT, setCfg: () => {}, ready: false });
export function useThemeCfg() {
  return useContext(ThemeCtx);
}

function buildTheme(mode: 'dark' | 'light', accent: string) {
  const dark = mode === 'dark';
  // 主色加深/提亮，作为 hover；避免只换主色时 hover 仍偏旧色
  const hover = shade(accent, dark ? 12 : -18);
  // 柔化底：用于 Segmented / Tag 等「选中但不要抢主按钮」的场景
  const soft = toRgba(accent, dark ? 0.16 : 0.12);
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorInfo: accent,
      colorPrimaryHover: hover,
      colorPrimaryActive: shade(accent, dark ? 22 : -28),
      borderRadius: 10,
      fontSize: 14,
      colorBgBase: dark ? '#0d1117' : '#f5f7fa',
      colorTextBase: dark ? '#e6edf3' : '#111827',
    },
    components: {
      Layout: {
        bodyBg: dark ? '#0d1117' : '#f5f7fa',
      },
      Card: { colorBgContainer: dark ? '#161b22' : '#ffffff' },
      Table: {
        colorBgContainer: dark ? '#161b22' : '#ffffff',
        // 表头比面板深一档，避免「一片亮块」压过正文
        headerBg: dark ? '#131922' : '#f6f8fb',
        headerColor: dark ? '#8b949e' : '#6b7280',
        rowHoverBg: dark ? '#1b2130' : '#f4f7fb',
      },
      Modal: { contentBg: dark ? '#161b22' : '#ffffff', headerBg: dark ? '#161b22' : '#ffffff' },
      Drawer: { colorBgElevated: dark ? '#161b22' : '#ffffff' },
      // 选中项用主色柔底 + 主色字，而非整块纯色（纯色块会与主按钮互相抢视线）
      Segmented: {
        itemSelectedBg: soft,
        itemSelectedColor: accent,
        itemColor: dark ? '#b3bcc8' : '#4b5563',
        trackBg: dark ? 'rgba(255,255,255,0.04)' : '#eef1f6',
      },
    },
  } as any;
}

// 十六进制 → rgba 字符串
function toRgba(hex: string, a: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// 简单的十六进制调亮/调暗（delta 为正变亮，负变暗），用于生成主色的 hover/active
function shade(hex: string, delta: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp(((n >> 16) & 255) + delta);
  const g = clamp(((n >> 8) & 255) + delta);
  const b = clamp((n & 255) + delta);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// 判断颜色是否为浅色（用于决定用户气泡文字颜色以保证对比度）
function isLightColor(hex: string): boolean {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.7;
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfgState] = useState<ThemeCfg>(DEFAULT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.mode === 'dark' || parsed.mode === 'light') && typeof parsed.accent === 'string') {
          setCfgState({
            mode: parsed.mode,
            accent: parsed.accent,
            style: parsed.style === 'classic' ? 'classic' : 'mini',
          });
        }
      }
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  const setCfg = (c: ThemeCfg) => {
    setCfgState(c);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    } catch {
      /* ignore */
    }
  };

  // 同步到 <html data-theme / data-style> 供 CSS 变量与皮肤覆盖层消费
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', cfg.mode);
      document.documentElement.setAttribute('data-style', cfg.style);
    }
  }, [cfg.mode, cfg.style]);

  // 让 CSS 变量跟随所选主题色（悬停高亮 / 激活底色 / 描边 / 用户气泡），消除硬编码双源
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const hexToRgba = (hex: string, a: number) => {
      const m = hex.replace('#', '');
      const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
      const n = parseInt(full, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    };
    const dark = cfg.mode === 'dark';
    const rgbOf = (hex: string) => {
      const m = hex.replace('#', '');
      const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
      const n = parseInt(full, 16);
      return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    };
    root.style.setProperty('--accent', cfg.accent);
    root.style.setProperty('--accent-rgb', rgbOf(cfg.accent));
    // 副色：与主色同色相的深色调，替代原先硬编码的紫/蓝（换肤后仍然协调）
    root.style.setProperty('--accent-2', shade(cfg.accent, dark ? -66 : -30));
    root.style.setProperty('--accent-hover', shade(cfg.accent, dark ? 12 : -18));
    root.style.setProperty('--accent-soft', hexToRgba(cfg.accent, dark ? 0.14 : 0.1));
    root.style.setProperty('--accent-border', hexToRgba(cfg.accent, dark ? 0.35 : 0.3));
    root.style.setProperty('--user-bubble', cfg.accent);
    // 深色主色（青蓝紫）配深色文字；浅色主色配白字，保证对比度
    root.style.setProperty('--user-bubble-text', isLightColor(cfg.accent) ? '#ffffff' : '#06232b');
  }, [cfg]);

  const antdTheme = useMemo(() => buildTheme(cfg.mode, cfg.accent), [cfg.mode, cfg.accent]);

  return (
    <ThemeCtx.Provider value={{ cfg, setCfg, ready }}>
      <ConfigProvider locale={zhCN} theme={antdTheme}>
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}
