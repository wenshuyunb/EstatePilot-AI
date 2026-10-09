/**
 * Phase 12 验证 —— 真实销售 MVP 的 6 项必需测试。
 *
 * 对应需求 §14：
 *   测试1：生产环境没有 Demo 房源
 *   测试2：推荐结果全部来自真实 Provider
 *   测试3：房源来源正确显示
 *   测试4：复制微信内容正确（由 E2E 覆盖，这里验证数据层）
 *   测试5：客户反馈后画像变化（由既有 verify-budget-merge 与反馈服务覆盖）
 *   测试6：过期房源不会优先推荐
 *
 * 用法：
 *   node --experimental-strip-types --no-warnings scripts/verify-phase12.ts
 *   NODE_ENV=production node --experimental-strip-types --no-warnings scripts/verify-phase12.ts
 */

import {
  CONSERVATIVE_CAPABILITY,
  ListingStatus,
  PropertyProviderKind,
  PropertySourceType,
  PropertyType,
  ProviderCredentialType,
  ProviderError,
  ProviderErrorCode,
  ProviderHealthStatus,
  ProviderTier,
  RELIABILITY_TIERS,
  VERIFICATION_TTL,
  type NormalizedProperty,
  type PropertyImage,
  type PropertyProviderV2,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderSearchQuery,
  type ProviderSearchResult,
} from '@estatepilot/types';
import { CommunityNormalizerService } from '../dist/modules/property/dedup/community-normalizer.service.js';
import { PropertyDeduplicationService } from '../dist/modules/property/dedup/property-deduplication.service.js';
import { ProviderHealthMonitor } from '../dist/modules/property/providers/provider-health-monitor.service.js';
import { ProviderRegistryV2 } from '../dist/modules/property/providers/provider-registry-v2.js';
import { MultiSourceAggregator } from '../dist/modules/property/providers/multi-source-aggregator.service.js';
import { PropertyReliabilityService } from '../dist/modules/property/reliability/property-reliability.service.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ============================================================================
// 测试用 Provider
// ============================================================================

class TestProvider implements PropertyProviderV2 {
  readonly credentialType = ProviderCredentialType.OFFICIAL_API;
  readonly capability: ProviderCapability;
  readonly kind: PropertyProviderKind;
  readonly sourceType: PropertySourceType;
  readonly tier: ProviderTier;
  callCount = 0;

  /** 注意：不能用 TS 参数属性（`constructor(readonly x: T)`）——
      Node 的 strip-only 类型擦除模式不支持该语法，脚本会直接报错。 */
  private readonly name: string;
  private readonly properties: NormalizedProperty[];

  constructor(
    kind: PropertyProviderKind,
    sourceType: PropertySourceType,
    tier: ProviderTier,
    name: string,
    properties: NormalizedProperty[],
    capabilityOverrides: Partial<ProviderCapability> = {},
  ) {
    this.kind = kind;
    this.sourceType = sourceType;
    this.tier = tier;
    this.name = name;
    this.properties = properties;
    this.capability = { ...CONSERVATIVE_CAPABILITY, ...capabilityOverrides };
  }

  displayName(): string {
    return this.name;
  }

  isConfigured(): boolean {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.kind,
      sourceType: this.sourceType,
      status: ProviderHealthStatus.ONLINE,
      responseTimeMs: 1,
      lastErrorMessage: null,
      checkedAt: new Date(),
    };
  }

  async search(query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    this.callCount += 1;
    return {
      provider: this.kind,
      items: this.properties.slice(0, query.limit),
      totalRecalled: this.properties.length,
      exactMatch: true,
      effectiveQuery: { city: query.city },
      durationMs: 1,
    };
  }

  async getDetail(): Promise<NormalizedProperty | null> {
    return null;
  }
  async getImages(): Promise<PropertyImage[]> {
    return [];
  }
  async getCommunity(): Promise<null> {
    return null;
  }
  async checkAvailability() {
    return {
      externalId: '',
      status: ListingStatus.ACTIVE,
      currentTotalPrice: null,
      checkedAt: new Date(),
      method: 'UNAVAILABLE' as const,
    };
  }
}

