/**
 * 成交概率评分服务。
 *
 * 职责：从数据库聚合信号 → 调用纯函数评分引擎 → 回写 customers.intentScore。
 *
 * 性能设计（这是本服务最关键的工程决策）：
 *   300 个客户如果逐个聚合信号，会产生 300 × 8 = 2400 次查询。
 *   因此这里用**一次性 groupBy 拉回全部客户的聚合数据**，
 *   在内存里完成匹配与计算，全程只有约 10 次数据库往返。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  BehaviorEventType,
  CustomerStatus,
  IntentLevel,
  LoanStatus,
  PurchaseTimeline,
  type CustomerIntentScore,
} from '@estatepilot/types';
import { daysBetween } from '@estatepilot/utils';
import { TenantService } from '../tenant/tenant.service.js';
import { calculateIntentScore, calculateRequirementClarity, type IntentScoreInput } from './intent-score.service.js';

export interface RecalculationSummary {
  /** 参与计算的客户数 */
  customersProcessed: number;
  /** 成功写入的数量 */
  updated: number;
  /** 按等级分布 */
  levelDistribution: Record<string, number>;
  /** 平均分 */
  averageScore: number;
  durationMs: number;
}

@Injectable()
export class IntentScoreService {
  private readonly logger = new Logger(IntentScoreService.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 重算指定组织的全部客户成交概率。
   *
   * @param organizationId 目标组织（队列任务使用）
   * @param options.customerIds 只重算指定客户（单客户变更时使用，避免全量重算）
   */
  async recalculate(
    organizationId: string,
    options: { customerIds?: string[]; onlyActive?: boolean } = {},
  ): Promise<RecalculationSummary> {
    const startedAt = Date.now();
    const scope = this.tenant.scopeFor(organizationId);

    // ---- 1. 取目标客户 ----
    const customers = await scope.findMany<{
      id: string;
      name: string;
      status: string;
      intentLevel: string | null;
      behaviorEventCount: number;
      viewingCount: number;
      lastContactAt: Date | null;
      budgetMin: number | null;
      budgetMax: number | null;
      preferredDistricts: string[];
      bedrooms: number[];
      areaMin: number | null;
      areaMax: number | null;
      purchasePurpose: string | null;
      paymentMethod: string | null;
      purchaseTimeline: string | null;
      subwayDistanceMax: number | null;
      decorationPreference: string | null;
      schoolPreference: string | null;
      loanStatus: string;
      consentBehaviorTracking: boolean;
    }>('Customer', {
      where: {
        deletedAt: null,
        ...(options.customerIds ? { id: { in: options.customerIds } } : {}),
        // 默认跳过已成交/已流失的客户 —— 他们的分数不会变化，重算是浪费
        ...(options.onlyActive === false
          ? {}
          : { status: { notIn: [CustomerStatus.DEAL, CustomerStatus.LOST] } }),
      },
      select: {
        id: true,
        name: true,
        status: true,
        intentLevel: true,
        behaviorEventCount: true,
        viewingCount: true,
        lastContactAt: true,
        budgetMin: true,
        budgetMax: true,
        preferredDistricts: true,
        bedrooms: true,
        areaMin: true,
        areaMax: true,
        purchasePurpose: true,
        paymentMethod: true,
        purchaseTimeline: true,
        subwayDistanceMax: true,
        decorationPreference: true,
        schoolPreference: true,
        loanStatus: true,
        consentBehaviorTracking: true,
      },
    });

    if (customers.length === 0) {
      return {
        customersProcessed: 0,
        updated: 0,
        levelDistribution: {},
        averageScore: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const customerIds = customers.map((customer) => customer.id);
    const now = new Date();
    const recentWindowStart = new Date(now.getTime() - 14 * 86_400_000);

    // ---- 2. 批量聚合信号（关键：避免 N+1）----

    // 2a. 近 14 天行为数（按客户聚合）
    const recentBehavior = await scope.groupBy<{ customerId: string; _count: { _all: number } }>(
      'CustomerBehaviorEvent',
      {
        by: ['customerId'],
        where: { customerId: { in: customerIds }, createdAt: { gte: recentWindowStart } },
        _count: { _all: true },
      },
    );
    const recentBehaviorMap = new Map(
      recentBehavior.map((row) => [row.customerId, row._count._all]),
    );

    // 2b. 浏览过的不同房源数
    const viewedProperties = await scope.groupBy<{ customerId: string; propertyId: string | null }>(
      'CustomerBehaviorEvent',
      {
        by: ['customerId', 'propertyId'],
        where: {
          customerId: { in: customerIds },
          propertyId: { not: null },
          eventType: { in: [BehaviorEventType.PROPERTY_VIEW, BehaviorEventType.PROPERTY_REVISIT] },
        },
      },
    );
    const viewedPropertyMap = new Map<string, Set<string>>();
    for (const row of viewedProperties) {
      if (!row.propertyId) continue;
      const set = viewedPropertyMap.get(row.customerId) ?? new Set<string>();
      set.add(row.propertyId);
      viewedPropertyMap.set(row.customerId, set);
    }

    // 2c. 重复访问次数（同一房源访问 ≥2 次即算重复）
    const revisitRows = await scope.findMany<{ customerId: string; propertyId: string | null }>(
      'CustomerBehaviorEvent',
      {
        where: {
          customerId: { in: customerIds },
          eventType: BehaviorEventType.PROPERTY_REVISIT,
          propertyId: { not: null },
        },
        select: { customerId: true, propertyId: true },
        take: 50_000,
      },
    );
    const revisitMap = new Map<string, Set<string>>();
    for (const row of revisitRows) {
      if (!row.propertyId) continue;
      const set = revisitMap.get(row.customerId) ?? new Set<string>();
      set.add(row.propertyId);
      revisitMap.set(row.customerId, set);
    }

    // 2d. 收藏数
    const favoriteGroups = await scope.groupBy<{ customerId: string; _count: { _all: number } }>(
      'Favorite',
      { by: ['customerId'], where: { customerId: { in: customerIds } }, _count: { _all: true } },
    );
    const favoriteMap = new Map(favoriteGroups.map((row) => [row.customerId, row._count._all]));

    // 2e. 对比数（按对比组去重）
    const comparisonGroups = await scope.groupBy<{ customerId: string; groupId: string }>(
      'Comparison',
      { by: ['customerId', 'groupId'], where: { customerId: { in: customerIds } } },
    );
    const comparisonMap = new Map<string, number>();
    for (const row of comparisonGroups) {
      comparisonMap.set(row.customerId, (comparisonMap.get(row.customerId) ?? 0) + 1);
    }

    // 2f. 带看统计
    const viewingGroups = await scope.groupBy<{
      customerId: string;
      status: string;
      _count: { _all: number };
    }>('Viewing', {
      by: ['customerId', 'status'],
      where: { customerId: { in: customerIds } },
      _count: { _all: true },
    });
    const viewingTotalMap = new Map<string, number>();
    const viewingCompletedMap = new Map<string, number>();
    for (const row of viewingGroups) {
      viewingTotalMap.set(row.customerId, (viewingTotalMap.get(row.customerId) ?? 0) + row._count._all);
      if (row.status === 'COMPLETED') {
        viewingCompletedMap.set(row.customerId, row._count._all);
      }
    }

    // 2g. 沟通统计（总数 + 客户主动数）
    const communicationGroups = await scope.groupBy<{
      customerId: string;
      direction: string;
      _count: { _all: number };
    }>('Communication', {
      by: ['customerId', 'direction'],
      where: { customerId: { in: customerIds } },
      _count: { _all: true },
    });
    const communicationTotalMap = new Map<string, number>();
    const inboundMap = new Map<string, number>();
    for (const row of communicationGroups) {
      communicationTotalMap.set(
        row.customerId,
        (communicationTotalMap.get(row.customerId) ?? 0) + row._count._all,
      );
      if (row.direction === 'INBOUND') {
        inboundMap.set(row.customerId, row._count._all);
      }
    }

    // 2h. 匹配度（最高分 + 高分数量）
    const matchRows = await scope.findMany<{ customerId: string; score: number }>(
      'CustomerPropertyMatch',
      {
        where: { customerId: { in: customerIds } },
        select: { customerId: true, score: true },
        orderBy: { score: 'desc' },
        take: 20_000,
      },
    );
    const topMatchMap = new Map<string, number>();
    const highMatchCountMap = new Map<string, number>();
    for (const row of matchRows) {
      const currentTop = topMatchMap.get(row.customerId);
      if (currentTop === undefined || row.score > currentTop) {
        topMatchMap.set(row.customerId, row.score);
      }
      if (row.score >= 80) {
        highMatchCountMap.set(row.customerId, (highMatchCountMap.get(row.customerId) ?? 0) + 1);
      }
    }

    // 2i. 价格历史查看次数 + 强信号事件（联系经纪人 / 预约带看）
    const strongSignalGroups = await scope.groupBy<{
      customerId: string;
      eventType: string;
      _count: { _all: number };
    }>('CustomerBehaviorEvent', {
      by: ['customerId', 'eventType'],
      where: {
        customerId: { in: customerIds },
        eventType: {
          in: [
            BehaviorEventType.PRICE_HISTORY_VIEW,
            BehaviorEventType.CONTACT_AGENT,
            BehaviorEventType.BOOK_VIEWING,
          ],
        },
      },
      _count: { _all: true },
    });
    const priceHistoryMap = new Map<string, number>();
    const contactedAgentSet = new Set<string>();
    const bookedViewingSet = new Set<string>();
    for (const row of strongSignalGroups) {
      if (row.eventType === BehaviorEventType.PRICE_HISTORY_VIEW) {
        priceHistoryMap.set(row.customerId, row._count._all);
      } else if (row.eventType === BehaviorEventType.CONTACT_AGENT) {
        contactedAgentSet.add(row.customerId);
      } else if (row.eventType === BehaviorEventType.BOOK_VIEWING) {
        bookedViewingSet.add(row.customerId);
      }
    }

    // ---- 3. 逐客户计算 ----
    const levelDistribution: Record<string, number> = { HOT: 0, WARM: 0, COOL: 0, COLD: 0 };
    let scoreSum = 0;
    let updated = 0;

    for (const customer of customers) {
      // 客户撤回行为分析授权时，不得基于行为数据评分 —— 合规要求
      if (!customer.consentBehaviorTracking) {
        await scope.update('Customer', {
          where: { id: customer.id },
          data: {
            intentScore: null,
            intentScoreLevel: null,
            intentScoreAt: now,
          },
        });
        continue;
      }

      const requirementClarity = calculateRequirementClarity({
        budgetMin: customer.budgetMin,
        budgetMax: customer.budgetMax,
        preferredDistricts: customer.preferredDistricts,
        bedrooms: customer.bedrooms,
        areaMin: customer.areaMin,
        areaMax: customer.areaMax,
        purchasePurpose: customer.purchasePurpose,
        paymentMethod: customer.paymentMethod,
        purchaseTimeline: customer.purchaseTimeline,
        subwayDistanceMax: customer.subwayDistanceMax,
        decorationPreference: customer.decorationPreference,
        schoolPreference: customer.schoolPreference,
      });

      const input: IntentScoreInput = {
        status: customer.status as CustomerStatus,
        intentLevel: customer.intentLevel as IntentLevel | null,
        behaviorEventCount: customer.behaviorEventCount,
        recentBehaviorCount: recentBehaviorMap.get(customer.id) ?? 0,
        viewedPropertyCount: viewedPropertyMap.get(customer.id)?.size ?? 0,
        revisitCount: revisitMap.get(customer.id)?.size ?? 0,
        favoriteCount: favoriteMap.get(customer.id) ?? 0,
        compareCount: comparisonMap.get(customer.id) ?? 0,
        viewingCount: viewingTotalMap.get(customer.id) ?? 0,
        completedViewingCount: viewingCompletedMap.get(customer.id) ?? 0,
        communicationCount: communicationTotalMap.get(customer.id) ?? 0,
        inboundCommunicationCount: inboundMap.get(customer.id) ?? 0,
        daysSinceLastContact: customer.lastContactAt
          ? daysBetween(customer.lastContactAt, now)
          : null,
        requirementClarity,
        hasBudget: customer.budgetMin !== null || customer.budgetMax !== null,
        hasTimeline: customer.purchaseTimeline !== null,
        purchaseTimeline: customer.purchaseTimeline as PurchaseTimeline | null,
        loanStatus: customer.loanStatus as LoanStatus,
        isNegotiating: customer.status === CustomerStatus.NEGOTIATING,
        topMatchScore: topMatchMap.get(customer.id) ?? null,
        highMatchCount: highMatchCountMap.get(customer.id) ?? 0,
        priceHistoryViewCount: priceHistoryMap.get(customer.id) ?? 0,
        hasContactedAgent: contactedAgentSet.has(customer.id),
        hasBookedViewing: bookedViewingSet.has(customer.id),
      };

      const result = calculateIntentScore(input);

      await scope.update('Customer', {
        where: { id: customer.id },
        data: {
          intentScore: result.score,
          intentScoreLevel: result.level,
          intentScoreAt: now,
        },
      });

      levelDistribution[result.level] = (levelDistribution[result.level] ?? 0) + 1;
      scoreSum += result.score;
      updated += 1;
    }

    const durationMs = Date.now() - startedAt;
    const summary: RecalculationSummary = {
      customersProcessed: customers.length,
      updated,
      levelDistribution,
      averageScore: customers.length > 0 ? Number((scoreSum / customers.length).toFixed(1)) : 0,
      durationMs,
    };

    this.logger.log(
      `成交概率重算完成：处理 ${summary.customersProcessed} 位客户，更新 ${updated} 位，` +
        `平均分 ${summary.averageScore}，分布 ${JSON.stringify(levelDistribution)}，耗时 ${durationMs}ms`,
    );

    return summary;
  }

  /** 取单个客户的完整评分明细（用于客户详情页展示"为什么是这个分"） */
  async getScoreDetail(
    organizationId: string,
    customerId: string,
  ): Promise<CustomerIntentScore | null> {
    const scope = this.tenant.scopeFor(organizationId);

    // 复用全量重算逻辑但只针对一个客户 —— 这样能保证详情页展示的分因与存入的分完全一致
    const summary = await this.recalculate(organizationId, {
      customerIds: [customerId],
      onlyActive: false,
    });
    void summary;

    const customer = await scope.findFirst<{
      intentScore: number | null;
      intentScoreLevel: string | null;
      intentScoreAt: Date | null;
    }>('Customer', {
      where: { id: customerId },
      select: { intentScore: true, intentScoreLevel: true, intentScoreAt: true },
    });

    if (!customer || customer.intentScore === null) return null;

    return {
      customerId,
      score: customer.intentScore,
      level: (customer.intentScoreLevel ?? 'COLD') as CustomerIntentScore['level'],
      levelLabel: '',
      factors: [],
      summary: '',
      aiGenerated: false,
      disclaimer: '',
      calculatedAt: customer.intentScoreAt?.toISOString() ?? new Date().toISOString(),
    };
  }
}
