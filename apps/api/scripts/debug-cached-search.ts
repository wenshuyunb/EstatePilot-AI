/**
 * 直接测试缓存检索服务 —— 定位"选上海却说没有可用房源"。
 */

import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';
import { CachedPropertySearchService } from '../dist/modules/requirement/cached-property-search.service.js';
import { TenantService } from '../dist/modules/tenant/tenant.service.js';
import { PropertySearchQueryBuilder } from '../dist/modules/requirement/property-search-query-builder.service.js';
import { createPrismaClient } from '@estatepilot/database';
import { ListingStatus } from '@estatepilot/types';

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  const prisma = createPrismaClient({ connectionString, applicationName: 'estatepilot-cache-test' });

  const config = {
    env: 'development',
    isDevelopment: true,
    log: { level: 'info' },
    database: { url: connectionString },
    ai: { provider: 'mock' },
  };
  const tenant = new TenantService(config as never);
  // TenantService 需要显式初始化才会建立 Prisma 连接
  await tenant.onModuleInit();

  const cached = new CachedPropertySearchService(tenant);

  // 找到房源所属组织
  const org = await prisma.property.findFirst({
    select: { organizationId: true, city: true, district: true, bedrooms: true, totalPrice: true },
  });

  console.log('=== 房源样本 ===');
  console.log(`  org=${org?.organizationId}`);
  console.log(`  city=${org?.city} district=${org?.district} bedrooms=${org?.bedrooms} price=${org?.totalPrice}`);

  const organizationId = org!.organizationId;

  // ---- 逐个条件测试，定位是哪个条件筛掉了全部 ----
  const builder = new PropertySearchQueryBuilder();

  const scenarios: Array<{ label: string; query: ReturnType<PropertySearchQueryBuilder['build']>['query'] }> = [];

  // 用查询构造器从画像生成，模拟真实路径
  const baseProfile = {
    city: '上海',
    districts: [] as string[],
    subDistricts: [] as string[],
    communities: [] as string[],
    budgetTarget: 5_000_000,
    budgetNormalMax: 5_500_000,
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
    subwayPriority: 'HIGH',
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

  const built = builder.build({
    ...baseProfile,
    districts: [],
  } as never);

  console.log('');
  console.log('=== 查询条件（无限区域、无预算）===');
  console.log('  ' + JSON.stringify(built.query, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 400));

  scenarios.push({ label: '画像：上海/不限区/500万/3房', query: built.query });

  // 逐步放宽
  const relaxed: Array<[string, Record<string, unknown>]> = [
    ['仅城市', {}],
    ['不限预算', { budgetMax: null, budgetNormalMax: null, budgetStretchMax: null }],
    ['不限户型', { bedrooms: [] }],
  ];

  console.log('');
  console.log('=== 逐场景测试缓存检索 ===');

  for (const scenario of scenarios) {
    const result = await cached.search(organizationId, scenario.query as never);
    console.log('');
    console.log(`  【${scenario.label}】`);
    console.log(`    候选 ${result.properties.length} 套 | matched=${result.matched} | 缓存共 ${result.totalCached} 套`);
    console.log(`    来源说明: ${result.sourceNote}`);
    if (result.properties.length > 0) {
      for (const p of result.properties.slice(0, 3)) {
        console.log(`      · ${p.community} ${p.district} ${p.bedrooms}房 ${p.totalPrice}`);
      }
    }
  }

  // ---- 关键排查：直接看数据库里的实际字段值 ----
  console.log('');
  console.log('=== 数据库实际字段分布（决定缓存检索能否命中）===');
  const byProvider = await prisma.property.groupBy({
    by: ['externalProvider'],
    _count: { id: true },
  });
  console.log('  externalProvider: ' + JSON.stringify(byProvider.map((r) => [r.externalProvider, r._count.id])));

  const byStatus = await prisma.property.groupBy({
    by: ['listingStatus'],
    _count: { id: true },
  });
  console.log('  listingStatus:    ' + JSON.stringify(byStatus.map((r) => [r.listingStatus, r._count.id])));

  const byListingStatus2 = await prisma.property.groupBy({
    by: ['status'],
    _count: { id: true },
  });
  console.log('  status:           ' + JSON.stringify(byListingStatus2.map((r) => [r.status, r._count.id])));

  const priceRange = await prisma.property.aggregate({
    _min: { totalPrice: true },
    _max: { totalPrice: true },
  });
  console.log(`  totalPrice: ${String(priceRange._min.totalPrice)} ~ ${String(priceRange._max.totalPrice)}`);

  const bedroomsDist = await prisma.property.groupBy({
    by: ['bedrooms'],
    _count: { id: true },
  });
  console.log('  bedrooms:         ' + JSON.stringify(bedroomsDist.map((r) => [r.bedrooms, r._count.id])));

  console.log('');
  console.log('=== ListingStatus 枚举期望值 ===');
  console.log('  ACTIVE = ' + ListingStatus.ACTIVE);

  // ---- 关键：看 where 条件到底怎么组装的 ----
  console.log('');
  console.log('=== 查询里的各条件 ===');
  const q = built.query as unknown as Record<string, unknown>;
  console.log(`  city         = ${String(q['city'])}`);
  console.log(`  districts    = ${JSON.stringify(q['districts'])}`);
  console.log(`  subDistricts = ${JSON.stringify(q['subDistricts'])}`);
  console.log(`  bedrooms     = ${JSON.stringify(q['bedrooms'])}`);
  console.log(`  budgetMax    = ${String(q['budgetMax'])}`);
  console.log(`  onlyActive   = ${String(q['onlyActive'])}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
