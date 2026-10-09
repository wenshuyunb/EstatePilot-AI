/**
 * 贝壳 Provider —— 多源聚合架构下的适配器。
 *
 * ============================================================================
 * 设计原则：这是 **Adapter**，不是重写
 * ============================================================================
 * 现有已经稳定并经过大量实战验证的部分，本文件**一行都不复制、不修改**：
 *   - CLI 调用与重试      → `BeikeMcpClient`
 *   - 凭证注入与脱敏      → `BeikeMcpClient`（凭证走子进程环境变量）
 *   - 响应解析与字段映射  → `BeikeFieldMapper`
 *   - 错误分类            → `BeikeCliError.isUnavailable / isServiceBusy`
 *
 * 本文件的全部职责是**翻译**：
 *   1. `ProviderSearchQuery`（结构化） → 贝壳需要的自然语言查询
 *   2. `BeikeCliResult`（贝壳形态）    → `ProviderSearchResult`（统一形态）
 *   3. `BeikeCliError`（专属错误）     → `ProviderError`（统一错误）
 *
 * 命名说明：类名带 `V2` 后缀，是为与现有 `BeikePropertyProvider`（旧接口实现）
 * 区分 —— 两者共存，旧的不动，新的实现扩展接口。
 * 等编排器迁移完成、确认新接口稳定后，再决定是否合并。
 */