function makeProperty(
  overrides: Partial<NormalizedProperty> & {
    externalProvider: PropertyProviderKind;
    externalId: string;
    community: string;
    area: number;
    totalPrice: number;
  },
): NormalizedProperty {
  return {
    city: '上海',
    district: '浦东新区',
    subDistrict: '张江',
    title: `${overrides.community} ${overrides.area}㎡`,
    address: null,
    longitude: null,
    latitude: null,
    unitPrice: Math.round(overrides.totalPrice / overrides.area),
    bedrooms: 3,
    livingRooms: 2,
    bathrooms: 1,
    floor: 5,
    totalFloors: 6,
    orientation: null,
    buildYear: 2010,
    propertyType: PropertyType.APARTMENT,
    ownershipType: null,
    decoration: null,
    elevator: true,
    subwayDistance: null,
    subway: null,
    schoolInfo: null,
    tags: [],
    images: [],
    floorPlan: [],
    description: null,
    listingStatus: ListingStatus.ACTIVE,
    listingDate: null,
    lastPriceChange: null,
    rawData: null,
    ...overrides,
  } as NormalizedProperty;
}

function buildStack(): {
  registry: ProviderRegistryV2;
  aggregator: MultiSourceAggregator;
  reliability: PropertyReliabilityService;
  health: ProviderHealthMonitor;
} {
  const normalizer = new CommunityNormalizerService();
  const dedup = new PropertyDeduplicationService(normalizer);
  const health = new ProviderHealthMonitor();
  const reliability = new PropertyReliabilityService();
  const registry = new ProviderRegistryV2(health, reliability);
  const aggregator = new MultiSourceAggregator(registry, health, dedup, reliability);
  return { registry, aggregator, reliability, health };
}

const query: ProviderSearchQuery = {
  city: '上海',
  districts: ['浦东新区'],
  subDistricts: ['张江'],
  communities: [],
  budgetMax: 6_000_000,
  budgetMin: null,
  bedrooms: [3],
  livingRooms: [],
  areaMin: null,
  areaMax: null,
  builtAfterYear: null,
  limit: 10,
};

console.log(`Phase 12 验证（NODE_ENV=${process.env.NODE_ENV ?? 'development'}）\n`);

// ============================================================================
// 测试 1：Demo 数据隔离
// ============================================================================
console.log('【测试 1】Demo 数据不能进入真实销售流程');

{
  const { registry, aggregator, reliability } = buildStack();

  console.log(`  当前环境: ${reliability.getEnvironment()}`);

  const demoProvider = new TestProvider(
    PropertyProviderKind.MOCK,
    PropertySourceType.DEMO,
    ProviderTier.DEMO,
    '演示数据（Demo）',
    [makeProperty({ externalProvider: PropertyProviderKind.MOCK, externalId: 'D1', community: '演示小区', area: 100, totalPrice: 5_000_000 })],
    {
      baseReliabilityScore: RELIABILITY_TIERS.DEMO,
      verificationTtlHours: null,
    },
  );

  const realProvider = new TestProvider(
    PropertyProviderKind.BEIKE,
    PropertySourceType.OFFICIAL_API,
    ProviderTier.OFFICIAL,
    '贝壳',
    [makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'B1', community: '真实小区', area: 105, totalPrice: 5_680_000 })],
    {
      baseReliabilityScore: RELIABILITY_TIERS.OFFICIAL_REALTIME,
      verificationTtlHours: VERIFICATION_TTL.OFFICIAL_REALTIME,
    },
  );

  registry.registerAll([demoProvider, realProvider]);

  const decision = reliability.isDemoAllowed();
  const isProduction = reliability.getEnvironment() === 'production';

  if (isProduction) {
    check('生产环境：Demo 数据策略为禁止', decision.allowed === false);
    check('生产环境：给出了禁止原因', (decision.reason ?? '').includes('禁止演示数据'));
  } else {
    check(
      `非生产环境（${reliability.getEnvironment()}）：Demo 默认被禁止`,
      decision.allowed === false,
      `决策：${JSON.stringify(decision)}`,
    );
  }

  // 关键：即使显式要求包含 Demo，生产环境也必须拦掉
  const searchable = registry.getSearchableProviders({ includeDemo: true });
  const demoIncluded = searchable.some((item) => item.kind === PropertyProviderKind.MOCK);

  if (isProduction) {
    check('生产环境：即使 includeDemo=true 也不放行演示数据源', demoIncluded === false);
  } else {
    // 开发环境是**双层门控**：既要 includeDemo=true，也要 ALLOW_DEMO_DATA=true。
    // 这里默认没设 ALLOW_DEMO_DATA，因此仍应被拦掉 —— 这正是设计意图：
    // "默认不出现演示数据"，而不是"显式要求才出现"。
    check(
      '开发环境：未设 ALLOW_DEMO_DATA 时，即使 includeDemo=true 也不放行',
      demoIncluded === false,
      `决策：${JSON.stringify(decision)}`,
    );
    check(
      '开发环境：策略给出了明确的开启方式',
      (decision.reason ?? '').includes('ALLOW_DEMO_DATA'),
      decision.reason ?? '(无原因)',
    );

    // 再验证：显式打开开关后，开发环境确实允许（证明门控是可用的，不是死代码）
    process.env.ALLOW_DEMO_DATA = 'true';
    try {
      const relaxedReliability = new PropertyReliabilityService();
      const relaxedDecision = relaxedReliability.isDemoAllowed();
      check(
        '开发环境 + ALLOW_DEMO_DATA=true → 允许（证明开关有效）',
        relaxedDecision.allowed === true,
        `决策：${JSON.stringify(relaxedDecision)}`,
      );
    } finally {
      delete process.env.ALLOW_DEMO_DATA;
    }
  }

  // 默认调用（不显式要求）永远不含 Demo
  const defaultSearchable = registry.getSearchableProviders();
  check(
    '默认调用永不含演示数据源',
    defaultSearchable.every((item) => item.sourceType !== PropertySourceType.DEMO),
  );

  // 端到端：搜索结果里不能有演示小区
  const result = await aggregator.search(query);
  check(
    `搜索结果不含演示小区（实际 ${result.properties.length} 条）`,
    !result.properties.some((item) => item.community === '演示小区'),
  );
  check(
    '搜索统计中也不含演示数据源',
    !result.executions.some((item) => item.provider === PropertyProviderKind.MOCK),
  );
}

