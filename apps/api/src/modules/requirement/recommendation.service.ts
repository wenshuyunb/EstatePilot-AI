/**
 * 推荐批次服务。
 *
 * 职责：记录"某次给某客户推荐了哪些房源"，并管理状态流转。
 *
 * 状态语义（需求 §33、§34 —— 这一点必须严格）：
 *   GENERATED      已生成文案，尚未复制
 *   COPIED         经纪人点了「复制」→ **不代表客户已收到**
 *   SENT_CONFIRMED 经纪人点了「我已发送」→ 人工确认
 *   DISCARDED      经纪人放弃本批次
 *
 * 为什么不能自动记 SENT：
 *   我们用的是普通个人微信，没有任何发送 API。
 *   系统无法知道经纪人是否真的粘贴发送了。
 *   如果自动标记为"已发送"，会产生两个严重后果：
 *     1. 推荐历史失真 —— 管理层看到的数据是假的
 *     2. 后续跟进逻辑错误 —— 系统以为客户已收到并可能在等待回复，
 *        实际上经纪人根本没发
 *   因此必须由人工确认，这是诚实的设计。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  MatchLevel,
  MatchTrigger,
  RecommendationStatus,
  WeChatReplyStyle,
  type ScoredPropertyMatch,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';

/** 创建批次的输入 */
export interface CreateBatchInput {
  customerId: string;
  agentId: string;
  sourceMessageId: string | null;
  requirementSnapshotId: string | null;
  /** 贝壳召回总数 */
  candidateCount: number;
  /** 通过硬筛的数量 */
  hardFilteredCount: number;
  /** 推荐的房源（已排序） */
  properties: Array<{
    propertyId: string;
    externalId: string;
    matchScore: number;
    breakdown: unknown;
    highlights: string[];
    cautions: string[];
    explanation: string | null;
  }>;
  searchQuery: unknown;
  beikeTotalRecalled: number | null;
  durationMs: number;
  /** 生成的文案 */
  reply: {
    content: string;
    style: WeChatReplyStyle;
    aiGenerated: boolean;
  };
}

/** 创建结果 */
export interface CreatedBatch {
  batchId: string;
  replyId: string;
  status: RecommendationStatus;
}

