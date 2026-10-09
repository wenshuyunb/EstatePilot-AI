/**
 * Provider 层验证 —— 不依赖任何外部服务。
 *
 * 覆盖：
 *   1. 价格单位推断（"568万" 不能被解析成 568 元 —— 这是灾难性错误）
 *   2. 关键字段缺失时拒绝入库（避免脏数据进入匹配）
 *   3. externalId 稳定性（同一房源重复录入必须得到同一 ID，否则会重复入库）
 *   4. 按客户需求过滤
 *   5. 合规约束（凭证类型里不允许出现爬虫）
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/verify-provider-layer.ts
 */

import {
  PROVIDER_CREDENTIAL_TYPE_LABELS,
  PropertyProviderKind,
  PropertySourceType,
  ProviderCredentialType,
  ProviderTier,
  type ProviderSearchQuery,
} from '@estatepilot/types';
import { UserProvidedPropertyProvider } from '../dist/modules/property/providers/user-provided/user-provided-property.provider.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('Provider 层验证\n');

// ============================================================================
// 1. 价格解析（最容易出错的地方）
// ============================================================================
console.log('【1】价格单位推断');

const priceCases: Array<{ input: unknown; expected: number; why: string }> = [
  { input: '568万', expected: 5_680_000, why: '中文"万"单位' },
  { input: 5_680_000, expected: 5_680_000, why: '数字且大于 10 万，视为元' },
  { input: 568, expected: 5_680_000, why: '数字且小于 10 万，视为万元' },
  { input: '5,680,000元', expected: 5_680_000, why: '带千分位与"元"' },
  { input: '5680000', expected: 5_680_000, why: '纯数字字符串' },
  { input: '0.0568亿', expected: 5_680_000, why: '"亿"单位' },
  { input: '450万', expected: 4_500_000, why: '另一个万元值' },
];

for (const testCase of priceCases) {
  const provider = new UserProvidedPropertyProvider(PropertyProviderKind.ANJUKE);
  const outcome = provider.normalize({
    fields: {
      city: '上海',
      community: '测试小区',
      area: 100,
      totalPrice: testCase.input,
    },
  });

  const actual = outcome.property?.totalPrice ?? null;
  check(
    `${JSON.stringify(testCase.input)} → ${testCase.expected}（${testCase.why}）`,
    actual === testCase.expected,
    `实际得到 ${actual}`,
  );
}

// ============================================================================
// 2. 关键字段缺失时拒绝
// ============================================================================
console.log('\n【2】关键字段缺失应拒绝入库（避免脏数据污染匹配）');

const missingCases: Array<{ name: string; fields: Record<string, unknown>; expectMissing: string }> = [
  { name: '缺城市', fields: { community: 'X小区', area: 100, totalPrice: '500万' }, expectMissing: 'city' },
  { name: '缺小区', fields: { city: '上海', area: 100, totalPrice: '500万' }, expectMissing: 'community' },
  { name: '缺价格', fields: { city: '上海', community: 'X小区', area: 100 }, expectMissing: 'totalPrice' },
  { name: '缺面积', fields: { city: '上海', community: 'X小区', totalPrice: '500万' }, expectMissing: 'area' },
];

for (const testCase of missingCases) {
  const provider = new UserProvidedPropertyProvider(PropertyProviderKind.ANJUKE);
  const outcome = provider.normalize({ fields: testCase.fields });

  check(
    `${testCase.name} → 不生成房源`,
    outcome.property === null,
    outcome.property ? '却生成了房源' : undefined,
  );
  check(
    `${testCase.name} → 报告缺失字段 ${testCase.expectMissing}`,
    outcome.missingFields.includes(testCase.expectMissing),
    `实际报告：${outcome.missingFields.join('、')}`,
  );
}

// ============================================================================
// 3. externalId 稳定性（幂等入库的前提）
// ============================================================================
console.log('\n【3】externalId 稳定性（重复录入同一房源必须得到同一 ID）');

const provider3 = new UserProvidedPropertyProvider(PropertyProviderKind.ANJUKE);
const sameHouse = {
  fields: { city: '上海', community: '玉兰香苑', area: 105, totalPrice: '568万' },
};

const first = provider3.normalize(sameHouse).property;
const second = provider3.normalize(sameHouse).property;

check(
  '同一房源两次归一化得到相同 externalId',
  first !== null && second !== null && first.externalId === second.externalId,
  `${first?.externalId} vs ${second?.externalId}`,
);

// 带 URL 时应从 URL 提取平台 ID
const withUrl = provider3.normalize({
  sourceUrl: 'https://sh.anjuke.com/prop/view/A12345678',
  fields: { city: '上海', community: '某小区', area: 100, totalPrice: '500万' },
}).property;

check(
  '带 URL 时从 URL 提取平台 ID',
  withUrl?.externalId === 'URL_12345678',
  `实际：${withUrl?.externalId}`,
);

