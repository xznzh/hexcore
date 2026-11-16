import { defineConfig } from '@playwright/test';

// 冒烟 E2E 配置。
// 首次运行需：pnpm exec playwright install chromium
//
// 为什么要有 webServer：原来没配，直接 `pnpm e2e` 会在第一个 page.goto 就
// ERR_CONNECTION_REFUSED，必须人工先起服务——CI 里根本跑不起来。
// 就绪判定复用 `/api/health` 的存活探针（不碰数据库，几毫秒返回）。
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    headless: true,
  },
  workers: 1,
  // 指向外部环境（E2E_BASE_URL）时不该再拉起本地服务
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
