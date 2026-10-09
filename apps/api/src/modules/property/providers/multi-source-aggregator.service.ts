/**
 * 多源搜索聚合器（需求 §13、§15）。
 *
 * ============================================================================
 * 核心流程
 * ============================================================================
 *   ProviderSearchQuery
 *        ↓
 *   取可搜索的源（按 tier + 健康度排序）
 *        ↓
 *   并发调用（Promise.allSettled —— 单源失败不影响其它源）
 *        ↓
 *   跨源归并（PropertyDeduplicationService）
 *        ↓
 *   AggregatedProperty[]（带来源追溯）
 *        ↓
 *   交给 HardFilter → MatchScoring（**不感知来源**）
 *
 * ============================================================================
 * 三条硬性设计约束
 * ============================================================================
 * 1. **单源失败绝不让整体失败**（需求 §15）
 *    "用户不能感知单一供应商失败"。因此用 allSettled，
 *    并如实记录哪些源失败了（供界面说明与健康监控）。
 *
 * 2. **永不返回空结果而不解释**
 *    如果有源失败了，结果里必须带 `executions` 说明；
 *    如果全部失败，抛出带明细的错误，而不是让上层以为"没有房源"。
 *
 * 3. **DEMO 源默认排除**
 *    在注册表层已经拦掉，这里再兜一层 —— 演示数据绝不能进入真实推荐。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ProviderErrorCode,
  PropertySourceType,
  ProviderError,
  type AggregatedProperty,
  type MultiSourceSearchResult,
  type NormalizedProperty,
  type PropertyProviderKind,
  type PropertyProviderV2,
  type PropertySourceRef,
  type ProviderExecutionResult,
  type ProviderSearchQuery,
} from '@estatepilot/types';
import { ProviderRegistryV2 } from './provider-registry-v2.js';
import { ProviderHealthMonitor } from './provider-health-monitor.service.js';
import { PropertyReliabilityService } from '../reliability/property-reliability.service.js';
import { PropertyDeduplicationService, DeduplicationVerdict } from '../dedup/property-deduplication.service.js';

/** 聚合选项 */
export interface AggregateOptions {
  /** 每个源最多取多少条（默认 10 —— 与贝壳的 TopK 一致） */
  perProviderLimit?: number;
  /** 单源超时（毫秒，默认 15 秒） */
  perProviderTimeoutMs?: number;
  /** 整体超时（毫秒，默认 30 秒 —— 与产品"几十秒内出结果"的目标一致） */
  totalTimeoutMs?: number;
  /** 是否包含 DEMO 源（仅用于演示环境，**生产必须为 false**） */
  includeDemo?: boolean;
}

/** 全部源都失败时抛出（区别于"零结果"） */
export class AllProvidersFailedError extends ProviderError {
  constructor(
    readonly executions: ProviderExecutionResult[],
    message: string,
  ) {
    super(
      executions[0]?.provider ?? ('MOCK' as PropertyProviderKind),
      ProviderErrorCode.UNAVAILABLE,
      message,
      { retryable: true, retryAfterMs: 10_000 },
    );
    this.name = 'AllProvidersFailedError';
  }

  /** 是否为"配置问题"（需要用户处理，重试无用） */
  get isAllConfigurationIssue(): boolean {
    return this.executions.every(
      (execution) =>
        execution.error?.code === ProviderErrorCode.NOT_CONFIGURED ||
        execution.error?.code === ProviderErrorCode.AUTH_FAILED,
    );
  }
}

@Injectable()
export class MultiSourceAggregator {
  private readonly logger = new Logger(MultiSourceAggregator.name);

  constructor(
    private readonly registry: ProviderRegistryV2,
    private readonly healthMonitor: ProviderHealthMonitor,
    private readonly deduplication: PropertyDeduplicationService,
    private readonly reliability: PropertyReliabilityService,
  ) {}

