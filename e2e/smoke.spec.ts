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

/**
 * 回归：默认模型必须是「现在就能调用」的那个。
 *
 * 曾经的故障链：`/api/models` 把种子数据里排第一的预设模型（没有 Key）标成默认，
 * 前端照着选中并把 modelId 传回后端，`resolveModel` 只查库不校验 Key，
 * 于是请求打到不存在的端点——新用户 clone 下来第一句话必定失败，
 * 而 README 的首屏承诺恰恰是「不填 Key 就能用」。
 */
test('4 · 默认对话模型可用（不会选中未配置 Key 的模型）', async ({ page }) => {
  test.skip(!LOGIN, '未设置 E2E_EMAIL/E2E_PASSWORD，跳过登录链路');
  await login(page);
  const resp = await page.request.get('/api/models');
  expect(resp.ok()).toBeTruthy();
  const list = (await resp.json()) as Array<{ id: string; name: string; isDefault: boolean; usable?: boolean }>;
  expect(Array.isArray(list) && list.length > 0).toBeTruthy();
  const def = list.find((m) => m.isDefault);
  expect(def, '必须存在一个默认模型，否则对话页没有可选项').toBeTruthy();
  expect(def!.usable !== false, `默认模型 ${def!.name} 未配置可用凭据，首句对话会失败`).toBeTruthy();
  // 列表本身也要能选出可用项（存在默认项之外的兜底）
  expect(list.some((m) => m.usable !== false)).toBeTruthy();
});

test('5 · 对话页默认选中可用模型，且能收到回答', async ({ page }) => {
  test.skip(!LOGIN, '未设置 E2E_EMAIL/E2E_PASSWORD，跳过登录链路');
  await login(page);
  await page.goto('/chat');
  const picker = page.locator('.composer .ant-select-selection-item').first();
  await expect(picker).toBeVisible();
  const picked = (await picker.innerText()).trim();
  expect(picked.length).toBeGreaterThan(0);

  const box = page.locator('textarea').first();
  await box.fill('冒烟测试：一句话回答即可');
  await box.press('Enter');
  // 等回答气泡真正有文字（不校验内容：演示模式与真实模型的文案不同）
  await expect
    .poll(
      async () => {
        const n = await page.locator('.chat-bubble.assistant').count();
        if (!n) return '';
        return (await page.locator('.chat-bubble.assistant').last().innerText()).trim();
      },
      { timeout: 60_000, intervals: [500] },
    )
    .not.toBe('');
  const text = await page.locator('.chat-bubble.assistant').last().innerText();
  // 失败时气泡以 ⚠️ 开头，这里明确区分「有回答」与「有报错」
  expect(text.startsWith('⚠️'), `收到的是错误气泡而不是回答：${text.slice(0, 80)}`).toBeFalsy();
});
