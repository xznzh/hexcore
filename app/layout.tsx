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

export const metadata: Metadata = {
  title: 'AI Agent Platform · 小团队协作智能体',
  description: '个人发起、小团队共同使用的本地优先 AI 智能体协作平台',
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