  /**
   * 并发搜索所有可用源并归并。
   *
   * @throws AllProvidersFailedError 全部源都失败（此时不是"零结果"，而是"服务不可用"）
   */
  async search(
    query: ProviderSearchQuery,
    options: AggregateOptions = {},
  ): Promise<MultiSourceSearchResult> {
    const startedAt = Date.now();
    const perProviderLimit = options.perProviderLimit ?? 10;
    const perProviderTimeoutMs = options.perProviderTimeoutMs ?? 15_000;
    const totalTimeoutMs = options.totalTimeoutMs ?? 30_000;

    const providers = this.registry.getSearchableProviders({
      includeDemo: options.includeDemo ?? false,
    });

    if (providers.length === 0) {
      throw new AllProvidersFailedError(
        [],
        '没有可用的房源数据源。请先配置至少一个数据源（贝壳官方凭证，或录入本公司房源）。',
      );
    }

    this.logger.log(
      `多源搜索开始：${providers.length} 个源（${providers
        .map((provider) => `${provider.displayName()}[${provider.tier}]`)
        .join(', ')}）`,
    );

    // ---- 并发调用（单源失败不影响其它源） ----
    const settled = await Promise.allSettled(
      providers.map((provider) =>
        this.searchOne(provider, { ...query, limit: perProviderLimit }, perProviderTimeoutMs),
      ),
    );

    const executions: ProviderExecutionResult[] = [];
    const collected: NormalizedProperty[] = [];

    settled.forEach((result, index) => {
      const provider = providers[index];
      if (!provider) return;

      if (result.status === 'fulfilled') {
        executions.push(result.value.execution);
        collected.push(...result.value.items);

        this.healthMonitor.recordCall(provider.kind, {
          success: true,
          durationMs: result.value.execution.durationMs,
          itemCount: result.value.items.length,
        });
      } else {
        // 理论上 searchOne 内部已捕获所有错误，这里是最后兜底
        const error = this.toProviderError(result.reason, provider);
        executions.push({
          provider: provider.kind,
          displayName: provider.displayName(),
          success: false,
          itemCount: 0,
          durationMs: 0,
          error,
        });

        this.healthMonitor.recordCall(provider.kind, {
          success: false,
          durationMs: 0,
          itemCount: 0,
          errorMessage: error.message,
        });

        this.logger.error(`${provider.displayName()} 搜索失败：${error.message}`);
      }
    });

    const successCount = executions.filter((execution) => execution.success).length;

    // ---- 全部失败 → 明确报错（不是"零结果"） ----
    if (successCount === 0) {
      const detail = executions
        .map((execution) => `${execution.displayName}：${execution.error?.message ?? '未知错误'}`)
        .join('；');

      throw new AllProvidersFailedError(
        executions,
        `所有房源数据源都查询失败。${detail}`,
      );
    }

    // ---- 跨源归并 ----
    const mergeStartedAt = Date.now();
    const { merged, suspected } = this.deduplication.merge(collected);

    // ---- 最后一道防线：即使前面漏了，这里再拦一次演示数据 ----
    // 需求 §3/§13：禁止 Demo 进入推荐。多层防御的理由是 ——
    // 一次配置失误就可能让假房源发给真实客户，代价太高。
    const demoDecision = this.reliability.isDemoAllowed();
    const safeGroups = merged.filter((group) => {
      const primary = group.primary;
      if (primary.externalProvider === ('MOCK' as PropertyProviderKind)) {
        if (!demoDecision.allowed) {
          this.logger.warn('已从聚合结果中剔除演示数据源房源（生产环境禁止）');
          return false;
        }
      }
      return true;
    });

    const aggregated = safeGroups.map((group) =>
      this.toAggregatedProperty(group.primary, group.duplicates),
    );
    const multiSourceCount = aggregated.filter((item) => item.sources.length > 1).length;

    const totalDurationMs = Date.now() - startedAt;

    this.logger.log(
      `多源搜索完成：${successCount}/${providers.length} 个源成功，` +
        `原始 ${collected.length} 条 → 归并后 ${aggregated.length} 条` +
        `（${multiSourceCount} 条来自多个源，疑似待确认 ${suspected.length} 组），` +
        `去重耗时 ${Date.now() - mergeStartedAt}ms，总耗时 ${totalDurationMs}ms` +
        (totalDurationMs > totalTimeoutMs ? '（超出预算）' : ''),
    );

    return {
      properties: aggregated,
      executions,
      stats: {
        rawCount: collected.length,
        mergedCount: aggregated.length,
        mergedAway: collected.length - aggregated.length,
        multiSourceCount,
      },
      totalDurationMs,
    };
  }

  /**
   * 调用单个 Provider（含超时控制）。
   *
   * **不抛错** —— 失败时返回带 error 的执行结果。
   * 这样上层用 allSettled 处理时永远只需处理成功路径，逻辑更简单。
   */
  private async searchOne(
    provider: PropertyProviderV2,
    query: ProviderSearchQuery,
    timeoutMs: number,
  ): Promise<{ items: NormalizedProperty[]; execution: ProviderExecutionResult }> {
    const startedAt = Date.now();

    try {
      const result = await this.withTimeout(provider.search(query), timeoutMs, provider);

      return {
        items: result.items,
        execution: {
          provider: provider.kind,
          displayName: provider.displayName(),
          success: true,
          itemCount: result.items.length,
          durationMs: result.durationMs,
          error: null,
        },
      };
    } catch (error) {
      const providerError = this.toProviderError(error, provider);

      this.logger.warn(
        `${provider.displayName()} 搜索失败（${providerError.code}）：${providerError.message}`,
      );

      return {
        items: [],
        execution: {
          provider: provider.kind,
          displayName: provider.displayName(),
          success: false,
          itemCount: 0,
          durationMs: Date.now() - startedAt,
          error: providerError,
        },
      };
    }
  }

