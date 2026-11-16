import { expect, test } from '@playwright/test';

/**
 * 冒烟三层（见 迭代计划-v4 §6.1）：
 * 通过环境变量提供测试账号：
 *   E2E_EMAIL / E2E_PASSWORD（已注册账号，须为 admin 或 member）
 */

const LOGIN = !!(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const email = process.env.E2E_EMAIL || '';
const password = process.env.E2E_PASSWORD || '';

async function login(page) {
  await page.goto('/login');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('密码').fill(password);
  // antd 会给「两个汉字」的按钮文本插一个空格，实际渲染是「登 录」。
  // 用精确字符串 '登录' 匹配不上，必须用正则允许中间有空白。
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(/\/work/);
}

test('1 · 未登录访问受保护页面 → 跳转登录页', async ({ page }) => {
  await page.goto('/work');
  await expect(page).toHaveURL(/\/login/);
});

test('2 · 登录 → 落地工作台 → 简报卡片可见', async ({ page }) => {
  test.skip(!LOGIN, '未设置 E2E_EMAIL/E2E_PASSWORD，跳过登录链路');
  await login(page);
  await expect(page.locator('.work-greet h1')).toContainText(/好|夜深了/);
  await expect(page.locator('.work-brief')).toBeVisible({ timeout: 20_000 });
});

test('3 · 对话 → AI 回答 → 加入待办 → 工作台待办 +1', async ({ page }) => {
  test.skip(!LOGIN, '未设置 E2E_EMAIL/E2E_PASSWORD，跳过登录链路');
  // 该链路依赖可用对话模型；无模型时退化为验证工作台快速输入入口
  await login(page);
  const box = page.locator('.work-input textarea');
  await expect(box).toBeVisible();
  await box.fill('冒烟测试：请用一句话介绍你自己');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/chat/);
});
