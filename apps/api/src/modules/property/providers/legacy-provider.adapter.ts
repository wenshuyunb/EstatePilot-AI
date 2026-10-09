/**
 * 演示数据 Provider 的 V2 适配器（Phase 12）。
 *
 * ============================================================================
 * 这个适配器的唯一目的：**让演示数据无法伪装成真实数据**
 * ============================================================================
 * `MockPropertyProvider` 实现的是旧接口（没有能力声明），
 * 因此它没有地方声明"我是演示数据、可信度为 0"。
 *
 * 在 Phase 12 之前，这不成问题 —— 因为演示数据从未接过推荐链路。
 * 但"没有防线"和"有防线"是两件事：一旦将来有人把 Mock 注册进多源聚合器，
 * 演示房源就会以"可信度 50"的默认值混进真实推荐。
 *
 * 本适配器把演示数据的身份**显式声明出来**：
 *   sourceType = DEMO
 *   tier = DEMO
 *   baseReliabilityScore = 0
 *
 * 于是 `ProviderReliabilityService.isDemoAllowed()` 与
 * `ProviderRegistryV2.getSearchableProviders()` 都会拦掉它。
 *
 * ⚠️ 它**不应该被注册到生产链路**。保留它是因为：
 *   1. 开发环境需要它跑通链路
 *   2. 测试需要验证"Demo 被正确拦截"
 */

import { Logger } from '@nestjs/common';
import {
  CONSERVATIVE_CAPABILITY,
  ListingStatus,
  PropertyProviderKind,
  PropertySourceType,
  ProviderCredentialType,
  ProviderError,
  ProviderErrorCode,
  ProviderHealthStatus,
  ProviderTier,
  RELIABILITY_TIERS,
  type AvailabilityResult,
  type CommunityProfile,
  type NormalizedProperty,
  type PropertyImage,
  type PropertyProviderV2,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderSearchQuery,
  type ProviderSearchResult,
} from '@estatepilot/types';
import type { MockPropertyProvider } from './mock-property.provider.js';
import type { PropertyProvider } from '@estatepilot/types';

/**
 * 把旧的 `PropertyProvider` 适配成 V2 形态。
 *
 * 通用适配器 —— 不只是给 Mock 用。任何还没迁移到 V2 的 Provider
 * 都可以用它包一层，附带可信度声明。
 */
export class LegacyProviderAdapter implements PropertyProviderV2 {
  readonly kind: PropertyProviderKind;
  readonly sourceType: PropertySourceType;
  readonly credentialType: ProviderCredentialType;
  readonly tier: ProviderTier;
  readonly capability: ProviderCapability;

  private readonly logger = new Logger(LegacyProviderAdapter.name);
  private readonly name: string;

  constructor(
    private readonly legacy: PropertyProvider,
    options: {
      displayName: string;
      sourceType: PropertySourceType;
      credentialType: ProviderCredentialType;
      tier: ProviderTier;
      capability: Partial<ProviderCapability>;
    },
  ) {
    this.kind = legacy.kind;
    this.name = options.displayName;
    this.sourceType = options.sourceType;
    this.credentialType = options.credentialType;
    this.tier = options.tier;
    this.capability = { ...CONSERVATIVE_CAPABILITY, ...options.capability };
  }

  displayName(): string {
    return this.name;
  }

  isConfigured(): boolean {
    return this.legacy.isConfigured();
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.kind,
      sourceType: this.sourceType,
      status: this.legacy.isConfigured()
        ? ProviderHealthStatus.ONLINE
        : ProviderHealthStatus.NOT_CONFIGURED,
      responseTimeMs: null,
      lastErrorMessage: null,
      checkedAt: new Date(),
    };
  }

  async search(query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    const startedAt = Date.now();

    // 旧接口是分页语义，这里做一次尽量贴近的映射
    const result = await this.legacy.fetchProperties({
      city: query.city,
      district: query.districts[0],
      page: 1,
      pageSize: query.limit,
    });

    // 在内存里做与其它 Provider 一致的基础过滤，
    // 避免"演示数据源返回全量、真实源返回过滤后结果"造成的不一致
    const filtered = result.items.filter((property) => this.matches(property, query));

    return {
      provider: this.kind,
      items: filtered.slice(0, query.limit),
      totalRecalled: result.total,
      exactMatch: true,
      effectiveQuery: { city: query.city },
      durationMs: Date.now() - startedAt,
    };
  }

  async getDetail(externalId: string): Promise<NormalizedProperty | null> {
    try {
      return await this.legacy.fetchPropertyDetail(externalId);
    } catch {
      return null;
    }
  }

  async getImages(): Promise<PropertyImage[]> {
    return [];
  }

  async getCommunity(): Promise<CommunityProfile | null> {
    return null;
  }

  async checkAvailability(externalId: string): Promise<AvailabilityResult> {
    const detail = await this.getDetail(externalId);

    return {
      externalId,
      status: detail?.listingStatus ?? ListingStatus.ACTIVE,
      currentTotalPrice: detail?.totalPrice ?? null,
      checkedAt: new Date(),
      method: 'CACHED',
    };
  }

  private matches(property: NormalizedProperty, query: ProviderSearchQuery): boolean {
    if (query.onlyActive && property.listingStatus !== ListingStatus.ACTIVE) return false;
    if (query.bedrooms.length > 0 && !query.bedrooms.includes(property.bedrooms)) return false;
    if (query.budgetMax !== null && property.totalPrice > query.budgetMax * 1.05) return false;
    if (query.areaMin !== null && property.area < query.areaMin * 0.92) return false;
    if (query.areaMax !== null && property.area > query.areaMax * 1.08) return false;
    return true;
  }
}

/**
 * 构造演示数据 Provider 的 V2 形态。
 *
 * 可信度恒为 0，层级为 DEMO —— 这两项保证它无法进入生产推荐。
 */
export function createDemoProvider(mock: MockPropertyProvider): PropertyProviderV2 {
  return new LegacyProviderAdapter(mock, {
    displayName: '演示数据（Demo）',
    sourceType: PropertySourceType.DEMO,
    credentialType: ProviderCredentialType.SELF_OWNED,
    tier: ProviderTier.DEMO,
    capability: {
      ...CONSERVATIVE_CAPABILITY,
      // ⚠️ 关键：可信度 0 + DEMO 层级 → 生产环境永远被拦掉
      baseReliabilityScore: RELIABILITY_TIERS.DEMO,
      verificationTtlHours: null,
      canPaginate: true,
      maxResultsPerQuery: 200,
      supportsImages: false,
      supportsRealtimeStatus: false,
    },
  });
}
