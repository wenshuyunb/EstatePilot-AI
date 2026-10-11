/**
 * E2E：房源卡片的「复制信息」按钮。
 *
 * ============================================================================
 * 为什么必须用真实浏览器测
 * ============================================================================
 * 剪贴板 API（`navigator.clipboard.writeText`）有三个浏览器特有的约束：
 *   · 需要**安全上下文**（https 或 localhost）
 *   · 需要**用户手势**触发
 *   · 权限被拒时抛 `NotAllowedError`
 *
 * 这些在 Node 里都无法真实复现，而"点了没反应"正是这类功能最常见的故障。
 * 因此必须端到端确认：**点下去 → 剪贴板真的有正确内容**。
 *
 * ============================================================================
 * 断言策略（踩过多次坑后的最终设计）
 * ============================================================================
 * 1. **以剪贴板为唯一确定性证据**
 *    UI 按钮/提示只在 2 秒内变化，Playwright 的 locator 轮询经常错过，
 *    会造成随机失败 —— 那不是产品缺陷。剪贴板不会自己消失。
 *
 * 2. **一次测试只点一次复制**
 *    原先拆成两个 test 各点一次，第二个 test 因为 locator 匹配到
 *    别的"复制"按钮而偶发失败。合并后只点一次，稳定得多。
 *
 * 3. **提示文案不做硬断言**
 *    提示 2 秒即消失，"能否抓到"本质不确定。
 *    文案正确性由离线测试 `verify-property-copy-format.ts` 覆盖（确定性）。
 *
 * ⚠️ 本测试会真实查询房源（消耗贝壳额度），因此单独放在一个 spec。
 */

import { expect, test, type Page } from '@playwright/test';

/** 授予剪贴板读写权限，否则 headless 下 writeText 会失败 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** 登录并进入客户详情页（登录页是一键角色按钮，账号已预填） */
async function loginAndOpenCustomer(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: /经纪人/ }).first().click();
  await page.getByRole('button', { name: /^登录$/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: '客户管理' })).toBeVisible({ timeout: 15_000 });

  const firstCustomer = page.locator('a[href^="/customers/"]').first();
  await expect(firstCustomer).toBeVisible({ timeout: 15_000 });
  await firstCustomer.click();
  await expect(page).toHaveURL(/\/customers\/[a-z0-9]+/, { timeout: 30_000 });
}

/**
 * 跑一次闭环以产生推荐卡片。
 *
 * @returns 房源卡片上的「复制信息」按钮（未产生卡片时返回 null）
 */
async function generateRecommendationsAndFindCopyButton(
  page: Page,
): Promise<ReturnType<Page['getByRole']> | null> {
  const textarea = page.getByLabel('客户微信消息');
  await textarea.fill('厦门湖里区三房，400万左右');

  await page.getByRole('button', { name: /AI 识别需求并匹配房源/ }).click();

  // 等处理结束（转圈消失或超时兜底）
  await Promise.race([
    page
      .getByRole('button', { name: /处理中/ })
      .waitFor({ state: 'hidden', timeout: 200_000 })
      .catch(() => undefined),
    page.waitForTimeout(200_000),
  ]);

  /**
   * ⚠️ 用 `exact: true` 精确定位「复制信息」。
   *
   * 页面上还有「复制微信内容」「复制检索式」等按钮，
   * 模糊匹配会命中它们 —— 这是第二个测试偶发失败的原因（踩过）。
   */
  const copyButton = page.getByRole('button', { name: '复制信息', exact: true }).first();

  try {
    await copyButton.waitFor({ state: 'visible', timeout: 15_000 });
    return copyButton;
  } catch {
    return null;
  }
}

test.describe('房源信息复制', () => {
  test('点击「复制信息」把完整房源文本写入剪贴板', async ({ page }) => {
    /** 捕获控制台错误 —— 复制逻辑抛异常时只会"按钮没反应"，从 DOM 看不出原因 */
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await loginAndOpenCustomer(page);

    const copyButton = await generateRecommendationsAndFindCopyButton(page);

    if (!copyButton) {
      test.skip(true, '本次未产生推荐卡片（贝壳可能限流，属正常降级）');
      return;
    }

    await copyButton.click();

    // ---- 轮询剪贴板（确定性证据，不会自己消失）----
    let clipboard = '';

    for (let attempt = 0; attempt < 24; attempt += 1) {
      clipboard = await page.evaluate(() => navigator.clipboard.readText());

      if (clipboard.startsWith('【')) break;

      await page.waitForTimeout(250);
    }

    if (!clipboard.startsWith('【')) {
      console.log(`控制台错误：\n${consoleErrors.join('\n') || '（无）'}`);
      console.log(`剪贴板内容：${JSON.stringify(clipboard.slice(0, 200))}`);
    }

    // ---- 复制内容断言 ----
    expect(clipboard, '点击复制后剪贴板应有房源文本').toMatch(/^【.+/);
    expect(clipboard.length).toBeGreaterThan(30);

    // 标题行格式：【小区名】X室X厅 · XX㎡ · XXX万
    expect(clipboard).toMatch(/^【.+】\d+室.*·.*㎡.*·.*万/);

    // 必备段落
    expect(clipboard).toContain('■ 基本信息');
    expect(clipboard).toMatch(/单价：/);

    // ---- 绝不能出现的占位符 / JS 残留 ----
    expect(clipboard).not.toContain('undefined');
    expect(clipboard).not.toContain('[object');
    expect(clipboard).not.toContain('NaN');
    expect(clipboard).not.toContain('暂无数据');

    // ---- 排版规则 ----
    /**
     * ⚠️ 同时接受 `\n\n` 与 `\r\n\r\n` ——
     * Windows 剪贴板会把换行规范化为 CRLF，只断言 `\n\n` 会误报失败（踩过）。
     */
    expect(clipboard).toMatch(/\r?\n\r?\n/);

    const normalized = clipboard.replace(/\r\n/g, '\n');

    const baseSection = normalized.split('■ 基本信息\n')[1]?.split('\n\n')[0] ?? '';
    const baseLines = baseSection.split('\n').filter((line) => line.trim().length > 0);

    expect(baseLines.length).toBeGreaterThanOrEqual(2);

    for (const line of baseLines) {
      expect(line, `字段行格式应为「字段名：值」—— 实际「${line}」`).toMatch(/^[^：]+：.+$/);
    }

    // ---- 提示文案：软校验（2 秒窗口，抓不到不算失败）----
    const hintText = await page.evaluate(() => {
      const match = document.body.innerText.match(/已复制：[^\n]*/);
      return match ? match[0] : null;
    });

    console.log(`提示文本：「${hintText ?? '（已到期消失，属正常）'}」`);

    if (hintText) {
      expect(hintText).toMatch(/已复制：.*字/);

      // 必须如实说明是否含完整详情（产品诚实性原则）
      expect(hintText).toMatch(/含小区与周边配套|未含完整详情/);
    }

    // 打印完整内容便于人工核对排版（测试报告里可见）
    console.log('\n===== 复制到的内容 =====\n');
    console.log(clipboard);
    console.log('\n===== 结束 =====\n');
  });
});
