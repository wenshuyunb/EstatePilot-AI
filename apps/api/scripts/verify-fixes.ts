/**
 * 针对性验证三个修复项。
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/verify-fixes.ts
 */

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1';
const CUSTOMER_ID = process.env.CUSTOMER_ID ?? '';

async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; data: T | null; errorText: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      signal: controller.signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let data: T | null = null;
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data, errorText: response.ok ? null : text };
  } catch (error) {
    return { ok: false, status: 0, data: null, errorText: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const login = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: { email: 'agent111@estatepilot.demo', password: 'EstatePilot2026!' },
  });
  if (!login.data) {
    console.error('登录失败', login.errorText);
    process.exit(1);
  }
  const token = login.data.accessToken;

  // 找一个有推荐记录的客户
  let customerId = CUSTOMER_ID;
  if (!customerId) {
    const dashboard = await api<{ priorityCustomers?: Array<{ customerId?: string; id?: string }> }>(
      '/dashboard',
      { token },
    );
    customerId = dashboard.data?.priorityCustomers?.[0]?.customerId ?? dashboard.data?.priorityCustomers?.[0]?.id ?? '';
  }
  console.log(`客户: ${customerId}\n`);

  // =========================================================================
  console.log('【修复 1】反馈分析：验证"不错，就是有点贵"能识别出价格异议');
  // =========================================================================

  const recs = await api<{
    items: Array<{ id: string; recommendedPropertyIds: string[] }>;
  }>(`/customers/${customerId}/recommendations`, { token });

  const batch = recs.data?.items[0];
  if (!batch) {
    console.log('  ⚠️ 没有推荐批次可测试，请先跑一次闭环');
  } else {
    // 关键用例：一个分句里"肯定 + 价格异议"，另一个分句里"否定 + 位置"
    const feedback = await api<{
      recorded: number;
      hasRejection: boolean;
      items: Array<{
        community: string | null;
        sentiment: string;
        interestLevel: number | null;
        reactions: Array<{ type: string; reaction: string }>;
      }>;
      preferenceUpdates: Array<{ field: string; newValue: string }>;
      summary: string;
    }>(`/recommendations/${batch.id}/feedback`, {
      method: 'POST',
      token,
      body: { message: '第一套不错，就是有点贵，第二套位置不喜欢，最好还是靠张江近点' },
    });

    if (feedback.data) {
      const d = feedback.data;
      console.log(`  摘要: ${d.summary}`);
      for (const item of d.items) {
        console.log(
          `  · ${item.community ?? '（未定位）'} → ${item.sentiment}（兴趣 ${item.interestLevel ?? '—'}）` +
            ` 反应: ${item.reactions.map((r) => `${r.type}=${r.reaction}`).join(' | ') || '无'}`,
        );
      }
      console.log(`  偏好变化: ${d.preferenceUpdates.map((u) => `${u.field}→${u.newValue}`).join('，') || '无'}`);

      const hasPriceReaction = d.items.some((item) =>
        item.reactions.some((r) => r.type === 'PRICE'),
      );
      const hasNegative = d.items.some((item) => item.sentiment === 'NEGATIVE');
      const hasTwoItems = d.items.length >= 2;

      console.log('');
      console.log(`  ${hasTwoItems ? '✓' : '✗'} 识别出 2 条独立反馈（不是混成一条）`);
      console.log(`  ${hasPriceReaction ? '✓' : '✗'} 第 1 套识别出价格异议（关键：不能只看到"不错"）`);
      console.log(`  ${hasNegative ? '✓' : '✗'} 第 2 套识别出否定反馈`);
      console.log(`  ${d.hasRejection ? '✓' : '✗'} hasRejection 标记正确`);
    } else {
      console.log(`  ✗ 反馈接口失败: HTTP ${feedback.status} ${feedback.errorText?.slice(0, 200)}`);
    }
  }

  // =========================================================================
  console.log('\n【修复 2】搜索策略回退：验证"张江"过窄时自动扩大到行政区');
  // =========================================================================

  // 客户画像里已有张江偏好，直接再跑一次闭环
  const assistant = await api<{
    searchQuery: { naturalQuery: string };
    beikeStats: { totalRecalled: number | null; returned: number; passedHardFilter: number };
    recommendations: Array<{ community: string; totalPrice: number; district: string }>;
    warnings: string[];
  }>(`/customers/${customerId}/wechat-assistant`, {
    method: 'POST',
    token,
    body: { message: '特别好的600也能考虑，不过不要老小区', recommendationCount: 5 },
    timeoutMs: 300_000,
  });

  if (assistant.data?.searchQuery) {
    const d = assistant.data;
    console.log(`  实际检索: ${d.searchQuery.naturalQuery}`);
    console.log(`  召回 ${d.beikeStats.totalRecalled} 套，返回 ${d.beikeStats.returned} 套，通过 ${d.beikeStats.passedHardFilter} 套`);
    console.log(`  推荐 ${d.recommendations.length} 套`);
    for (const item of d.recommendations) {
      console.log(`    · ${item.community}（${item.district || '区域待确认'}）${Math.round(item.totalPrice / 10000)}万`);
    }
    if (d.warnings.length > 0) {
      console.log('  警告:');
      for (const warning of d.warnings) console.log(`    · ${warning}`);
    }
    console.log('');
    console.log(`  ${d.recommendations.length > 0 ? '✓' : '✗'} 位置过窄时仍能给出推荐（自动回退生效）`);
  } else {
    console.log(`  ✗ 闭环失败: HTTP ${assistant.status}`);
    // 打印完整错误体：NO_PROPERTIES_FOUND 会带放宽建议，需要看到
    console.log(`  ${assistant.errorText?.slice(0, 900)}`);
  }

  // =========================================================================
  console.log('\n【修复 3】消息历史：验证原文全部保存');
  // =========================================================================

  const messages = await api<{
    items: Array<{ id: string; rawText: string; parseStatus: string; createdAt: string }>;
    total: number;
    page: number;
  }>(`/customers/${customerId}/messages?page=1&pageSize=20`, { token });

  if (messages.data) {
    const d = messages.data;
    console.log(`  total=${d.total}, 返回 ${d.items.length} 条`);
    for (const item of d.items.slice(0, 5)) {
      console.log(`    · [${item.parseStatus}] ${item.rawText.slice(0, 40)}`);
    }
    console.log('');
    console.log(`  ${d.total > 0 && d.items.length > 0 ? '✓' : '✗'} 消息历史可读取（原文已保存）`);
  } else {
    console.log(`  ✗ 消息接口失败: HTTP ${messages.status} ${messages.errorText?.slice(0, 300)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
