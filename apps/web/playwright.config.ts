import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E 配置。
 *
 * 说明：
 * - 前后端都由开发者/CI 预先启动（不用 webServer 自动拉起，因为需要 Docker 里的数据库）。
 * - 默认用 Chromium，失败时保留 trace 与截图便于定位。
 * - retries=1：E2E 涉及真实数据库与网络时序，偶发抖动重试一次比直接失败更实用。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    // 前端地址
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // 中文环境，保证日期/货币格式与真实用户一致
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // 移动端视口：客户专属页面主要在微信内置浏览器打开，必须验证
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: /customer-portal\.spec\.ts/,
    },
  ],

  outputDir: 'test-results',
});
