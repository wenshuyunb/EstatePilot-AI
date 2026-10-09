/**
 * 多源聚合器验证。
 *
 * 直接覆盖需求 §20 的测试要求：
 *   2. 贝壳关闭 → 系统仍返回其它来源的结果（用户不能感知单一供应商失败）
 *   4. 多个来源同一房源 → 正确合并为一条
 *   5. 同一客户重复搜索 → 不产生重复房源
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/verify-aggregator.ts
 */

import {
  ListingStatus,
  PropertyProviderKind,
  PropertySourceType,
  PropertyType,
  ProviderCredentialType,
  ProviderError,
  ProviderErrorCode,
  ProviderHealthStatus,
  ProviderTier,
  CONSERVATIVE_CAPABILITY,
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
import { ProviderRegistryV2, ProviderRegistrationError } from '../dist/modules/property/providers/provider-registry-v2.js';
import { MultiSourceAggregator, AllProvidersFailedError } from '../dist/modules/property/providers/multi-source-aggregator.service.js';
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
// 测试用的假 Provider
// ============================================================================

interface FakeProviderOptions {
  kind: PropertyProviderKind;
  displayName: string;
  sourceType: PropertySourceType;
  tier: ProviderTier;
  properties: Array<Partial<NormalizedProperty> & { community: string; area: number; totalPrice: number }>;
  /** 设为 true 则每次搜索都抛"服务不可用"（模拟贝壳当前状态） */
  failWith?: ProviderErrorCode;
  failMessage?: string;
}

class FakeProvider implements PropertyProviderV2 {
  readonly credentialType = ProviderCredentialType.OFFICIAL_API;
  readonly capability: ProviderCapability = { ...CONSERVATIVE_CAPABILITY };
  readonly kind: PropertyProviderKind;
  readonly sourceType: PropertySourceType;
  readonly tier: ProviderTier;
  /** 记录被调用次数，用于验证"是否真的调用了这个源" */
  callCount = 0;

  private readonly name: string;
  private readonly properties: NormalizedProperty[];
  private readonly failWith?: ProviderErrorCode;
  private readonly failMessage: string;

  constructor(options: FakeProviderOptions) {
    this.kind = options.kind;
    this.sourceType = options.sourceType;
    this.tier = options.tier;
    this.name = options.displayName;
    this.failWith = options.failWith;
    this.failMessage = options.failMessage ?? '服务暂时不可用';
    this.properties = options.properties.map((item, index) =>
      makeProperty({
        externalProvider: options.kind,
        externalId: `${options.kind}-${index + 1}`,
        ...item,
      } as Parameters<typeof makeProperty>[0]),
    );
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
      status: this.failWith ? ProviderHealthStatus.OFFLINE : ProviderHealthStatus.ONLINE,
      responseTimeMs: 1,
      lastErrorMessage: this.failWith ? this.failMessage : null,
      checkedAt: new Date(),
    };
  }

  async search(query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    this.callCount += 1;

    if (this.failWith) {
      throw new ProviderError(this.kind, this.failWith, this.failMessage, {
        retryable: true,
        retryAfterMs: 1_000,
      });
    }

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

  async checkAvailability(): Promise<{ externalId: string; status: ListingStatus; currentTotalPrice: number | null; checkedAt: Date; method: 'UNAVAILABLE' }> {
    return {
      externalId: '',
      status: ListingStatus.ACTIVE,
      currentTotalPrice: null,
      checkedAt: new Date(),
      method: 'UNAVAILABLE',
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

/** 构造一套聚合器 */
function buildAggregator(): {
  registry: ProviderRegistryV2;
  health: ProviderHealthMonitor;
  aggregator: MultiSourceAggregator;
} {
  const normalizer = new CommunityNormalizerService();
  const dedup = new PropertyDeduplicationService(normalizer);
  const health = new ProviderHealthMonitor();
  // Phase 12：注册表与聚合器都需要可信度策略（Demo 隔离 + 可信度评分）
  const reliability = new PropertyReliabilityService();
  const registry = new ProviderRegistryV2(health, reliability);
  const aggregator = new MultiSourceAggregator(registry, health, dedup, reliability);
  return { registry, health, aggregator };
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

console.log('多源聚合器验证\n');

// ============================================================================
// 1. 贝壳失败 → 其它来源仍然返回（需求 §20.2、§15）
// ============================================================================
console.log('【1】贝壳失败，系统仍返回其它来源（需求 §20.2 / §15）');

{
  const { registry, aggregator } = buildAggregator();

  const beike = new FakeProvider({
    kind: PropertyProviderKind.BEIKE,
    displayName: '贝壳',
    sourceType: PropertySourceType.OFFICIAL_API,
    tier: ProviderTier.OFFICIAL,
    properties: [],
    failWith: ProviderErrorCode.UNAVAILABLE,
    failMessage: '贝壳房源服务暂时不可用（凭证与连接正常，属于对方服务端问题）',
  });

  const anjuke = new FakeProvider({
    kind: PropertyProviderKind.ANJUKE,
    displayName: '安居客',
    sourceType: PropertySourceType.USER_PROVIDED,
    tier: ProviderTier.SUPPLEMENTARY,
    properties: [
      { community: '玉兰香苑', area: 105, totalPrice: 5_680_000 },
      { community: '川杨新苑', area: 115, totalPrice: 5_480_000 },
    ],
  });

  const internal = new FakeProvider({
    kind: PropertyProviderKind.INTERNAL,
    displayName: '本公司',
    sourceType: PropertySourceType.PRIVATE,
    tier: ProviderTier.SUPPLEMENTARY,
    properties: [{ community: '申城佳苑', area: 110, totalPrice: 4_950_000 }],
  });

  registry.registerAll([beike, anjuke, internal]);

  const result = await aggregator.search(query);

  check(`贝壳失败但仍有结果（${result.properties.length} 条）`, result.properties.length === 3, `实际 ${result.properties.length} 条`);
  check('贝壳确实被调用了（不是被跳过）', beike.callCount === 1, `调用 ${beike.callCount} 次`);
  check('安居客被调用', anjuke.callCount === 1, `调用 ${anjuke.callCount} 次`);
  check('本公司房源被调用', internal.callCount === 1, `调用 ${internal.callCount} 次`);

  const beikeExecution = result.executions.find((item) => item.provider === PropertyProviderKind.BEIKE);
  check('执行明细如实记录贝壳失败', beikeExecution?.success === false);
  check(
    '失败原因可读',
    beikeExecution?.error?.message.includes('贝壳') ?? false,
    beikeExecution?.error?.message,
  );

  const failedCount = result.executions.filter((item) => !item.success).length;
  check(`executions 中有 ${failedCount} 个失败源（供界面说明）`, failedCount === 1);
}

// ============================================================================
// 2. 多源同一房源 → 合并为一条（需求 §20.4）
// ============================================================================
console.log('\n【2】多源同一房源正确合并（需求 §20.4）');

{
  const { registry, aggregator } = buildAggregator();

  // 同一套房在三个源里，价格有细微差异
  registry.registerAll([
    new FakeProvider({
      kind: PropertyProviderKind.BEIKE,
      displayName: '贝壳',
      sourceType: PropertySourceType.OFFICIAL_API,
      tier: ProviderTier.OFFICIAL,
      properties: [{ community: '玉兰香苑(四期)', area: 105, totalPrice: 5_680_000 }],
    }),
    new FakeProvider({
      kind: PropertyProviderKind.ANJUKE,
      displayName: '安居客',
      sourceType: PropertySourceType.USER_PROVIDED,
      tier: ProviderTier.SUPPLEMENTARY,
      properties: [{ community: '玉兰香苑', area: 105, totalPrice: 5_650_000 }],
    }),
    new FakeProvider({
      kind: PropertyProviderKind.INTERNAL,
      displayName: '本公司',
      sourceType: PropertySourceType.PRIVATE,
      tier: ProviderTier.SUPPLEMENTARY,
      properties: [{ community: '玉兰香苑', area: 105, totalPrice: 5_600_000 }],
    }),
  ]);

  const result = await aggregator.search(query);

  check(`3 个源各 1 条（同一套房）→ 归并为 1 条`, result.properties.length === 1, `实际 ${result.properties.length} 条`);

  const merged = result.properties[0];
  check(`该房源记录 3 个来源`, merged?.sources.length === 3, `实际 ${merged?.sources.length} 个`);
  check(
    `来源含贝壳/安居客/本公司`,
    merged?.sources.some((source) => source.provider === PropertyProviderKind.BEIKE) === true &&
      merged?.sources.some((source) => source.provider === PropertyProviderKind.ANJUKE) === true &&
      merged?.sources.some((source) => source.provider === PropertyProviderKind.INTERNAL) === true,
  );
  check('主来源为贝壳（tier 最高）', merged?.primarySource.provider === PropertyProviderKind.BEIKE);
  check(
    `统计：原始 3 条 → 归并 1 条，合并掉 2 条`,
    result.stats.rawCount === 3 && result.stats.mergedCount === 1 && result.stats.mergedAway === 2,
    JSON.stringify(result.stats),
  );
  check('多源计数为 1', result.stats.multiSourceCount === 1, `实际 ${result.stats.multiSourceCount}`);

  // 数据可信度应因多源交叉验证而提升
  check(
    `多源交叉验证提升可信度（${merged?.dataConfidence}）`,
    (merged?.dataConfidence ?? 0) > 0.7,
    `实际 ${merged?.dataConfidence}`,
  );
}

// ============================================================================
// 3. 重复搜索不产生重复房源（需求 §20.5）
// ============================================================================
console.log('\n【3】重复搜索不产生重复房源（需求 §20.5）');

{
  const { registry, aggregator } = buildAggregator();

  registry.registerAll([
    new FakeProvider({
      kind: PropertyProviderKind.BEIKE,
      displayName: '贝壳',
      sourceType: PropertySourceType.OFFICIAL_API,
      tier: ProviderTier.OFFICIAL,
      properties: [
        { community: '玉兰香苑', area: 105, totalPrice: 5_680_000 },
        { community: '川杨新苑', area: 115, totalPrice: 5_480_000 },
      ],
    }),
    new FakeProvider({
      kind: PropertyProviderKind.ANJUKE,
      displayName: '安居客',
      sourceType: PropertySourceType.USER_PROVIDED,
      tier: ProviderTier.SUPPLEMENTARY,
      // 与贝壳的第一条是同一套房
      properties: [
        { community: '玉兰香苑', area: 105, totalPrice: 5_650_000 },
        { community: '城市经典', area: 95, totalPrice: 4_580_000 },
      ],
    }),
  ]);

  const first = await aggregator.search(query);
  const second = await aggregator.search(query);

  check(
    `首次搜索 ${first.properties.length} 条，二次搜索 ${second.properties.length} 条（一致）`,
    first.properties.length === second.properties.length,
  );
  check(
    `两次搜索都归并为 3 条（2 源共 4 条原始数据，其中 1 条重复）`,
    first.properties.length === 3,
    `实际 ${first.properties.length}`,
  );

  // 检查结果内部没有重复（用指纹判重）
  const fingerprints = first.properties.map((item) => item.fingerprint);
  check(
    `结果内 ${new Set(fingerprints).size} 个不同指纹 = ${fingerprints.length} 条房源（无重复）`,
    new Set(fingerprints).size === fingerprints.length,
  );
}

// ============================================================================
// 4. 全部源失败 → 明确报错（不是"零结果"）
// ============================================================================
console.log('\n【4】全部源失败 → 明确报错而非"零结果"');

{
  const { registry, aggregator } = buildAggregator();

  registry.registerAll([
    new FakeProvider({
      kind: PropertyProviderKind.BEIKE,
      displayName: '贝壳',
      sourceType: PropertySourceType.OFFICIAL_API,
      tier: ProviderTier.OFFICIAL,
      properties: [],
      failWith: ProviderErrorCode.UNAVAILABLE,
    }),
    new FakeProvider({
      kind: PropertyProviderKind.ANJUKE,
      displayName: '安居客',
      sourceType: PropertySourceType.USER_PROVIDED,
      tier: ProviderTier.SUPPLEMENTARY,
      properties: [],
      failWith: ProviderErrorCode.UNAVAILABLE,
    }),
  ]);

  let caught: unknown = null;
  try {
    await aggregator.search(query);
  } catch (error) {
    caught = error;
  }

  check('抛出 AllProvidersFailedError', caught instanceof AllProvidersFailedError);
  check(
    '错误信息含每个源的失败原因',
    caught instanceof AllProvidersFailedError &&
      caught.message.includes('贝壳') &&
      caught.message.includes('安居客'),
    caught instanceof Error ? caught.message : undefined,
  );
  check(
    '错误标记为可重试',
    caught instanceof AllProvidersFailedError && caught.retryable === true,
  );
}

// ============================================================================
// 5. 合规强约束：DEMO 源不能进入真实推荐
// ============================================================================
console.log('\n【5】合规约束：DEMO 源默认排除');

{
  const { registry, aggregator } = buildAggregator();

  registry.registerAll([
    new FakeProvider({
      kind: PropertyProviderKind.BEIKE,
      displayName: '贝壳',
      sourceType: PropertySourceType.OFFICIAL_API,
      tier: ProviderTier.OFFICIAL,
      properties: [{ community: '真实小区', area: 105, totalPrice: 5_680_000 }],
    }),
    new FakeProvider({
      kind: PropertyProviderKind.MOCK,
      displayName: '演示数据',
      sourceType: PropertySourceType.DEMO,
      tier: ProviderTier.DEMO,
      properties: [{ community: '演示小区', area: 100, totalPrice: 5_000_000 }],
    }),
  ]);

  const result = await aggregator.search(query);

  check(
    `只返回 1 条（DEMO 源被排除）`,
    result.properties.length === 1,
    `实际 ${result.properties.length} 条`,
  );
  check(
    '结果中不含演示小区',
    !result.properties.some((item) => item.community === '演示小区'),
  );
  check(
    'executions 中也不含 DEMO 源（根本没被调用）',
    !result.executions.some((item) => item.provider === PropertyProviderKind.MOCK),
  );
}

// ============================================================================
// 6. 健康监控与熔断
// ============================================================================
console.log('\n【6】健康监控');

{
  const { registry, health, aggregator } = buildAggregator();

  const flaky = new FakeProvider({
    kind: PropertyProviderKind.ANJUKE,
    displayName: '安居客',
    sourceType: PropertySourceType.USER_PROVIDED,
    tier: ProviderTier.SUPPLEMENTARY,
    properties: [{ community: 'X小区', area: 100, totalPrice: 5_000_000 }],
  });

  registry.register(flaky);
  await aggregator.search(query);

  const stats = health.getStats(PropertyProviderKind.ANJUKE);
  check(`成功调用被记录（共 ${stats.totalCalls} 次）`, stats.totalCalls === 1);
  check(`成功率 ${(stats.successRate * 100).toFixed(0)}%`, stats.successRate === 1);
  check(`平均响应 ${stats.avgResponseTimeMs}ms 已记录`, stats.avgResponseTimeMs !== null);

  // 管理员禁用后不应再被调用
  health.setEnabled(PropertyProviderKind.ANJUKE, false);
  const searchable = registry.getSearchableProviders();
  check('禁用后不再出现在可搜索列表', !searchable.some((item) => item.kind === PropertyProviderKind.ANJUKE));

  // 注意：这里是唯一的源，禁用后再搜索会因为"没有可用数据源"而报错 ——
  // 这本身就是正确行为（明确报错而非静默返回空结果）。
  const callsBefore = flaky.callCount;
  let disabledError: unknown = null;
  try {
    await aggregator.search(query);
  } catch (error) {
    disabledError = error;
  }

  check('禁用唯一的源后搜索明确报错（不是静默返回空）', disabledError instanceof AllProvidersFailedError);
  check(
    '报错说明是"没有可用数据源"',
    disabledError instanceof Error && disabledError.message.includes('没有可用的房源数据源'),
    disabledError instanceof Error ? disabledError.message : undefined,
  );
  check('禁用后确实不再被调用', flaky.callCount === callsBefore, `调用数从 ${callsBefore} 变为 ${flaky.callCount}`);

  // 重新启用 + 加一个备份源，验证多源时禁用单源不影响整体
  const backup = new FakeProvider({
    kind: PropertyProviderKind.BEIKE,
    displayName: '贝壳',
    sourceType: PropertySourceType.OFFICIAL_API,
    tier: ProviderTier.OFFICIAL,
    properties: [{ community: '备份小区', area: 100, totalPrice: 5_000_000 }],
  });
  registry.register(backup);

  const afterBackup = await aggregator.search(query);
  check(
    '启用备份源后，被禁用的源仍不参与（只返回备份源结果）',
    afterBackup.properties.length === 1 && afterBackup.properties[0]?.community === '备份小区',
    `实际 ${afterBackup.properties.length} 条`,
  );

  health.setEnabled(PropertyProviderKind.ANJUKE, true);
  check(
    '重新启用后恢复',
    registry.getSearchableProviders().some((item) => item.kind === PropertyProviderKind.ANJUKE),
  );
}

// ============================================================================
// 7. 注册表拒绝非法凭证类型（架构层合规拦截）
// ============================================================================
console.log('\n【7】注册表合规拦截');

{
  const { registry } = buildAggregator();

  const illegal = {
    kind: PropertyProviderKind.ANJUKE,
    sourceType: PropertySourceType.OFFICIAL_API,
    credentialType: 'SCRAPING' as unknown as ProviderCredentialType,
    tier: ProviderTier.SUPPLEMENTARY,
    capability: CONSERVATIVE_CAPABILITY,
    displayName: () => '非法爬虫源',
    isConfigured: () => true,
    healthCheck: async () => ({}) as ProviderHealth,
    search: async () => ({}) as ProviderSearchResult,
    getDetail: async () => null,
    getImages: async () => [],
    getCommunity: async () => null,
    checkAvailability: async () => ({}) as never,
  } as unknown as PropertyProviderV2;

  let caught: unknown = null;
  try {
    registry.register(illegal);
  } catch (error) {
    caught = error;
  }

  check('凭证类型为 SCRAPING 时注册被拒绝', caught instanceof ProviderRegistrationError);
  check(
    '拒绝原因明确',
    caught instanceof Error && caught.message.includes('不在合法白名单内'),
    caught instanceof Error ? caught.message : undefined,
  );
}

console.log('\n' + '─'.repeat(70));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

process.exit(failed > 0 ? 1 : 0);