import { Logger } from '@nestjs/common';
import {
  CONSERVATIVE_CAPABILITY,
  PropertyProviderKind,
  PropertySourceType,
  ProviderCredentialType,
  ProviderError,
  ProviderErrorCode,
  ProviderHealthStatus,
  ProviderTier,
  ListingStatus,
  RELIABILITY_TIERS,
  VERIFICATION_TTL,
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
import {
  BeikeCliError,
  BeikeMcpClient,
  BeikeNotConfiguredError,
  type BeikeCliResult,
} from './beike-mcp-client.js';
import { BeikeFieldMapper, type ParsedEntity } from './beike-response-parser.js';

export class BeikePropertyProviderV2 implements PropertyProviderV2 {
  readonly kind = PropertyProviderKind.BEIKE;
  readonly sourceType = PropertySourceType.OFFICIAL_API;
  readonly credentialType = ProviderCredentialType.OFFICIAL_API;
  /**
   * Level 1：官方 API。
   *
   * 注意：层级只影响**多源结果配额分配**（保证各源都有露脸机会），
   * **绝不影响 AI 匹配打分** —— 需求 §16 明确要求评分不看来源。
   */
  readonly tier = ProviderTier.OFFICIAL;

  /**
   * 能力声明。
   *
   * `canPaginate: false` 与 `maxResultsPerQuery: 10` 是关键 ——
   * 贝壳单次只返回 TopK 约 10 条，上层据此决定是否需要"区域放宽重搜"
   * （编排器里那段逻辑就是因为这个限制才存在的）。
   */
  readonly capability: ProviderCapability = {
    ...CONSERVATIVE_CAPABILITY,
    canPaginate: false,
    maxResultsPerQuery: 10,
    supportsDetail: true,
    supportsImages: false,
    supportsFloorPlan: false,
    supportsCommunity: true,
    supportsSchool: true,
    supportsSubway: true,
    supportsSoldHistory: true,
    // 贝壳详情里含「房源售卖状态」（已过户/已签约等），因此可以做实时状态核验
    supportsRealtimeStatus: true,
    cities: 'ALL',
    rateLimit: { requestsPerMinute: 20, dailyQuota: null },
    // Phase 12：贝壳是官方实时 API → 可信度最高，核验有效期 24 小时
    // （在售状态变化快，超过一天就应该重新确认）
    baseReliabilityScore: RELIABILITY_TIERS.OFFICIAL_REALTIME,
    verificationTtlHours: VERIFICATION_TTL.OFFICIAL_REALTIME,
  };

  private readonly logger = new Logger(BeikePropertyProviderV2.name);
  private readonly mapper = new BeikeFieldMapper();

  constructor(private readonly client: BeikeMcpClient) {}

  displayName(): string {
    return '贝壳';
  }

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  // ==========================================================================
  // 检索
  // ==========================================================================

  async search(query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    const startedAt = Date.now();
    const naturalQuery = this.buildNaturalQuery(query);

    this.logger.debug(`贝壳检索：「${naturalQuery}」`);

    let result: BeikeCliResult;
    try {
      result = await this.client.searchHouses({
        city: query.city,
        query: naturalQuery,
        houseType: 'second',
      });
    } catch (error) {
      throw this.toProviderError(error);
    }

    // 只取房源实体（贝壳响应里可能混有小区、学校等其它实体）
    const houseEntities = result.parsed.entities.filter((entity) => entity.kind === 'house');

    // 复用既有的字段映射逻辑（不复制）
    const items = await this.mapEntities(houseEntities, query.city);

    // 贝壳会返回「命中条件」信息，用于判断是否为精确匹配
    const matchedConditions = result.parsed.overview.matchedConditions;
    const exactMatch =
      matchedConditions.length === 0 ||
      matchedConditions.every((condition) => condition.matchType === 'EXACT');

    return {
      provider: this.kind,
      items: query.limit > 0 ? items.slice(0, query.limit) : items,
      totalRecalled: result.parsed.overview.totalRecalled,
      exactMatch,
      // 如实上报：贝壳是语义检索，结构化条件由它自行理解，可能被放宽
      effectiveQuery: {
        city: query.city,
        districts: query.districts,
        subDistricts: query.subDistricts,
        bedrooms: query.bedrooms,
        budgetMax: query.budgetMax,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  async getDetail(externalId: string): Promise<NormalizedProperty | null> {
    try {
      const results = await this.fetchDetailBatch([externalId], '上海');
      return results[0] ?? null;
    } catch (error) {
      // 详情是增强信息，失败不应让整个流程失败 —— 与现有实现的行为保持一致
      this.logger.warn(`贝壳详情补全失败（${externalId}）：${this.describeError(error)}`);
      return null;
    }
  }

  /**
   * 批量补全详情。
   *
   * 暴露这个方法是因为编排器需要**批量**补全（并发 4），
   * 而不是逐个调 `getDetail` —— 逐个调用会丢掉并发控制。
   */
  async fetchDetailBatch(externalIds: string[], city: string): Promise<NormalizedProperty[]> {
    if (externalIds.length === 0) return [];

    try {
      const result = await this.client.fetchDetails({
        city,
        ids: externalIds,
        entityType: 'house',
      });

      const entities = result.parsed.entities.filter((entity) => entity.kind === 'house');
      return this.mapEntities(entities, city);
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  /**
   * 图片。
   *
   * ⚠️ 贝壳的搜索/详情响应里**不含图片 URL**（实测：41 条房源 images 全为 0）。
   * 图片需要单独调 `buy material` 接口。
   *
   * 目前如实声明 `supportsImages: false` 并返回空数组 ——
   * 不编造、不用占位图冒充真实房源图片。
   */
  async getImages(_externalId: string): Promise<PropertyImage[]> {
    return [];
  }

  /**
   * 小区信息。
   *
   * 贝壳的小区数据在详情响应的标签里已经包含（容积率/绿化率/物业费），
   * 因此这里从详情中提取，而不是再打一次独立接口（省一次 CLI 调用）。
   */
  async getCommunity(externalId: string): Promise<CommunityProfile | null> {
    const detail = await this.getDetail(externalId);
    if (!detail) return null;

    return this.extractCommunityFromTags(detail, externalId);
  }

  /**
   * 核验在售状态。
   *
   * 这是**房源的真相来源** —— 列表数据可能过期，
   * 发送给客户前核验"是否仍在售"能避免带看时发现房子已卖。
   */
  async checkAvailability(externalId: string): Promise<AvailabilityResult> {
    const checkedAt = new Date();

    try {
      const detail = await this.getDetail(externalId);

      if (!detail) {
        return {
          externalId,
          status: ListingStatus.ACTIVE,
          currentTotalPrice: null,
          checkedAt,
          method: 'UNAVAILABLE',
        };
      }

      return {
        externalId,
        status: detail.listingStatus,
        currentTotalPrice: detail.totalPrice,
        checkedAt,
        method: 'REALTIME_QUERY',
      };
    } catch {
      return {
        externalId,
        status: ListingStatus.ACTIVE,
        currentTotalPrice: null,
        checkedAt,
        method: 'UNAVAILABLE',
      };
    }
  }

  // ==========================================================================
  // 健康探测
  // ==========================================================================

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date();

    if (!this.isConfigured()) {
      return {
        provider: this.kind,
        sourceType: this.sourceType,
        status: ProviderHealthStatus.NOT_CONFIGURED,
        responseTimeMs: null,
        lastErrorMessage: '贝壳 MCP 凭证未配置',
        checkedAt,
      };
    }

    const startedAt = Date.now();
    try {
      const result = await this.client.diagnose();
      const responseTimeMs = Date.now() - startedAt;

      return {
        provider: this.kind,
        sourceType: this.sourceType,
        status: result.ok ? ProviderHealthStatus.ONLINE : ProviderHealthStatus.OFFLINE,
        responseTimeMs,
        lastErrorMessage: result.ok ? null : result.message,
        checkedAt,
      };
    } catch (error) {
      return {
        provider: this.kind,
        sourceType: this.sourceType,
        status: ProviderHealthStatus.OFFLINE,
        responseTimeMs: Date.now() - startedAt,
        lastErrorMessage: this.describeError(error),
        checkedAt,
      };
    }
  }

  // ==========================================================================
  // 内部：查询构造
  // ==========================================================================

  /**
   * 结构化条件 → 贝壳的自然语言查询。
   *
   * 为什么贝壳需要自然语言：`building.ke.com` 的 `buy search` 接受的是
   * 语义查询串（如「张江 3居室 500万以内 较新小区 近地铁」），
   * 而不是结构化参数。这是它区别于传统结构化 API 的地方 ——
   * 因此这个转换**留在适配器内部**，业务层不需要知道。
   *
   * ⚠️ 价格用 `budgetMax` 作为「多少钱以内」的锚点。
   * 调用方（查询构造器）已经把 `budgetMax` 设成客户的目标价而非放宽后的上限，
   * 避免贝壳只返回"上限附近"的房源（踩过的坑，见查询构造器注释）。
   */
  private buildNaturalQuery(query: ProviderSearchQuery): string {
    const parts: string[] = [];

    // 位置：板块优先（更精确），其次行政区
    if (query.subDistricts.length > 0) {
      parts.push(query.subDistricts.slice(0, 2).join(' '));
    } else if (query.districts.length > 0) {
      parts.push(query.districts.slice(0, 2).join(' '));
    }

    if (query.communities.length > 0) {
      parts.push(query.communities.slice(0, 2).join(' '));
    }

    // 户型
    if (query.bedrooms.length > 0) {
      parts.push(`${query.bedrooms[0]}居室`);
    }

    // 预算
    if (query.budgetMax !== null) {
      parts.push(`${Math.round(query.budgetMax / 10_000)}万以内`);
    }

    // 面积
    if (query.areaMin !== null && query.areaMax !== null) {
      parts.push(`${query.areaMin}-${query.areaMax}平米`);
    } else if (query.areaMin !== null) {
      parts.push(`${query.areaMin}平米以上`);
    }

    // 房龄
    if (query.builtAfterYear !== null) {
      const currentYear = new Date().getFullYear();
      const maxAge = currentYear - query.builtAfterYear;
      if (maxAge <= 30) {
        parts.push(maxAge <= 10 ? '较新小区' : '房龄适中');
      }
    }

    if (query.requireElevator) {
      parts.push('有电梯');
    }

    return parts.join(' ') || `${query.city}二手房`;
  }

  // ==========================================================================
  // 内部：实体映射（复用 BeikeFieldMapper，不复制逻辑）
  // ==========================================================================

  private async mapEntities(entities: ParsedEntity[], city: string): Promise<NormalizedProperty[]> {
    const mapped: NormalizedProperty[] = [];

    for (const entity of entities) {
      try {
        // mapEntity 的第二个参数是 context 对象（不是裸字符串）
        const property = this.mapper.mapEntity(entity, { city });
        if (property) mapped.push(property);
      } catch (error) {
        // 单条映射失败不应中断整批 —— 但要记录，便于发现字段格式变化
        this.logger.warn(
          `贝壳房源映射失败（${entity.id}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return mapped;
  }

  /**
   * 从详情标签里提取小区信息。
   *
   * 贝壳把小区基础信息拼在「标签」字段里，形如：
   *   `...，容积率2.5，绿化率35%，物业费0.8元/平米/月，...`
   * 这里按标签逐条解析，**只提取确实存在的字段**，缺失的保持 null。
   */
  private extractCommunityFromTags(
    detail: NormalizedProperty,
    externalId: string,
  ): CommunityProfile {
    let floorAreaRatio: number | null = null;
    let greenRate: number | null = null;
    let propertyFee: number | null = null;
    let totalHouseholds: number | null = null;
    const facilities: string[] = [];

    for (const tag of detail.tags) {
      const ratioMatch = /容积率\s*([\d.]+)/.exec(tag);
      if (ratioMatch?.[1]) {
        const value = Number.parseFloat(ratioMatch[1]);
        if (Number.isFinite(value)) floorAreaRatio = value;
        continue;
      }

      const greenMatch = /绿化率\s*([\d.]+)\s*%/.exec(tag);
      if (greenMatch?.[1]) {
        const value = Number.parseFloat(greenMatch[1]);
        if (Number.isFinite(value)) greenRate = value;
        continue;
      }

      const feeMatch = /物业费\s*([\d.]+)\s*元/.exec(tag);
      if (feeMatch?.[1]) {
        const value = Number.parseFloat(feeMatch[1]);
        if (Number.isFinite(value)) propertyFee = value;
        continue;
      }

      const householdMatch = /(\d+)\s*户/.exec(tag);
      if (householdMatch?.[1]) {
        const value = Number.parseInt(householdMatch[1], 10);
        if (Number.isFinite(value)) totalHouseholds = value;
        continue;
      }

      // 门禁、监控、人车分流等属于配套描述
      if (/(门禁|监控|人车分流|封闭式|电梯|车位)/.test(tag)) {
        facilities.push(tag);
      }
    }

    return {
      name: detail.community,
      district: detail.district,
      subDistrict: detail.subDistrict,
      buildYear: detail.buildYear,
      floorAreaRatio,
      greenRate,
      propertyFee,
      totalHouseholds,
      developer: null,
      propertyManagementCompany: null,
      facilities,
      rawData: { externalId, source: 'BEIKE_TAGS' },
    };
  }

  // ==========================================================================
  // 内部：错误翻译
  // ==========================================================================

  /**
   * 贝壳专属错误 → 统一 `ProviderError`。
   *
   * 这是适配器的核心价值之一：业务层从此不需要 `instanceof BeikeCliError`。
   *
   * `isUnavailable` / `isServiceBusy` 的判定逻辑**保留在 BeikeMcpClient 里**
   * （它最了解自己的错误特征：硬编码的中文错误串与 errno），
   * 这里只做语义映射 —— 不复制判定规则，避免两处漂移。
   */
  private toProviderError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;

    if (error instanceof BeikeNotConfiguredError) {
      return new ProviderError(this.kind, ProviderErrorCode.NOT_CONFIGURED, error.message, {
        retryable: false,
        originalError: error,
      });
    }

    if (error instanceof BeikeCliError) {
      // 服务端临时不可用 / 繁忙 → 可重试
      if (error.isUnavailable || error.isServiceBusy) {
        return new ProviderError(
          this.kind,
          ProviderErrorCode.UNAVAILABLE,
          '贝壳房源服务暂时不可用（凭证与连接正常，属于对方服务端问题）',
          { retryable: true, retryAfterMs: 5_000, originalError: error },
        );
      }

      const text = `${error.message} ${error.stderr}`;

      // 超时单独归类：虽然也可重试，但等待时间应更短
      if (/超时|timeout|ETIMEDOUT/i.test(text)) {
        return new ProviderError(this.kind, ProviderErrorCode.TIMEOUT, error.message, {
          retryable: true,
          retryAfterMs: 2_000,
          originalError: error,
        });
      }

      // 凭证类问题：重试无用，需要用户处理配置
      if (/凭证|未配置|auth|unauthor|invalid.?key/i.test(text)) {
        return new ProviderError(this.kind, ProviderErrorCode.AUTH_FAILED, error.message, {
          retryable: false,
          originalError: error,
        });
      }

      return new ProviderError(this.kind, ProviderErrorCode.UNKNOWN, error.message, {
        retryable: false,
        originalError: error,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(this.kind, ProviderErrorCode.UNKNOWN, message, {
      originalError: error instanceof Error ? error : null,
    });
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
