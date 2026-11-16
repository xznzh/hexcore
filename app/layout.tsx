import './globals.css';
import type { Metadata } from 'next';
import localFont from 'next/font/local';
import Providers from '@/components/Providers';
import AppShell from '@/components/AppShell';
import { getSession } from '@/lib/auth';

// 字体本地化：不再依赖 fonts.googleapis.com CDN（国内环境阻塞/拖慢首屏），改为自托管
const sora = localFont({
  src: [
    { path: './fonts/Sora-400.ttf', weight: '400' },
    { path: './fonts/Sora-500.ttf', weight: '500' },
    { path: './fonts/Sora-600.ttf', weight: '600' },
    { path: './fonts/Sora-700.ttf', weight: '700' },
  ],
  variable: '--font-sora',
  display: 'swap',
});
const jbMono = localFont({
  src: [
    { path: './fonts/JetBrainsMono-400.ttf', weight: '400' },
    { path: './fonts/JetBrainsMono-500.ttf', weight: '500' },
  ],
  variable: '--font-jbmono',
  display: 'swap',
});
// 中文显示字体：Noto Sans SC（OFL 1.1，可商用、可自托管）。
// Sora 只有拉丁字形，中文此前一直回退到系统字（PingFang / 雅黑），
// 导致「AI Agent」用 Sora、中文用系统字，两种气质混排。
// 这里只带 400/600 两档（常用汉字子集，约 1.1MB/档），
// preload 关掉——CJK 体积大，交给「用到才下载」比首屏预载更稳。
const notoSansSC = localFont({
  src: [
    { path: './fonts/NotoSansSC-400.woff2', weight: '400' },
    { path: './fonts/NotoSansSC-600.woff2', weight: '600' },
  ],
  variable: '--font-noto-sc',
  display: 'swap',
  preload: false,
});

/**
 * 站点元信息。
 *
 * metadataBase 必须显式给：否则 openGraph 里的相对图片地址不会升级成绝对 URL，
 * 微信 / Twitter / Slack 抓取时拿不到图，分享卡片就是一张空白。
 * 优先用 APP_ORIGINS（对外域名），退回本机地址；只影响分享卡片，不影响鉴权。
 */
const SITE_URL = (process.env.APP_ORIGINS || '').split(',')[0]?.trim() || 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: (() => {
    try {
      return new URL(SITE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })(),
  title: 'Hexcore · 小团队 AI Agent 协作平台',
  description:
    '可私有化部署的小团队 AI Agent 平台：对话、RAG 知识库、技能编排、能力网关、定时任务，全部跑在自己的 PostgreSQL 上。不配模型 Key 也能用演示模式跑通全链路。',
  applicationName: 'Hexcore',
  keywords: ['AI Agent', 'RAG', '知识库', '私有化部署', 'MCP', 'Next.js', 'PostgreSQL', 'pgvector'],
  openGraph: {
    type: 'website',
    siteName: 'Hexcore',
    title: 'Hexcore · 私有化部署的 AI Agent 协作平台',
    description: '对话 / RAG / 技能编排 / 定时任务，工具调用四道关（权限 → 审批 → 超时 → 审计），缺什么降级什么。',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Hexcore' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hexcore · 私有化部署的 AI Agent 协作平台',
    description: '对话 / RAG / 技能编排 / 定时任务，全部跑在你自己的 PostgreSQL 上。',
    images: ['/og.png'],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 服务端一次性读取会话，注入给常驻外壳，避免每次导航重复请求 /api/auth/me
  const me = await getSession();
  return (
    <html lang="zh-CN" className={`${sora.variable} ${jbMono.variable} ${notoSansSC.variable}`}>
      <body>
        <Providers>
          <AppShell me={me}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
