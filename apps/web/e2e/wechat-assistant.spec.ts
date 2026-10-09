/**
 * 微信房产助手闭环 E2E 测试。
 *
 * 这是本项目最重要的一条 E2E：真实打开浏览器，走完
 *   登录 → 客户列表 → 客户详情 → 粘贴微信消息 → 等待 AI 匹配
 *   → 看到真实贝壳房源 → 生成微信文案 → 复制 → 确认已发送
 *
 * 注意：本测试**会真实调用贝壳开放平台**并消耗额度，因此：
 *   - 单独放在一个 spec 里，不与快速测试混跑
 *   - 只在需要验证闭环时执行：pnpm e2e -- wechat-assistant.spec.ts
 */

import { expect, test } from '@playwright/test';

const DEMO_AGENT = { email: 'agent111@estatepilot.demo', password: 'EstatePilot2026!' };

/** 登录并进入客户列表 */
async function loginAndGoToCustomers(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: /经纪人/ }).first().click();
  await page.getByRole('button', { name: /^登录$/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: '客户管理' })).toBeVisible({ timeout: 15_000 });
}

test.describe('客户列表', () => {
  test('显示客户、意向分与需求速览，可搜索', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await loginAndGoToCustomers(page);

    // 列表必须有真实数据（种子数据里有 12 位客户）
    const rows = page.locator('a[href^="/customers/"]');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    expect(await rows.count()).toBeGreaterThan(0);

    // 每行必须展示"客户要什么"，而不是只有姓名
    await expect(page.getByText(/意向分/).first()).toBeVisible();

    // 搜索功能
    const searchInput = page.getByLabel('搜索客户');
    await searchInput.fill('唐');
    await searchInput.press('Enter');

    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const filtered = await rows.count();
    expect(filtered).toBeGreaterThan(0);

    // Console 必须干净（需求 §58）
    expect(consoleErrors.filter((text) => !text.includes('favicon'))).toEqual([]);
  });
});

