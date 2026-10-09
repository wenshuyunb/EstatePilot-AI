/**
 * 推荐批次控制器。
 *
 * 处理「复制 → 已发送」这条人工确认链路（需求 §33、§34）。
 *
 * 再次强调状态语义（这是本模块最重要的产品决策）：
 *   POST /recommendations/:id/copy          → 记录 copiedAt
 *   POST /recommendations/:id/confirm-sent  → 记录 sentConfirmedAt（人工确认）
 *
 * 系统**不会**自动标记"已发送"。因为我们用的是普通个人微信，
 * 没有任何发送 API —— 系统确实不知道经纪人是否真的发了出去。
 * 假装知道会污染推荐历史，让管理层看到假数据。
 */

import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ApiErrorCode, UserRole, WeChatReplyStyle } from '@estatepilot/types';
import {
  CurrentUser,
  Roles,
  type RequestUser,
} from '../../common/decorators/auth.decorators.js';
import { ZodBody } from '../../common/pipes/zod-validation.pipe.js';
import { BusinessError, NotFoundError } from '../../common/filters/all-exceptions.filter.js';
import { TenantService } from '../tenant/tenant.service.js';
import { RecommendationService } from './recommendation.service.js';
import { PropertyFeedbackService } from './property-feedback.service.js';
import { RequirementProfileService } from './requirement-profile.service.js';
import { WeChatReplyGenerator } from './wechat-reply-generator.service.js';

/** 记录客户反馈的请求 */
const feedbackSchema = z.object({
  message: z.string().min(1, '请粘贴客户的回复内容').max(20_000),
  /** 消息记录 ID（先保存再分析时使用） */
  messageId: z.string().min(1).optional(),
});

/** 重新生成文案 */
const regenerateSchema = z.object({
  style: z.nativeEnum(WeChatReplyStyle).default(WeChatReplyStyle.NATURAL_PROFESSIONAL),
  /** 只对指定房源生成（经纪人人工调整后的顺序） */
  propertyIds: z.array(z.string().min(1)).min(1).max(8).optional(),
  portalUrl: z.string().url().max(500).optional(),
});

type FeedbackInput = z.infer<typeof feedbackSchema>;
type RegenerateInput = z.infer<typeof regenerateSchema>;

@Controller('recommendations')
export class RecommendationController {
  constructor(
    private readonly recommendation: RecommendationService,
    private readonly feedback: PropertyFeedbackService,
    private readonly profileService: RequirementProfileService,
    private readonly replyGenerator: WeChatReplyGenerator,
    private readonly tenant: TenantService,
  ) {}

  /**
   * POST /recommendations/:replyId/copy
   *
   * 经纪人点击「复制微信内容」后调用。
   *
   * ⚠️ 语义：这只表示**文案已复制到剪贴板**，不代表客户已收到。
   *    前端 Toast 也应表达为「已复制，可直接粘贴到微信」，而不是「已发送」。
   */
  @Post(':replyId/copy')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async markCopied(
    @Param('replyId') replyId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ copiedAt: Date; status: string; message: string }> {
    try {
      const result = await this.recommendation.markCopied(user.organizationId, replyId);
      return {
        ...result,
        message: '已复制到剪贴板，请到微信中粘贴发送',
      };
    } catch {
      throw new NotFoundError('推荐文案', replyId);
    }
  }

  /**
   * POST /recommendations/:replyId/confirm-sent
   *
   * 经纪人点击「我已发送」后调用 —— **人工确认**。
   *
   * 这是推荐历史唯一可信的"已触达客户"信号，
   * 也是后续"避免重复推荐"判断的依据。
   */
  @Post(':replyId/confirm-sent')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async confirmSent(
    @Param('replyId') replyId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ sentConfirmedAt: Date; status: string; message: string }> {
    try {
      const result = await this.recommendation.confirmSent(user.organizationId, replyId);
      return {
        ...result,
        message: '已记录发送时间，推荐历史已更新',
      };
    } catch {
      throw new NotFoundError('推荐文案', replyId);
    }
  }

  /**
   * POST /recommendations/:batchId/discard
   *
   * 放弃本批次（例如经纪人觉得推荐得不好，决定重新搜）。
   */
  @Post(':batchId/discard')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async discard(
    @Param('batchId') batchId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ status: string }> {
    try {
      return await this.recommendation.discard(user.organizationId, batchId);
    } catch {
      throw new NotFoundError('推荐批次', batchId);
    }
  }