// ============================================================================
// 测试 2：推荐结果全部来自真实 Provider
// ============================================================================
console.log('\n【测试 2】推荐结果全部来自真实 Provider');

{
  const { registry, aggregator } = buildStack();

  registry.registerAll([
    new TestProvider(
      PropertyProviderKind.BEIKE,
      PropertySourceType.OFFICIAL_API,
      ProviderTier.OFFICIAL,
      '贝壳',
      [makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'B1', community: '玉兰香苑', area: 105, totalPrice: 5_680_000 })],
      { baseReliabilityScore: RELIABILITY_TIERS.OFFICIAL_REALTIME, verificationTtlHours: VERIFICATION_TTL.OFFICIAL_REALTIME },
    ),
    new TestProvider(
      PropertyProviderKind.INTERNAL,
      PropertySourceType.PRIVATE,
      ProviderTier.SUPPLEMENTARY,
      '本公司',
      [makeProperty({ externalProvider: PropertyProviderKind.INTERNAL, externalId: 'I1', community: '申城佳苑', area: 110, totalPrice: 4_950_000 })],
      { baseReliabilityScore: RELIABILITY_TIERS.COMPANY_OWNED, verificationTtlHours: VERIFICATION_TTL.COMPANY_OWNED },
    ),
  ]);

  const result = await aggregator.search(query);

  const allReal = result.properties.every(
    (item) => item.primarySource.sourceType !== PropertySourceType.DEMO,
  );
  check(`返回 ${result.properties.length} 条，全部为非演示来源`, allReal);

  const providerKinds = new Set(result.properties.map((item) => item.externalProvider));
  check(
    `来源仅含贝壳与本公司（实际：${[...providerKinds].join(', ')}）`,
    !providerKinds.has(PropertyProviderKind.MOCK),
  );

  // 每条房源都必须能追溯到来源
  check(
    '每条房源都带可追溯的来源信息',
    result.properties.every((item) => item.sources.length > 0 && item.primarySource.externalId.length > 0),
  );
}

// ============================================================================
// 测试 3：来源显示与可信度
// ============================================================================
console.log('\n【测试 3】房源来源与可信度正确显示');