  /** 超时包装（超时是"可重试的供应商侧问题"） */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    provider: PropertyProviderV2,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ProviderError(
            provider.kind,
            ProviderErrorCode.TIMEOUT,
            `${provider.displayName()} 响应超时（${timeoutMs}ms）`,
            { retryable: true, retryAfterMs: 3_000 },
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 把归并结果转成 `AggregatedProperty`。
   *
   * 关键点：
   *   - 主来源的字段作为主记录的字段（价格等以主来源为准）
   *   - `sources` 记录全部来源，供界面显示"贝壳 + 安居客同时在售"
   *   - `dataConfidence` 随来源数提升（多源交叉验证更可信）
   */
  private toAggregatedProperty(
    primary: NormalizedProperty,
    duplicates: NormalizedProperty[],
  ): AggregatedProperty {
    const all = [primary, ...duplicates];
    const now = new Date();

    const sources: PropertySourceRef[] = all.map((property) => ({
      provider: property.externalProvider,
      sourceType: this.inferSourceType(property.externalProvider),
      externalId: property.externalId,
      sourceUrl: this.extractSourceUrl(property),
      displayName: this.displayNameOf(property.externalProvider),
      totalPrice: property.totalPrice,
      syncedAt: now,
    }));

    const fingerprint = this.deduplication.buildFingerprint(primary).hash;

    // ---- 可信度评估（Phase 12）----
    // 取主来源的声明值。若主来源未注册（例如从库里读出的历史数据），
    // 退回保守值 —— 宁可低估可信度，也不要高估。
    const primaryProvider = this.registry.get(primary.externalProvider);
    const baseScore = primaryProvider
      ? this.reliability.baseScoreOfProvider(primaryProvider)
      : 50;
    const ttlHours = primaryProvider
      ? this.reliability.ttlOfProvider(primaryProvider.capability)
      : null;

    // 聚合场景下，这条房源刚刚从数据源查回来 → 此刻即为最新核验时间
    const primarySourceRef = sources[0]!;
    const assessment = this.reliability.assess({
      baseScore,
      ttlHours,
      // 实时源的搜索结果是"刚刚查到的"，因此以当前时间作为核验时间；
      // 无法核验的来源（ttlHours === null）会被 assess 判为 PENDING
      lastVerifiedAt: ttlHours === null ? null : now,
      sourceType: primarySourceRef.sourceType,
    });

    return {
      // 主记录的字段（含 externalProvider/externalId，保持向后兼容）
      ...primary,

      sources,
      primarySource: primarySourceRef,
      fingerprint,
      /**
       * 数据可信度。
       *
       * 单源 0.7；每多一个来源 +0.1（上限 0.95）。
       *
       * 为什么上限不是 1：多源一致只能说明"平台们抄的是同一份数据"，
       * 不能证明房源真实存在。真实性的最终确认仍然依赖 `checkAvailability`。
       */
      dataConfidence: Math.min(0.95, 0.7 + (sources.length - 1) * 0.1),

      // ---- Phase 12 可信度字段 ----
      dataReliabilityScore: assessment.score,
      lastVerifiedAt: ttlHours === null ? null : now,
      verificationStatus: assessment.status,
      reliabilityNote: assessment.note,
      reliabilityStars: assessment.stars,
      channelFreshness: this.reliability.freshnessScore(
        ttlHours === null ? null : now,
      ),
    };
  }

  /** 从 rawData 里取原始链接（各 Provider 的存放位置不同） */
  private extractSourceUrl(property: NormalizedProperty): string | null {
    const raw = property.rawData;
    if (!raw || typeof raw !== 'object') return null;

    const record = raw as Record<string, unknown>;
    const candidate = record['sourceUrl'] ?? record['url'] ?? record['detailUrl'];

    return typeof candidate === 'string' ? candidate : null;
  }

  /**
   * 推断来源类型。
   *
   * 精确的来源类型应由 Provider 提供，但 `NormalizedProperty` 里没有这个字段
   * （它只有 `externalProvider`）。这里按 provider 推断一个合理值；
   * 需要精确值时用 `registry.get(kind)?.sourceType`。
   */
  private inferSourceType(provider: PropertyProviderKind): PropertySourceType {
    const registered = this.registry.get(provider);
    if (registered) return registered.sourceType;

    // 未注册的（例如从库里读出的历史数据）按下述规则推断
    const name = String(provider);
    if (name === 'BEIKE') return PropertySourceType.OFFICIAL_API;
    if (name === 'MOCK') return PropertySourceType.DEMO;
    if (name === 'INTERNAL') return PropertySourceType.PRIVATE;
    return PropertySourceType.USER_PROVIDED;
  }

  private displayNameOf(provider: PropertyProviderKind): string {
    return this.registry.get(provider)?.displayName() ?? String(provider);
  }

  private toProviderError(error: unknown, provider: PropertyProviderV2): ProviderError {
    if (error instanceof ProviderError) return error;

    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(provider.kind, ProviderErrorCode.UNKNOWN, message, {
      originalError: error instanceof Error ? error : null,
    });
  }
}