  /**
   * POST /recommendations/:batchId/feedback
   *
   * 记录客户对已推荐房源的反馈（需求 §38）。
   *
   * 这是闭环的"回流"环节：客户的回复让系统逐渐学会他真正在意什么，
   * 下一轮推荐就会更准。
   *
   * 关键行为：**即使反馈无法定位到具体房源，也不会丢数据** ——
   * 原话会被保存，偏好变化也会被识别出来。
   */
  @Post(':batchId/feedback')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async recordFeedback(
    @Param('batchId') batchId: string,
    @Body(ZodBody(feedbackSchema)) body: FeedbackInput,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    const batch = await this.recommendation.findBatch(user.organizationId, batchId);

    if (!batch) {
      throw new NotFoundError('推荐批次', batchId);
    }

    if (batch.recommendedPropertyIds.length === 0) {
      throw new BusinessError(
        ApiErrorCode.RECOMMENDATION_NOT_FOUND,
        '该批次没有推荐任何房源，无法分析反馈',
        HttpStatus.PRECONDITION_FAILED,
      );
    }

    // 取被推荐房源的基本信息，用于把"第一套"对应到具体房源
    const scope = this.tenant.scopeFor(user.organizationId);
    const properties = await scope.findMany<{
      id: string;
      externalId: string;
      community: string;
      totalPrice: number;
    }>('Property', {
      where: { id: { in: batch.recommendedPropertyIds } },
      select: { id: true, externalId: true, community: true, totalPrice: true },
    });

    // 保持批次里的推荐顺序 —— 客户说的"第一套"指的是界面上显示的第一套
    const orderedProperties = batch.recommendedPropertyIds
      .map((propertyId) => properties.find((property) => property.id === propertyId))
      .filter((property): property is NonNullable<typeof property> => property !== undefined)
      .map((property) => ({
        propertyId: property.id,
        externalId: property.externalId,
        community: property.community,
        totalPrice: property.totalPrice,
      }));

    try {
      const result = await this.feedback.record(user.organizationId, {
        customerId: batch.customerId,
        sourceMessageId: body.messageId ?? null,
        recommendedProperties: orderedProperties,
        messageText: body.message,
      });

      return {
        batchId,
        ...result,
        // 明确告知前端：无法定位的反馈没有被丢弃
        notice:
          result.unresolved > 0
            ? `有 ${result.unresolved} 条反馈无法确定指向哪套房源，已保留原话但不做推测。`
            : null,
      };
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * POST /recommendations/:batchId/regenerate
   *
   * 用不同风格重新生成文案（需求 §31：简洁版 / 正常版 / 详细版）。
   *
   * 注意：**不重新搜索房源**，只是换一种说法。
   * 这样经纪人调整文案时不会触发额外的贝壳调用。
   */
  @Post(':batchId/regenerate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async regenerate(
    @Param('batchId') batchId: string,
    @Body(ZodBody(regenerateSchema)) body: RegenerateInput,
    @CurrentUser() user: RequestUser,
  ): Promise<{ content: string; style: string; aiGenerated: boolean; length: number }> {
    const batch = await this.recommendation.findBatch(user.organizationId, batchId);

    if (!batch) throw new NotFoundError('推荐批次', batchId);

    // 经纪人可以指定只保留哪几套（人工控制，需求 §29）
    const targetIds = body.propertyIds ?? batch.recommendedPropertyIds;

    if (targetIds.length === 0) {
      throw new BusinessError(
        ApiErrorCode.NO_PROPERTIES_FOUND,
        '该批次没有房源可用于生成文案',
        HttpStatus.PRECONDITION_FAILED,
      );
    }

    const scope = this.tenant.scopeFor(user.organizationId);
    const properties = await scope.findMany<Record<string, unknown>>('Property', {
      where: { id: { in: targetIds } },
    });

    if (properties.length === 0) {
      throw new NotFoundError('房源');
    }

    const { profile } = await this.profileService.get(user.organizationId, batch.customerId);

    // 按 targetIds 的顺序排列（经纪人的排序意图要保留）
    const ordered = targetIds
      .map((id) => properties.find((property) => property['id'] === id))
      .filter((property): property is Record<string, unknown> => property !== undefined);

    const reply = await this.replyGenerator.generate({
      customerName: '客户',
      agentName: '',
      profile,
      properties: ordered.map((property) => ({
        property: property as never,
        matchScore: 0,
        highlights: [],
        cautions: [],
        priceChange: 0,
      })),
      style: body.style,
      portalUrl: body.portalUrl ?? null,
    });

    return {
      content: reply.content,
      style: reply.style,
      aiGenerated: reply.aiGenerated,
      length: reply.length,
    };
  }
}
