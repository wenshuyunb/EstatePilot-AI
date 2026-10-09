/**
 * 一键发送包端到端验证。
 *
 * 用真实客户数据生成发送包，检查：
 *   1. 匹配房源是否真的符合客户需求
 *   2. 微信文案排版是否可直接复制使用
 *   3. 专属链接是否正确生成
 *   4. 注意事项是否点出了关键洞察（如"行为预算高于自述预算"）
 *
 * 用法：node --experimental-strip-types scripts/verify-outreach.ts
 */

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1';
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'agent111@estatepilot.demo';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'EstatePilot2026!';

async function login(): Promise<string> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!response.ok) throw new Error(`登录失败：${await response.text()}`);
  const data = (await response.json()) as { accessToken: string };
  return data.accessToken;
}

async function main(): Promise<void> {
  console.log('一键发送包验证\n');
  const token = await login();
  console.log('登录成功');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // ---- 找一个有匹配房源的客户 ----
  const dashboardResponse = await fetch(`${API_BASE}/dashboard`, { headers });
  const dashboard = (await dashboardResponse.json()) as {
    priorityCustomers: Array<{ customerId: string; name: string; intentScore: number }>;
    followUps: Array<{ customerId: string; customerName: string }>;
  };

  const candidates = [
    ...dashboard.priorityCustomers.map((c) => ({ id: c.customerId, name: c.name })),
    ...dashboard.followUps.map((c) => ({ id: c.customerId, name: c.customerName })),
  ];

  if (candidates.length === 0) {
    console.log('没有可用客户，请先执行种子脚本');
    return;
  }

  console.log(`找到 ${candidates.length} 位候选客户\n`);

  // 对前 2 位客户生成发送包
  for (const candidate of candidates.slice(0, 2)) {
    console.log(`${'═'.repeat(78)}`);
    console.log(`客户：${candidate.name}`);
    console.log('═'.repeat(78));

    const response = await fetch(`${API_BASE}/outreach/recommend-bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ customerId: candidate.id, limit: 3, includePortalLink: true }),
    });

    if (!response.ok) {
      console.log(`❌ 生成失败 HTTP ${response.status}：${await response.text()}`);
      continue;
    }

    const bundle = (await response.json()) as Record<string, unknown>;
    const snapshot = bundle.customerSnapshot as Record<string, unknown>;
    const properties = bundle.properties as Array<Record<string, unknown>>;

    console.log(`\n场景：${bundle.scenarioLabel}`);
    console.log(
      `客户画像：${snapshot.statusLabel} ｜ ${snapshot.intentLevelLabel} ｜ ` +
        `${snapshot.daysSinceLastContact !== null ? `已 ${snapshot.daysSinceLastContact} 天未联系` : '从未联系'}`,
    );
    console.log(`显性需求：${snapshot.explicitSummary}`);
    if (snapshot.statedBudget) console.log(`自述预算：${snapshot.statedBudget}`);
    if (snapshot.inferredBudget) console.log(`AI 推断预算：${snapshot.inferredBudget}`);
    if (snapshot.driftNote) console.log(`⚠️ 需求变化：${snapshot.driftNote}`);

    console.log(`\n匹配到 ${properties.length} 套房源：`);
    properties.forEach((property, index) => {
      console.log(
        `  ${index + 1}. ${property.community} ${property.bedrooms}室${property.area}㎡ ` +
          `${Math.round(Number(property.totalPrice) / 10000)}万 ` +
          `匹配度 ${property.matchScore}%` +
          (Number(property.priceChange) < 0 ? `  📉降${Math.abs(Math.round(Number(property.priceChange) / 10000))}万` : ''),
      );
    });

    console.log(`\n${'─'.repeat(78)}`);
    console.log('【可直接复制到微信的文案】');
    console.log('─'.repeat(78));
    console.log(bundle.messageText);
    console.log('─'.repeat(78));

    console.log(`\n【发送策略】`);
    console.log(String(bundle.strategyNote));

    const cautions = bundle.cautions as string[];
    if (cautions.length > 0) {
      console.log(`\n【注意事项】`);
      cautions.forEach((caution) => console.log(`  · ${caution}`));
    }

    console.log(`\n【客户专属链接】`);
    console.log(`  ${bundle.customerPortalUrl ?? '未生成'}`);
    console.log(`  短码：${bundle.customerPortalShortCode ?? '-'}`);

    console.log(`\n【短信版】`);
    console.log(`  ${bundle.smsText}`);

    console.log(`\n【电话话术】`);
    console.log(
      String(bundle.phoneScript)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );

    console.log(`\n免责声明：${bundle.disclaimer}`);
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log('验证完成');
  console.log('═'.repeat(78));
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exit(1);
});
