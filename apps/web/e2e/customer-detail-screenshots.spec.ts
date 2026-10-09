/**
 * 客户详情页截图（用于交付说明与人工验收）。
 *
 * 与 screenshots.spec.ts 分开：这个会真实调用贝壳并等待闭环完成，
 * 因此只在需要出图时执行：
 *   pnpm e2e -- customer-detail-screenshots.spec.ts
 */

import { expect, test } from '@playwright/test';

const DEMO_AGENT = { email: 'agent111@estatepilot.demo', password: 'EstatePilot2026!' };

test.describe('客户详情页截图', () => {
  test.setTimeout(240_000);
  test.describe.configure({ mode: 'serial' });

  test('客户列表', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/login');
    await page.getByRole('button', { name: /经纪人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    await page.goto('/customers');
    // 用 heading 定位：'客户管理' 同时出现在侧边栏、面包屑和标题里，
    // 用 getByText 会触发 strict mode 冲突。
    await expect(page.getByRole('heading', { name: '客户管理' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('a[href^="/customers/"]').first()).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: 'screenshots/customer-list.png', fullPage: false });
  });

  test('粘贴消息并等待闭环完成', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto('/login');
    await page.getByRole('button', { name: /经纪人/ }).first().click();
    await page.getByRole('button', { name: /^登录$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    await page.goto('/customers');
    await page.locator('a[href^="/customers/"]').first().click();
    await expect(page.getByText('微信消息智能处理')).toBeVisible({ timeout: 15_000 });

    // 截图 1：空白入口状态
    await page.screenshot({ path: 'screenshots/customer-assistant-empty.png', fullPage: false });

    // 粘贴并执行
    await page
      .getByLabel('客户微信消息')
      .fill(
        '还是想看张江附近吧，三房最好，550左右，600以内也可以，但是别太老的小区，我老婆比较在意小区环境，离地铁最好也别太远。',
      );
    await page.getByRole('button', { name: /AI 识别需求并匹配房源/ }).click();

    // 截图 2：处理中（真实进度）
    //
    // ⚠️ 请求可能非常快（贝壳不可用时走熔断，本地缓存 1 秒内返回），
    // 进度提示一闪而过。这里**不硬断言**，能截到就截，
    // 截不到说明流程已经跑完，后面还会截结果图。
    await page
      .getByText(/正在处理，通常需要/)
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
    await page.screenshot({ path: 'screenshots/customer-assistant-processing.png', fullPage: false });

    // 等闭环结束
    await expect(page.getByRole('button', { name: /处理中/ })).toBeHidden({ timeout: 200_000 });

    const hasResult = await page
      .getByText(/推荐房源（\d+ 套）/)
      .isVisible()
      .catch(() => false);

    if (hasResult) {
      // 截图 3：结果页全貌（需求变化 + 检索依据 + 房源卡片 + 微信文案）
      await page.screenshot({
        path: 'screenshots/customer-assistant-result.png',
        fullPage: true,
      });
    } else {
      // 贝壳不可用时截错误态，同样是有价值的交付证据
      await page.screenshot({
        path: 'screenshots/customer-assistant-error.png',
        fullPage: true,
      });
    }
  });
});
