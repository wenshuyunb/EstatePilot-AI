/**
 * 端到端追踪：为什么"厦门岛外"会搜出上海房源。
 *
 * 逐步打印每一层的输入输出，定位是哪一层丢掉了城市约束：
 *   1. 规则解析：岛外 → 哪些区
 *   2. 需求合并后的画像
 *   3. 查询构造器输出
 *   4. 缓存检索的 where 与结果
 *   5. 硬筛是否按城市过滤
 */

import { parseRequirementByRules, extractLocations } from '../dist/modules/requirement/chinese-expression-parser.js';
import { PropertySearchQueryBuilder } from '../dist/modules/requirement/property-search-query-builder.service.js';
import { CachedPropertySearchService } from '../dist/modules/requirement/cached-property-search.service.js';
import { HardFilterService } from '../dist/modules/requirement/hard-filter.service.js';
import { TenantService } from '../dist/modules/tenant/tenant.service.js';
import { sanitizeRegionsForCity } from '../dist/modules/requirement/city-locations.js';

const MESSAGES = [
  '厦门岛外的房子',
  '想看厦门岛外三房，400万左右',
  '岛外两房',
];

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  // ========================================================================
  console.log('='.repeat(74));
  console.log('[1] 规则解析层');
  console.log('='.repeat(74));

  for (const text of MESSAGES) {
    const parsed = parseRequirementByRules(text, { city: null });
    console.log(`\n  「${text}」`);
    console.log(`    city       = ${parsed.city}`);
    console.log(`    citySource = ${parsed.citySource}`);
    console.log(`    districts  = ${JSON.stringify(parsed.districts)}`);
    console.log(`    subDistricts = ${JSON.stringify(parsed.subDistricts)}`);

    const loc = extractLocations(text, parsed.city);
    console.log(`    extractLocations(${parsed.city}) = ${JSON.stringify(loc)}`);
  }

  // ========================================================================
  console.log('');
  console.log('='.repeat(74));
  console.log('[2] 区域清洗（用厦门作权威城市）');
  console.log('='.repeat(74));

  for (const text of MESSAGES) {
    const parsed = parseRequirementByRules(text, { city: null });
    const sanitized = sanitizeRegionsForCity(
      { districts: parsed.districts, subDistricts: parsed.subDistricts },
      parsed.city,
    );
    console.log(`\n  「${text}」city=${parsed.city}`);
    console.log(`    清洗前: districts=${JSON.stringify(parsed.districts)} sub=${JSON.stringify(parsed.subDistricts)}`);
    console.log(`    清洗后: districts=${JSON.stringify(sanitized.districts)} sub=${JSON.stringify(sanitized.subDistricts)}`);
  }

  // ========================================================================
  console.log('');
  console.log('='.repeat(74));
  console.log('[3] 查询构造器输出（厦门 + 岛外展开的区）');
  console.log('='.repeat(74));

  const builder = new PropertySearchQueryBuilder();

  const baseProfile = {
    city: '厦门',
    districts: ['集美区', '海沧区', '同安区', '翔安区'],
    subDistricts: [] as string[],
    communities: [] as string[],
    budgetTarget: 4_000_000,
    budgetNormalMax: null,
    budgetStretchMax: null,
    budgetStrictMax: false,
    bedrooms: [3],
    bedroomsStrict: false,
    livingRooms: null,
    areaMin: null,
    areaMax: null,
    buildingAgePreference: null,
    avoidOldCommunity: false,
    avoidFirstFloor: false,
    avoidTopFloor: false,
    floorPreference: 'ANY',
    decorationPreference: null,
    schoolRequired: false,
    schoolNotNeeded: false,
    subwayPriority: 'MEDIUM',
    commuteLocations: [],
    purchasePurpose: null,
    paymentMethod: null,
    downPaymentBudget: null,
    loanStatus: null,
    purchaseTimeline: null,
    familyConcerns: [] as string[],
    decisionMakers: [] as string[],
    sourceMessageCount: 1,
    confidence: 0.6,
    updatedAt: new Date(),
  };

  const built = builder.build(baseProfile as never);
  console.log(`  city       = ${JSON.stringify(built.query.city)}`);
  console.log(`  districts  = ${JSON.stringify(built.query.districts)}`);
  console.log(`  onlyActive = ${JSON.stringify(built.query.onlyActive)}`);

  // ========================================================================
  console.log('');
  console.log('='.repeat(74));
  console.log('[4] 缓存检索（厦门）—— 关键：会不会返回上海房源？');
  console.log('='.repeat(74));

  const config = {
    env: 'development',
    isDevelopment: true,
    log: { level: 'info' },
    database: { url: connectionString },
  };
  const tenant = new TenantService(config as never);
  await tenant.onModuleInit();

  const cached = new CachedPropertySearchService(tenant);

  // 找组织
  const { createPrismaClient } = await import('@estatepilot/database');
  const prisma = createPrismaClient({ connectionString, applicationName: 'trace' });
  const org = await prisma.property.findFirst({ select: { organizationId: true } });

  const result = await cached.search(org!.organizationId, built.query as never);
  console.log(`  候选 ${result.properties.length} 套 | matched=${result.matched} | 缓存共 ${result.totalCached}`);
  for (const p of result.properties.slice(0, 5)) {
    console.log(`    · city=${p.city} district=${p.district} ${p.community}`);
  }

  // ========================================================================
  console.log('');
  console.log('='.repeat(74));
  console.log('[5] 硬筛（是否按城市过滤？）');
  console.log('='.repeat(74));

  const hardFilter = new HardFilterService();
  const filtered = hardFilter.filter(result.properties, built.query as never);
  console.log(`  输入 ${result.properties.length} 套 → 通过 ${filtered.passed.length} 套`);
  for (const p of filtered.passed.slice(0, 5)) {
    console.log(`    · city=${p.city} district=${p.district} ${p.community}`);
  }
  if (filtered.rejected.length > 0) {
    console.log(`  被拒 ${filtered.rejected.length} 套，原因样本：`);
    for (const r of filtered.rejected.slice(0, 3)) {
      console.log(`    · ${JSON.stringify(r).slice(0, 140)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
