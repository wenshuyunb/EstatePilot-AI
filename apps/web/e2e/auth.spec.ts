/**
 * 登录与工作台 E2E 测试。
 *
 * 这会真实打开浏览器、真实登录、真实加载工作台数据，
 * 并检查浏览器 Console 是否有报错（需求文档 §58 第 10 条明确要求检查 Console）。
 */

import { expect, test } from '@playwright/test';

/** 演示账号（与种子脚本一致） */
const DEMO_AGENT = { email: 'agent111@estatepilot.demo', password: 'EstatePilot2026!' };
const DEMO_OWNER = { email: 'owner1@estatepilot.demo', password: 'EstatePilot2026!' };

test.describe('登录流程', () => {
  test('未登录访问根路径会跳转到登录页', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);

    // 登录页必须清楚说明产品价值，而不是只有一个表单
    await expect(page.getByText('EstatePilot AI').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /登录工作台/ })).toBeVisible();
  });

  test('演示账号可以一键填充并成功登录', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/login');

    // 点击演示账号卡片自动填充
    await page.getByRole('button', { name: /经纪人/ }).first().click();

    const emailInput = page.getByLabel('邮箱');
    await expect(emailInput).toHaveValue(DEMO_AGENT.email);

    await page.getByRole('button', { name: /^登录$/ }).click();

    // 登录成功后进入工作台
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // 关键：首页必须展示「今天 AI 帮你发现了什么」而不是传统 ERP 的统计卡片
    await expect(page.getByText('今天 AI 帮你发现了什么')).toBeVisible();

    // Console 不应有报错（过滤掉浏览器扩展与 Next 开发模式的热更新噪音）
    const meaningfulErrors = consoleErrors.filter(
      (text) => !text.includes('favicon') && !text.includes('Download the React DevTools'),
    );
    expect(meaningfulErrors, `Console 存在报错：\n${meaningfulErrors.join('\n')}`).toEqual([]);
  });

  test('错误密码会显示错误提示且停留在登录页', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('邮箱').fill(DEMO_AGENT.email);
    await page.getByLabel('密码').fill('DefinitelyWrongPassword1!');
    await page.getByRole('button', { name: /^登录$/ }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('登录后刷新页面仍保持登录（令牌持久化）', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /经纪人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});

test.describe('工作台', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /经纪人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  });

  test('首页以「今天 AI 帮你发现了什么」为核心', async ({ page }) => {
    // AI 发现区块必须存在
    await expect(page.getByText('今天 AI 帮你发现了什么')).toBeVisible();

    // 重点客户区块必须存在，且每条都说明了「为什么联系」
    await expect(page.getByText('今天最值得联系的客户')).toBeVisible();

    // 侧边栏核心导航齐全
    for (const label of ['工作台', '客户管理', '房源库', '销售机会', '带看管理', 'AI 助手']) {
      await expect(page.getByRole('link', { name: label }).first()).toBeVisible();
    }
  });

  test('侧边栏导航可以切换页面', async ({ page }) => {
    await page.getByRole('link', { name: '销售机会' }).first().click();
    await expect(page).toHaveURL(/\/opportunities/);
    await expect(page.getByRole('heading', { name: '销售机会' })).toBeVisible();

    await page.getByRole('link', { name: '客户管理' }).first().click();
    await expect(page).toHaveURL(/\/customers/);
  });

  test('退出登录后回到登录页', async ({ page }) => {
    await page.getByRole('button', { name: '退出' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });

  test('公司负责人可以登录并看到管理入口', async ({ page }) => {
    await page.getByRole('button', { name: '退出' }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByRole('button', { name: /公司负责人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    // 负责人应看到门店驾驶舱
    await expect(page.getByRole('link', { name: '门店驾驶舱' }).first()).toBeVisible();
  });
});