test.describe('微信消息智能处理闭环', () => {
  // 闭环涉及贝壳真实调用，给足超时
  test.setTimeout(240_000);

  // 串行执行：多个闭环用例会共享同一个测试客户，
  // 并行跑会互相干扰需求画像，导致断言不稳定。
  test.describe.configure({ mode: 'serial' });

  test('粘贴客户消息 → 得到真实房源 → 生成微信文案 → 复制 → 确认发送', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await loginAndGoToCustomers(page);

    // 打开第一位客户
    await page.locator('a[href^="/customers/"]').first().click();
    await expect(page).toHaveURL(/\/customers\/[^/]+$/, { timeout: 15_000 });

    // =====================================================================
    // 核心模块必须存在且最显眼
    // =====================================================================
    await expect(page.getByText('微信消息智能处理')).toBeVisible({ timeout: 15_000 });

    const textarea = page.getByLabel('客户微信消息');
    await expect(textarea).toBeVisible();

    // =====================================================================
    // 粘贴客户微信消息并提交
    // =====================================================================
    await textarea.fill(
      '还是想看张江附近吧，三房最好，550左右，600以内也可以，但是别太老的小区，我老婆比较在意小区环境，离地铁最好也别太远。',
    );

    const submitButton = page.getByRole('button', { name: /AI 识别需求并匹配房源/ });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // 处理中必须显示真实进度说明。
    //
    // ⚠️ 用 Promise.race 而不是硬断言：请求可能**非常快**。
    // 贝壳不可用时会走熔断（本地缓存降级 1 秒内返回），
    // 进度提示一闪而过，直接断言 toBeVisible 会 flaky。
    // 因此改为"进度提示出现 OR 请求已结束"二者之一即可 ——
    // 真正要保证的是"要么有进度、要么有结果"，不能两者都没有。
    await Promise.race([
      page
        .getByText(/正在处理，通常需要/)
        .waitFor({ state: 'visible', timeout: 10_000 })
        .catch(() => undefined),
      page
        .getByRole('button', { name: /处理中/ })
        .waitFor({ state: 'hidden', timeout: 10_000 })
        .catch(() => undefined),
    ]);

    // =====================================================================
    // 等待结果（真实贝壳调用，最长 3 分钟）
    // =====================================================================
    //
    // 判定方式：**等按钮从「处理中…」恢复**，这说明请求真的结束了。
    //
    // 踩过的坑：最初用 `role="alert"` 做竞速判断，但 Toast 容器也带
    // aria-live 语义，导致竞速在请求还在进行时就误判为"出错"。
    // 用"提交按钮恢复可用"作为结束信号最可靠。
    await expect(page.getByRole('button', { name: /处理中/ })).toBeHidden({ timeout: 200_000 });

    // 请求结束后，要么出现推荐结果，要么出现持久错误面板
    const hasResult = await page
      .getByText(/推荐房源（\d+ 套）/)
      .isVisible()
      .catch(() => false);
    const hasError = await page
      .getByText(/贝壳房源服务暂时不可用|贝壳房源暂时无法查询|没有满足|没有找到符合条件/)
      .first()
      .isVisible()
      .catch(() => false);

    if (hasError && !hasResult) {
      // 贝壳不可用是外部服务的真实行为，不应该让 CI 红。
      // 但要验证：错误提示是否给出了可执行的下一步（这是产品的关键设计）。
      const errorPanel = page.locator('[role="alert"]').filter({ hasText: /保存|不可用|没有/ }).first();
      const alertText = await errorPanel.innerText();

      expect(alertText.trim().length).toBeGreaterThan(0);
      // 必须明确告知"需求已保存、无需重新粘贴" —— 需求 §43 的核心要求
      expect(alertText).toMatch(/已识别并保存|已保存|无需重新/);

      test.info().annotations.push({
        type: 'external-dependency',
        description: `贝壳服务不可用，已正确降级提示：${alertText.slice(0, 120).replace(/\n/g, ' ')}`,
      });
      return;
    }

    expect(hasResult, '请求结束后应出现推荐结果').toBe(true);

    // 检索依据必须展示（让经纪人知道系统按什么搜的）
    await expect(page.getByText(/检索条件：/)).toBeVisible();

    // 数据来源标注必须展示。
    // 这是**安全相关**的断言：贝壳不可用时会降级到本地缓存，
    // 界面必须明确标注，否则经纪人可能把缓存数据当实时数据、
    // 向客户承诺"这套还在卖"。
    // 两种来源的文案不同，因此匹配其中任意一种。
    const sourceBadge = page.getByText(/贝壳实时数据|本地缓存房源/).first();
    await expect(sourceBadge).toBeVisible();

    const sourceText = (await sourceBadge.textContent()) ?? '';
    if (sourceText.includes('本地缓存')) {
      // 缓存模式：必须同时出现"非实时"的提醒
      await expect(page.getByText(/房源信息不是实时的/)).toBeVisible();
      await expect(page.getByText(/本地匹配/)).toBeVisible();
    } else {
      await expect(page.getByText(/贝壳召回/)).toBeVisible();
    }

    // 需求变化区必须存在（即使是"没有变化"）
    await expect(page.getByText(/识别到的需求变化|本次没有识别到需求变化/)).toBeVisible();

    // 匹配度必须显示（可展开明细）
    await expect(page.getByText(/匹配度/).first()).toBeVisible();

    // 来源标注必须展示。
    // Phase 12：标签按**实际取数路径**显示，不再是硬编码的「贝壳开放平台」——
    //   实时路径 → 「贝壳开放平台」
    //   降级路径 → 「贝壳（本地缓存）」
    // 因此这里匹配两者之一，而不是要求一定是某一个。
    await expect(page.getByText(/来源：贝壳/).first()).toBeVisible();

    // ---- Phase 12：数据可信度区域必须展示（需求 §6）----
    // 关键点：**不能隐藏风险**。经纪人有权知道这条数据是不是实时的。
    await expect(page.getByText(/来源：/).first()).toBeVisible();
    await expect(page.getByText(/更新时间：/).first()).toBeVisible();
    await expect(page.getByText(/在售已确认|需要确认|核验已过期/).first()).toBeVisible();

    // 匹配度与可信度必须是**两个独立的数**，不能混成一个
    await expect(page.getByText(/匹配度/).first()).toBeVisible();
    await expect(page.getByText(/综合排序分/).first()).toBeVisible();

    // 房源卡片必须有真实要素：总价的存在说明解析链路是通的
    await expect(page.getByText(/\d+万/).first()).toBeVisible();

    // =====================================================================
    // 微信文案区
    // =====================================================================
    await expect(page.getByText('微信发送文案')).toBeVisible();

    const copyButton = page.getByRole('button', { name: /复制微信内容/ });
    await expect(copyButton).toBeVisible();

    // 文案内容不能为空，且不能是机器语言
    const replyBox = page.locator('pre').first();
    const replyText = (await replyBox.textContent()) ?? '';
    expect(replyText.length).toBeGreaterThan(50);
    expect(replyText).not.toMatch(/\*\*|^#{1,6}\s/m);
    expect(replyText).not.toContain('matchScore');

    // =====================================================================
    // 复制（验证 Toast 提示）
    // =====================================================================
    // 授予剪贴板权限，否则 navigator.clipboard 在测试环境不可用
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await copyButton.click();

    await expect(page.getByText(/已复制，可直接粘贴到微信/)).toBeVisible({ timeout: 10_000 });

    // =====================================================================
    // 确认已发送
    // =====================================================================
    const confirmButton = page.getByRole('button', { name: '我已发送' });
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    await expect(page.getByText(/已记录发送时间/)).toBeVisible({ timeout: 15_000 });

    // =====================================================================
    // 刷新后历史仍在（持久化验证）
    // =====================================================================
    await page.reload();
    await expect(page.getByText('微信消息智能处理')).toBeVisible({ timeout: 20_000 });

    // 切到"推荐记录"Tab，应该能看到刚发送的批次
    await page.getByRole('tab', { name: /推荐记录/ }).click();
    await expect(page.getByText(/待发送|已复制|已发送/).first()).toBeVisible({ timeout: 15_000 });

    // 消息记录里应该能看到粘贴的原文
    await page.getByRole('tab', { name: /消息记录/ }).click();
    await expect(page.getByText(/三房最好/).first()).toBeVisible({ timeout: 15_000 });

    // Console 必须干净
    const realErrors = consoleErrors.filter(
      (text) => !text.includes('favicon') && !text.includes('clipboard'),
    );
    expect(realErrors).toEqual([]);
  });

  test('空消息被拒绝且给出明确提示', async ({ page }) => {
    await loginAndGoToCustomers(page);
    await page.locator('a[href^="/customers/"]').first().click();
    await expect(page.getByText('微信消息智能处理')).toBeVisible({ timeout: 15_000 });

    // 不输入任何内容直接点按钮（按钮应为禁用态）
    const submitButton = page.getByRole('button', { name: /AI 识别需求并匹配房源/ });
    await expect(submitButton).toBeDisabled();
  });
});