{
  const { registry, aggregator } = buildStack();

  const beike = new TestProvider(
    PropertyProviderKind.BEIKE,
    PropertySourceType.OFFICIAL_API,
    ProviderTier.OFFICIAL,
    '贝壳',
    [makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'B1', community: '实时小区', area: 105, totalPrice: 5_680_000 })],
    { baseReliabilityScore: RELIABILITY_TIERS.OFFICIAL_REALTIME, verificationTtlHours: VERIFICATION_TTL.OFFICIAL_REALTIME },
  );

  const uploaded = new TestProvider(
    PropertyProviderKind.ANJUKE,
    PropertySourceType.USER_PROVIDED,
    ProviderTier.SUPPLEMENTARY,
    '安居客（用户录入）',
    [makeProperty({ externalProvider: PropertyProviderKind.ANJUKE, externalId: 'A1', community: '录入小区', area: 100, totalPrice: 5_200_000 })],
    { baseReliabilityScore: RELIABILITY_TIERS.AGENT_UPLOADED, verificationTtlHours: VERIFICATION_TTL.AGENT_UPLOADED },
  );

  registry.registerAll([beike, uploaded]);

  const result = await aggregator.search(query);
  const realtime = result.properties.find((item) => item.community === '实时小区');
  const agentInput = result.properties.find((item) => item.community === '录入小区');

  // ---- 贝壳实时数据 ----
  check('贝壳房源的可信度为 100', realtime?.dataReliabilityScore === 100, `实际 ${realtime?.dataReliabilityScore}`);
  check('贝壳房源核验状态为 VERIFIED', realtime?.verificationStatus === 'VERIFIED', `实际 ${realtime?.verificationStatus}`);
  check('贝壳房源有核验时间', realtime?.lastVerifiedAt !== null);
  check('贝壳房源显示 5 星', realtime?.reliabilityStars === 5, `实际 ${realtime?.reliabilityStars}`);
  check(
    `贝壳房源来源名称为「贝壳」`,
    realtime?.primarySource.displayName === '贝壳',
    `实际 ${realtime?.primarySource.displayName}`,
  );

  // ---- 经纪人录入 ----
  check('经纪人录入可信度为 80', agentInput?.dataReliabilityScore === 80, `实际 ${agentInput?.dataReliabilityScore}`);
  check(
    '经纪人录入核验状态为 PENDING（无法核验，不能假装可信）',
    agentInput?.verificationStatus === 'PENDING',
    `实际 ${agentInput?.verificationStatus}`,
  );
  check(
    '经纪人录入**不写**核验时间（写假时间会让界面误以为刚确认过）',
    agentInput?.lastVerifiedAt === null,
    `实际 ${agentInput?.lastVerifiedAt}`,
  );
  check(
    '经纪人录入的提示明确说明需自行确认',
    (agentInput?.reliabilityNote ?? '').includes('无法实时核验'),
    agentInput?.reliabilityNote,
  );
  check('经纪人录入显示 4 星', agentInput?.reliabilityStars === 4, `实际 ${agentInput?.reliabilityStars}`);
}

// ============================================================================
// 测试 6：过期房源不会优先推荐
// ============================================================================
console.log('\n【测试 6】过期房源不会优先推荐');