/** 批次详情 */
export interface RecommendationBatchDetail {
  id: string;
  customerId: string;
  status: RecommendationStatus;
  candidateCount: number;
  hardFilteredCount: number;
  recommendedPropertyIds: string[];
  scoreBreakdowns: unknown;
  searchQuery: unknown;
  beikeTotalRecalled: number | null;
  durationMs: number | null;
  createdAt: Date;
  replies: Array<{
    id: string;
    content: string;
    style: string;
    propertyIds: string[];
    copiedAt: Date | null;
    sentConfirmedAt: Date | null;
    aiGenerated: boolean;
    createdAt: Date;
  }>;
}

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 创建一个推荐批次及其文案。
   *
   * 批次与文案是两个记录：一个批次可能对应多版文案
   * （经纪人对同一批房源换了风格重新生成），因此是一对多。
   */
  async createBatch(organizationId: string, input: CreateBatchInput): Promise<CreatedBatch> {
    const scope = this.tenant.scopeFor(organizationId);

    const propertyIds = input.properties.map((item) => item.propertyId);

    // ---- 1. 创建批次 ----
    const batch = await scope.create<{ id: string; createdAt: Date }>('RecommendationBatch', {
      data: {
        customerId: input.customerId,
        agentId: input.agentId,
        sourceMessageId: input.sourceMessageId,
        requirementSnapshotId: input.requirementSnapshotId,
        candidateCount: input.candidateCount,
        hardFilteredCount: input.hardFilteredCount,
        recommendedPropertyIds: propertyIds,
        scoreBreakdowns: input.properties.map((item) => ({
          propertyId: item.propertyId,
          externalId: item.externalId,
          matchScore: item.matchScore,
          breakdown: item.breakdown,
          highlights: item.highlights,
          cautions: item.cautions,
          explanation: item.explanation,
        })) as unknown as object,
        status: RecommendationStatus.GENERATED,
        searchQuery: input.searchQuery as object,
        beikeTotalRecalled: input.beikeTotalRecalled,
        durationMs: input.durationMs,
      },
      select: { id: true, createdAt: true },
    });

    // ---- 2. 创建文案 ----
    const reply = await scope.create<{ id: string }>('GeneratedCustomerReply', {
      data: {
        customerId: input.customerId,
        agentId: input.agentId,
        recommendationBatchId: batch.id,
        content: input.reply.content,
        style: input.reply.style,
        propertyIds,
        aiGenerated: input.reply.aiGenerated,
      },
      select: { id: true },
    });

    this.logger.log(
      `推荐批次已创建：${batch.id}（客户 ${input.customerId}，` +
        `候选 ${input.candidateCount} 套 → 硬筛后 ${input.hardFilteredCount} 套 → ` +
        `推荐 ${propertyIds.length} 套，文案 ${input.reply.content.length} 字，` +
        `总耗时 ${input.durationMs}ms）`,
    );

    return {
      batchId: batch.id,
      replyId: reply.id,
      status: RecommendationStatus.GENERATED,
    };
  }

  /**
   * 记录"已复制"。
   *
   * 语义提醒：这只表示经纪人把文案复制到了剪贴板，
   * **绝不代表客户已经收到**。
   */
  async markCopied(
    organizationId: string,
    replyId: string,
  ): Promise<{ copiedAt: Date; status: RecommendationStatus }> {
    const scope = this.tenant.scopeFor(organizationId);
    const now = new Date();

    const reply = await scope.update<{ id: string; recommendationBatchId: string | null }>(
      'GeneratedCustomerReply',
      {
        where: { id: replyId },
        data: { copiedAt: now },
        select: { id: true, recommendationBatchId: true },
      },
    );

    // 批次状态推进到 COPIED（仅在尚未确认发送时）
    if (reply.recommendationBatchId) {
      const batch = await scope.findFirst<{ status: string }>('RecommendationBatch', {
        where: { id: reply.recommendationBatchId },
        select: { status: true },
      });

      if (batch?.status === RecommendationStatus.GENERATED) {
        await scope.update('RecommendationBatch', {
          where: { id: reply.recommendationBatchId },
          data: { status: RecommendationStatus.COPIED },
        });
      }
    }

    this.logger.log(`文案已复制：${replyId}（等待经纪人确认是否已发送）`);

    return { copiedAt: now, status: RecommendationStatus.COPIED };
  }

  /**
   * 记录"我已发送"（人工确认）。
   *
   * 这是推荐历史的可信来源 —— 只有经过这一步，
   * 系统才认为这条推荐真正触达了客户。
   */
  async confirmSent(
    organizationId: string,
    replyId: string,
  ): Promise<{ sentConfirmedAt: Date; status: RecommendationStatus }> {
    const scope = this.tenant.scopeFor(organizationId);
    const now = new Date();

    const reply = await scope.update<{ id: string; recommendationBatchId: string | null }>(
      'GeneratedCustomerReply',
      {
        where: { id: replyId },
        data: {
          sentConfirmedAt: now,
          // 如果经纪人直接点"我已发送"而没点复制（例如手动敲的字），也补上复制时间
          copiedAt: now,
        },
        select: { id: true, recommendationBatchId: true },
      },
    );

    if (reply.recommendationBatchId) {
      await scope.update('RecommendationBatch', {
        where: { id: reply.recommendationBatchId },
        data: { status: RecommendationStatus.SENT_CONFIRMED },
      });
    }

    this.logger.log(`经纪人确认已发送：${replyId}`);

    return { sentConfirmedAt: now, status: RecommendationStatus.SENT_CONFIRMED };
  }

  /** 放弃批次 */
  async discard(
    organizationId: string,
    batchId: string,
  ): Promise<{ status: RecommendationStatus }> {
    const scope = this.tenant.scopeFor(organizationId);

    await scope.update('RecommendationBatch', {
      where: { id: batchId },
      data: { status: RecommendationStatus.DISCARDED },
    });

    this.logger.log(`推荐批次已放弃：${batchId}`);

    return { status: RecommendationStatus.DISCARDED };
  }

  /**
   * 取批次详情（含文案）。
   */
  async findBatch(
    organizationId: string,
    batchId: string,
  ): Promise<RecommendationBatchDetail | null> {
    const scope = this.tenant.scopeFor(organizationId);

    const batch = await scope.findFirst<{
      id: string;
      customerId: string;
      status: string;
      candidateCount: number;
      hardFilteredCount: number;
      recommendedPropertyIds: string[];
      scoreBreakdowns: unknown;
      searchQuery: unknown;
      beikeTotalRecalled: number | null;
      durationMs: number | null;
      createdAt: Date;
    }>('RecommendationBatch', {
      where: { id: batchId },
      select: {
        id: true,
        customerId: true,
        status: true,
        candidateCount: true,
        hardFilteredCount: true,
        recommendedPropertyIds: true,
        scoreBreakdowns: true,
        searchQuery: true,
        beikeTotalRecalled: true,
        durationMs: true,
        createdAt: true,
      },
    });

    if (!batch) return null;

    const replies = await scope.findMany<{
      id: string;
      content: string;
      style: string;
      propertyIds: string[];
      copiedAt: Date | null;
      sentConfirmedAt: Date | null;
      aiGenerated: boolean;
      createdAt: Date;
    }>('GeneratedCustomerReply', {
      where: { recommendationBatchId: batchId },
      select: {
        id: true,
        content: true,
        style: true,
        propertyIds: true,
        copiedAt: true,
        sentConfirmedAt: true,
        aiGenerated: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      id: batch.id,
      customerId: batch.customerId,
      status: batch.status as RecommendationStatus,
      candidateCount: batch.candidateCount,
      hardFilteredCount: batch.hardFilteredCount,
      recommendedPropertyIds: batch.recommendedPropertyIds,
      scoreBreakdowns: batch.scoreBreakdowns,
      searchQuery: batch.searchQuery,
      beikeTotalRecalled: batch.beikeTotalRecalled,
      durationMs: batch.durationMs,
      createdAt: batch.createdAt,
      replies,
    };
  }

  /**
   * 取客户的推荐历史（需求 §35）。
   *
   * 这是客户 360 页面「历史推荐」区块的数据源，
   * 也是避免重复推荐的依据。
   */
  async listByCustomer(
    organizationId: string,
    customerId: string,
    limit = 10,
  ): Promise<RecommendationBatchDetail[]> {
    const scope = this.tenant.scopeFor(organizationId);

    const batches = await scope.findMany<{
      id: string;
      customerId: string;
      status: string;
      candidateCount: number;
      hardFilteredCount: number;
      recommendedPropertyIds: string[];
      scoreBreakdowns: unknown;
      searchQuery: unknown;
      beikeTotalRecalled: number | null;
      durationMs: number | null;
      createdAt: Date;
    }>('RecommendationBatch', {
      where: { customerId },
      select: {
        id: true,
        customerId: true,
        status: true,
        candidateCount: true,
        hardFilteredCount: true,
        recommendedPropertyIds: true,
        scoreBreakdowns: true,
        searchQuery: true,
        beikeTotalRecalled: true,
        durationMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (batches.length === 0) return [];

    // 一次取出所有相关文案，避免 N+1
    const batchIds = batches.map((batch) => batch.id);
    const replies = await scope.findMany<{
      id: string;
      recommendationBatchId: string | null;
      content: string;
      style: string;
      propertyIds: string[];
      copiedAt: Date | null;
      sentConfirmedAt: Date | null;
      aiGenerated: boolean;
      createdAt: Date;
    }>('GeneratedCustomerReply', {
      where: { recommendationBatchId: { in: batchIds } },
      select: {
        id: true,
        recommendationBatchId: true,
        content: true,
        style: true,
        propertyIds: true,
        copiedAt: true,
        sentConfirmedAt: true,
        aiGenerated: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const repliesByBatch = new Map<string, typeof replies>();
    for (const reply of replies) {
      if (!reply.recommendationBatchId) continue;
      const list = repliesByBatch.get(reply.recommendationBatchId) ?? [];
      list.push(reply);
      repliesByBatch.set(reply.recommendationBatchId, list);
    }

    return batches.map((batch) => ({
      id: batch.id,
      customerId: batch.customerId,
      status: batch.status as RecommendationStatus,
      candidateCount: batch.candidateCount,
      hardFilteredCount: batch.hardFilteredCount,
      recommendedPropertyIds: batch.recommendedPropertyIds,
      scoreBreakdowns: batch.scoreBreakdowns,
      searchQuery: batch.searchQuery,
      beikeTotalRecalled: batch.beikeTotalRecalled,
      durationMs: batch.durationMs,
      createdAt: batch.createdAt,
      replies: (repliesByBatch.get(batch.id) ?? []).map((reply) => ({
        id: reply.id,
        content: reply.content,
        style: reply.style,
        propertyIds: reply.propertyIds,
        copiedAt: reply.copiedAt,
        sentConfirmedAt: reply.sentConfirmedAt,
        aiGenerated: reply.aiGenerated,
        createdAt: reply.createdAt,
      })),
    }));
  }

  /**
   * 记录房源匹配结果到 customer_property_matches。
   *
   * 这张表是"客户为什么喜欢/不喜欢"分析的长期数据基础。
   *
   * 注意字段名与我们的领域模型不同（这是既有表结构，不应为了新功能改动它）：
   *   score              ← matchScore
   *   level              ← 由分数换算的 MatchLevel 枚举
   *   concerns           ← cautions（注意事项/顾虑）
   *   recommendation     ← explanation（推荐理由）
   *   hardFilterFailures ← 未通过硬筛的原因（本流程传入的都通过了，故为空）
   *   trigger            ← 触发来源
   */
  async recordMatches(
    organizationId: string,
    customerId: string,
    matches: ScoredPropertyMatch[],
  ): Promise<void> {
    if (matches.length === 0) return;

    const scope = this.tenant.scopeFor(organizationId);

    for (const match of matches) {
      try {
        // 同一 (customerId, propertyId) 只保留最新一次匹配结果
        const existing = await scope.findFirst<{ id: string }>('CustomerPropertyMatch', {
          where: { customerId, propertyId: match.propertyId },
          select: { id: true },
        });

        const data = {
          score: Math.round(match.matchScore),
          level: this.toMatchLevel(match.matchScore),
          concerns: match.cautions,
          recommendation: match.explanation,
          hardFilterFailures: [],
          trigger: MatchTrigger.MANUAL,
          recommendedAt: new Date(),
        };

        if (existing) {
          await scope.update('CustomerPropertyMatch', { where: { id: existing.id }, data });
        } else {
          await scope.create('CustomerPropertyMatch', {
            data: { customerId, propertyId: match.propertyId, ...data },
          });
        }
      } catch (error) {
        // 单条记录失败不影响主流程
        this.logger.warn(
          `记录匹配结果失败（房源 ${match.propertyId}）：` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** 分数 → 匹配等级（与既有 MatchLevel 阈值保持一致） */
  private toMatchLevel(score: number): MatchLevel {
    if (score >= 90) return MatchLevel.PERFECT;
    if (score >= 80) return MatchLevel.HIGH;
    if (score >= 65) return MatchLevel.MEDIUM;
    if (score >= 50) return MatchLevel.LOW;
    return MatchLevel.WEAK;
  }
}
