/**
 * 界面截图脚本（用于设计评审与回归对比）。
 *
 * 用法：
 *   pnpm --filter @estatepilot/web exec playwright test e2e/screenshots.spec.ts
 *
 * 截图输出到 screenshots/ 目录。
 */

import { expect, test } from '@playwright/test';

const DEMO_AGENT = { email: 'agent111@estatepilot.demo', password: 'EstatePilot2026!' };

test.describe('界面截图', () => {
  test('登录页', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'screenshots/01-login.png', fullPage: false });
    await expect(page.getByRole('heading', { name: /登录工作台/ })).toBeVisible();
  });

  test('工作台（桌面端全屏）', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /经纪人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    // 等工作台数据加载完成（AI 发现区块出现即代表数据已就绪）
    await expect(page.getByText('今天 AI 帮你发现了什么')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);

    await page.screenshot({ path: 'screenshots/02-dashboard.png', fullPage: true });
  });

  test('工作台（首屏，不含滚动）', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /经纪人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText('今天 AI 帮你发现了什么')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);

    await page.screenshot({ path: 'screenshots/03-dashboard-viewport.png', fullPage: false });
  });

  test('移动端工作台（微信内打开的典型视口）', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    await page.getByRole('button', { name: /经纪人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText('今天 AI 帮你发现了什么')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);

    await page.screenshot({ path: 'screenshots/04-dashboard-mobile.png', fullPage: false });
  });
});