// 不同房源必须得到不同 ID
const otherHouse = provider3.normalize({
  fields: { city: '上海', community: '玉兰香苑', area: 120, totalPrice: '568万' },
}).property;

check(
  '不同面积视为不同房源',
  first !== null && otherHouse !== null && first.externalId !== otherHouse.externalId,
);

// ============================================================================
// 4. 按客户需求过滤
// ============================================================================
console.log('\n【4】按客户需求过滤');

const provider4 = new UserProvidedPropertyProvider(PropertyProviderKind.ANJUKE);
provider4.acceptMany([
  { fields: { city: '上海', district: '浦东新区', subDistrict: '张江', community: 'A小区', area: 105, bedrooms: 3, totalPrice: '480万' } },
  { fields: { city: '上海', district: '浦东新区', subDistrict: '张江', community: 'B小区', area: 115, bedrooms: 3, totalPrice: '540万' } },
  { fields: { city: '上海', district: '徐汇区', community: 'C小区', area: 100, bedrooms: 2, totalPrice: '600万' } },
  { fields: { city: '上海', district: '浦东新区', subDistrict: '金桥', community: 'D小区', area: 120, bedrooms: 4, totalPrice: '700万' } },
]);

const baseQuery: ProviderSearchQuery = {
  city: '上海',
  districts: [],
  subDistricts: [],
  communities: [],
  budgetMax: null,
  budgetMin: null,
  bedrooms: [],
  livingRooms: [],
  areaMin: null,
  areaMax: null,
  builtAfterYear: null,
  limit: 50,
};

const allResult = await provider4.search(baseQuery);
check('无条件搜索返回全部 4 套', allResult.items.length === 4, `实际 ${allResult.items.length}`);

const bedroomResult = await provider4.search({ ...baseQuery, bedrooms: [3] });
check('只要 3 房 → 返回 2 套', bedroomResult.items.length === 2, `实际 ${bedroomResult.items.length}`);

const budgetResult = await provider4.search({ ...baseQuery, budgetMax: 5_000_000 });
// 480万 与 540万（5% 弹性 = 525万上限，540万超出）→ 只有 480万
check('预算 500 万（含 5% 弹性）→ 返回 1 套', budgetResult.items.length === 1, `实际 ${budgetResult.items.length}`);

const districtResult = await provider4.search({ ...baseQuery, districts: ['浦东新区'] });
check('限定浦东新区 → 返回 3 套', districtResult.items.length === 3, `实际 ${districtResult.items.length}`);

const combined = await provider4.search({
  ...baseQuery,
  districts: ['浦东新区'],
  bedrooms: [3],
  budgetMax: 5_500_000,
});
check('浦东 + 3房 + 550万 → 返回 2 套', combined.items.length === 2, `实际 ${combined.items.length}`);

// ============================================================================
// 5. 合规约束（架构层面的强制）
// ============================================================================
console.log('\n【5】合规约束');

const credentialTypes = Object.values(ProviderCredentialType);
check(
  '凭证类型只有 4 种合法来源',
  credentialTypes.length === 4,
  `实际：${credentialTypes.join(', ')}`,
);
check(
  '凭证类型中不存在 SCRAPING',
  !credentialTypes.some((type) => /SCRAP|CRAWL|BROWSER/i.test(type)),
);
check(
  '凭证类型中不存在 BROWSER_AUTOMATION',
  !credentialTypes.some((type) => type === 'BROWSER_AUTOMATION'),
);

const sourceTypes = Object.values(PropertySourceType);
check(
  '来源类型区分 DEMO 与真实来源',
  sourceTypes.includes(PropertySourceType.DEMO) &&
    sourceTypes.includes(PropertySourceType.OFFICIAL_API),
);

console.log('\n【6】Provider 元信息');

const provider6 = new UserProvidedPropertyProvider(PropertyProviderKind.ANJUKE);
check('sourceType = USER_PROVIDED', provider6.sourceType === PropertySourceType.USER_PROVIDED);
check('credentialType = USER_PROVIDED', provider6.credentialType === ProviderCredentialType.USER_PROVIDED);
check('tier = SUPPLEMENTARY（Level 3）', provider6.tier === ProviderTier.SUPPLEMENTARY);
check('无需凭证即已配置（零风险兜底）', provider6.isConfigured() === true);
check(
  'supportsRealtimeStatus = false（无法核验在售，必须诚实声明）',
  provider6.capability.supportsRealtimeStatus === false,
);

const health = await provider6.healthCheck();
check('健康检查返回 ONLINE', health.status === 'ONLINE');

console.log('\n' + '─'.repeat(70));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

if (failed === 0) {
  console.log('凭证类型白名单：');
  for (const type of credentialTypes) {
    console.log(`  · ${type} = ${PROVIDER_CREDENTIAL_TYPE_LABELS[type]}`);
  }
  console.log('\n（注意：没有 SCRAPING —— 这是编译期强约束，不是人工审查）');
}

process.exit(failed > 0 ? 1 : 0);
