/**
 * 多源 Provider 注册表（V2）。
 *
 * ============================================================================
 * 与旧 `PropertyProviderRegistry` 的关系
 * ============================================================================
 * 旧注册表（`providers/provider-registry.ts`）服务于旧接口 `PropertyProvider`，
 * 且只注册了 Mock 与贝壳。它仍在被 `PropertySyncService` 等使用，**保持不动**。
 *
 * 本注册表服务于新接口 `PropertyProviderV2`，是**多源聚合的入口**：
 *   - 按优先级/健康度决定调用哪些源
 *   - 提供"所有可用源"的查询能力（旧注册表只有 getDefault 单源语义）
 *   - 记录每个源的执行统计（供健康监控）
 *
 * ============================================================================
 * 合规强约束：注册时校验凭证类型
 * ============================================================================
 * `register()` 会校验 Provider 的 `credentialType` 是否在合法白名单内。
 * 这不是靠人工审查 —— `ProviderCredentialType` 枚举里根本不存在 `SCRAPING`，
 * 因此任何抓取型 Provider 都无法通过类型检查，更无法注册。
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ProviderCredentialType,
  ProviderTier,
  PropertySourceType,
  type PropertyProviderKind,
  type PropertyProviderV2,
  type ProviderHealth,
} from '@estatepilot/types';
import { ProviderHealthMonitor } from './provider-health-monitor.service.js';
import { PropertyReliabilityService } from '../reliability/property-reliability.service.js';
import { BeikePropertyProviderV2 } from './beike/beike-provider-v2.js';
import { UserProvidedPropertyProvider } from './user-provided/user-provided-property.provider.js';
import { createDemoProvider } from './legacy-provider.adapter.js';
import type { MockPropertyProvider } from './mock-property.provider.js';

/** 合法的凭证类型白名单（编译期已限制，运行时再兜一层） */
const ALLOWED_CREDENTIAL_TYPES = new Set<string>(Object.values(ProviderCredentialType));

/** 注册失败原因 */
export class ProviderRegistrationError extends Error {
  constructor(
    readonly providerKind: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRegistrationError';
  }
}

@Injectable()
export class ProviderRegistryV2 {
  private readonly logger = new Logger(ProviderRegistryV2.name);
  private readonly providers = new Map<PropertyProviderKind, PropertyProviderV2>();

  constructor(
    private readonly healthMonitor: ProviderHealthMonitor,
    private readonly reliability: PropertyReliabilityService,
    /** 贝壳官方 API 适配器（可选 —— 未配置凭证时注册表会自动跳过它） */
    @Optional() private readonly beikeProvider?: BeikePropertyProviderV2,
    /** 用户录入房源 Provider（零依赖，永远可用） */
    @Optional() private readonly userProvidedProvider?: UserProvidedPropertyProvider,
    /** 演示数据 Provider（仅开发环境，由可靠性策略门控） */
    @Optional() private readonly mockProvider?: MockPropertyProvider,
  ) {
    this.autoRegister();
  }

  /**
   * 启动时自动装配 Provider。
   *
   * 为什么在构造里做而不是模块里 `registerAll`：
   *   注册表需要在**任何业务调用之前**就绪，且装配逻辑（谁能进、谁不能进）
   *   属于注册表自身的职责。放在业务层容易漏调。
   */
  private autoRegister(): void {
    if (this.beikeProvider) {
      this.register(this.beikeProvider);
    }

    if (this.userProvidedProvider) {
      this.register(this.userProvidedProvider);
    }

    if (this.mockProvider) {
      this.register(createDemoProvider(this.mockProvider));
    }

    const searchable = this.getSearchableProviders();
    this.logger.log(
      `多源注册表就绪：已注册 ${this.providers.size} 个 Provider，` +
        `其中 ${searchable.length} 个可参与搜索（${searchable.map((p) => p.displayName()).join('、') || '无'}）`,
    );
  }

  /**
   * 注册 Provider。
   *
   * @throws ProviderRegistrationError 凭证类型不合法（合规拦截）
   */
  register(provider: PropertyProviderV2): void {
    // ---- 合规校验 ----
    //
    // 这是架构层面的强制约束，而不是流程约定：
    // 如果将来有人想加一个"爬虫 Provider"，他必须先在
    // `ProviderCredentialType` 里加一个新值 —— 而那会是一次
    // 需要 review 的显式改动，不可能悄悄发生。
    if (!ALLOWED_CREDENTIAL_TYPES.has(provider.credentialType)) {
      throw new ProviderRegistrationError(
        String(provider.kind),
        `凭证类型 ${provider.credentialType} 不在合法白名单内。` +
          `合法类型：${[...ALLOWED_CREDENTIAL_TYPES].join(', ')}。` +
          `本项目不接受任何抓取类数据源。`,
      );
    }

    if (this.providers.has(provider.kind)) {
      this.logger.warn(`Provider ${provider.kind} 已注册，将被覆盖`);
    }

    this.providers.set(provider.kind, provider);
    this.healthMonitor.trackProvider(provider);

    this.logger.log(
      `已注册 Provider：${provider.kind}（${provider.displayName()}，` +
        `tier=${provider.tier}，sourceType=${provider.sourceType}，` +
        `凭证=${provider.credentialType}，已配置=${provider.isConfigured()}）`,
    );
  }