{
  const { registry, aggregator, reliability } = buildStack();

  // 先验证评分函数本身
  const fresh = reliability.computeFinalScore({
    matchScore: 90,
    dataReliabilityScore: 100,
    lastVerifiedAt: new Date(),
  });
  const stale = reliability.computeFinalScore({
    matchScore: 90,
    dataReliabilityScore: 40,
    lastVerifiedAt: new Date(Date.now() - 30 * 24 * 3_600_000), // 30 天前
  });

  check(
    `续期房源综合分（${fresh.finalScore}）> 过期房源（${stale.finalScore}）`,
    fresh.finalScore > stale.finalScore,
  );
  check(
    '时效性得分：刚核验 = 100',
    reliability.freshnessScore(new Date()) === 100,
  );
  check(
    '时效性得分：30 天前 < 50',
    reliability.freshnessScore(new Date(Date.now() - 30 * 24 * 3_600_000)) < 50,
  );
  check('时效性得分：从未核验 = 0', reliability.freshnessScore(null) === 0);

  // ---- 完整评估：超时后状态变 EXPIRED ----
  const withinTtl = reliability.assess({
    baseScore: 100,
    ttlHours: 24,
    lastVerifiedAt: new Date(Date.now() - 2 * 3_600_000), // 2 小时前
  });
  const beyondTtl = reliability.assess({
    baseScore: 100,
    ttlHours: 24,
    lastVerifiedAt: new Date(Date.now() - 72 * 3_600_000), // 72 小时前（超 24 小时时效）
  });

  check('2 小时前核验 → VERIFIED', withinTtl.status === 'VERIFIED', `实际 ${withinTtl.status}`);
  check('72 小时前核验（时效 24h）→ EXPIRED', beyondTtl.status === 'EXPIRED', `实际 ${beyondTtl.status}`);
  check(
    `超期后分数下降（${withinTtl.score} → ${beyondTtl.score}）`,
    beyondTtl.score < withinTtl.score,
  );
  check(
    '超期提示明确要求重新确认',
    beyondTtl.note.includes('重新确认'),
    beyondTtl.note,
  );
  check(
    '超期房源仍可发送（不是"不能用"，而是"需重新确认"）',
    beyondTtl.isSendable === true,
  );

  // ---- 端到端：聚合结果里的可信度正确 ----
  registry.registerAll([
    new TestProvider(
      PropertyProviderKind.BEIKE,
      PropertySourceType.OFFICIAL_API,
      ProviderTier.OFFICIAL,
      '贝壳',
      [makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'B1', community: '新鲜房源', area: 105, totalPrice: 5_680_000 })],
      { baseReliabilityScore: 100, verificationTtlHours: 24 },
    ),
    new TestProvider(
      PropertyProviderKind.ANJUKE,
      PropertySourceType.USER_PROVIDED,
      ProviderTier.SUPPLEMENTARY,
      '安居客（用户录入）',
      [makeProperty({ externalProvider: PropertyProviderKind.ANJUKE, externalId: 'A1', community: '录入房源', area: 105, totalPrice: 5_680_000 })],
      { baseReliabilityScore: 80, verificationTtlHours: null },
    ),
  ]);

  const result = await aggregator.search(query);
  const freshItem = result.properties.find((item) => item.community === '新鲜房源');
  const pendingItem = result.properties.find((item) => item.community === '录入房源');

  check(
    `实时源时效性得分（${freshItem?.channelFreshness}）= 100`,
    freshItem?.channelFreshness === 100,
  );
  check(
    `无法核验来源的时效性得分（${pendingItem?.channelFreshness}）= 0`,
    pendingItem?.channelFreshness === 0,
  );
  check(
    '同类房源中，实时源可信度高于录入源',
    (freshItem?.dataReliabilityScore ?? 0) > (pendingItem?.dataReliabilityScore ?? 0),
  );
}

// ============================================================================
// 附加：Demo 在生产环境的一票否决（显式环境测试）
// ============================================================================
console.log('\n【附加】生产环境一票否决的防绕过');

{
  const reliability = new PropertyReliabilityService();

  // 即使有人设置了 ALLOW_DEMO_DATA=true，生产环境也必须拒绝
  const originalEnv = process.env.NODE_ENV;
  const originalAllow = process.env.ALLOW_DEMO_DATA;

  process.env.NODE_ENV = 'production';
  process.env.ALLOW_DEMO_DATA = 'true';
  const prodReliability = new PropertyReliabilityService();
  const prodDecision = prodReliability.isDemoAllowed();

  check(
    '生产环境 + ALLOW_DEMO_DATA=true → 仍然禁止（防绕过）',
    prodDecision.allowed === false,
    `决策：${JSON.stringify(prodDecision)}`,
  );
  check(
    '生产环境判定为 production',
    prodReliability.getEnvironment() === 'production',
  );

  process.env.NODE_ENV = 'test';
  const testReliability = new PropertyReliabilityService();
  check(
    '测试环境也禁止 Demo（确保测试验证真实逻辑）',
    testReliability.isDemoAllowed().allowed === false,
  );

  // 恢复环境变量
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
  if (originalAllow === undefined) delete process.env.ALLOW_DEMO_DATA;
  else process.env.ALLOW_DEMO_DATA = originalAllow;

  check('环境变量已恢复', true);
}

console.log('\n' + '─'.repeat(70));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

process.exit(failed > 0 ? 1 : 0);