  /** 批量注册 */
  registerAll(providers: PropertyProviderV2[]): void {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  /** 取指定 Provider（未注册返回 null，不抛错 —— 多源场景下缺失某源是正常的） */
  get(kind: PropertyProviderKind): PropertyProviderV2 | null {
    return this.providers.get(kind) ?? null;
  }

  /**
   * 取所有**可参与搜索**的 Provider。
   *
   * 过滤规则（Phase 12 强化）：
   *   - 凭证未配置 → 排除（调用必然失败）
   *   - 管理员禁用 → 排除
   *   - **DEMO 源 → 由 `PropertyReliabilityService` 一票否决**
   *     （生产环境永远禁止，开发环境需显式 ALLOW_DEMO_DATA=true）
   *   - OFFLINE 源 → **保留**（贝壳实测是"连接正常但查询失败"，
   *     随时可能恢复；完全跳过会导致恢复后仍不可用）
   */
  getSearchableProviders(options: { includeDemo?: boolean } = {}): PropertyProviderV2[] {
    const result: PropertyProviderV2[] = [];
    const demoDecision = this.reliability.isDemoAllowed();
    const explicitlyIncluded = options.includeDemo === true;

    for (const provider of this.providers.values()) {
      if (!provider.isConfigured()) continue;

      const isDemo =
        provider.sourceType === PropertySourceType.DEMO || provider.tier === ProviderTier.DEMO;

      if (isDemo) {
        // 生产环境即使调用方传 includeDemo=true 也不放行 —— 一票否决
        if (!demoDecision.allowed) {
          this.logger.debug(
            `已排除演示数据源 ${provider.kind}：${demoDecision.reason}`,
          );
          continue;
        }

        // 开发环境：需要显式要求才包含
        if (!explicitlyIncluded) {
          this.logger.debug(
            `已排除演示数据源 ${provider.kind}（未显式要求包含 Demo）`,
          );
          continue;
        }
      }

      if (this.healthMonitor.isDisabled(provider.kind)) continue;

      result.push(provider);
    }

    // 按层级排序（Level 1 官方 API 优先），同层按健康度排序
    return result.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return this.healthMonitor.sortWeight(b.kind) - this.healthMonitor.sortWeight(a.kind);
    });
  }

  /** Demo 数据策略的当前状态（供后台与界面显示） */
  describeDemoPolicy(): { allowed: boolean; reason: string | null; environment: string } {
    const decision = this.reliability.isDemoAllowed();
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      environment: this.reliability.getEnvironment(),
    };
  }

  /** 列出所有已注册 Provider 的状态（供后台"数据源管理"界面） */
  listStatus(): Array<{
    kind: PropertyProviderKind;
    displayName: string;
    sourceType: PropertySourceType;
    credentialType: ProviderCredentialType;
    tier: ProviderTier;
    configured: boolean;
    canPaginate: boolean;
    maxResultsPerQuery: number;
    supportsImages: boolean;
    supportsRealtimeStatus: boolean;
    health: ProviderHealth;
    stats: ReturnType<ProviderHealthMonitor['getStats']>;
  }> {
    return [...this.providers.values()].map((provider) => ({
      kind: provider.kind,
      displayName: provider.displayName(),
      sourceType: provider.sourceType,
      credentialType: provider.credentialType,
      tier: provider.tier,
      configured: provider.isConfigured(),
      canPaginate: provider.capability.canPaginate,
      maxResultsPerQuery: provider.capability.maxResultsPerQuery,
      supportsImages: provider.capability.supportsImages,
      supportsRealtimeStatus: provider.capability.supportsRealtimeStatus,
      health: this.healthMonitor.getHealth(provider.kind),
      stats: this.healthMonitor.getStats(provider.kind),
    }));
  }

  /** 已注册数量 */
  get size(): number {
    return this.providers.size;
  }

  /** 对所有已配置源做健康探测（供后台手动触发） */
  async probeAll(): Promise<ProviderHealth[]> {
    const configured = [...this.providers.values()].filter((provider) => provider.isConfigured());

    const results = await Promise.allSettled(
      configured.map(async (provider) => {
        const health = await provider.healthCheck();
        this.healthMonitor.recordHealth(health);
        return health;
      }),
    );

    return results
      .filter(
        (item): item is PromiseFulfilledResult<ProviderHealth> => item.status === 'fulfilled',
      )
      .map((item) => item.value);
  }
}
