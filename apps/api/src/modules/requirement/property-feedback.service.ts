/**
 * 客户房源反馈服务。
 *
 * 职责：从客户回复中识别他对**已推荐房源**的态度，以及暴露出的新偏好。
 *
 * 为什么这件事重要（需求 §38）：
 *   客户说"第一套不错，但是还是有点贵，第二套位置不太喜欢，最好还是靠张江近点"，
 *   这一句话里包含三类信息：
 *     1. 对第 1 套的正面态度 + 价格顾虑
 *     2. 对第 2 套的否定 + 位置原因
 *     3. 一条新的偏好：希望离张江更近
 *   如果只是把这句话当成一条普通消息去抽取需求，第 1、2 条信息会永久丢失，
 *   系统就永远学不会"这个客户在意什么"。
 *
 * 关键设计：**不许猜指向**
 *   客户说"第一套"我们能对应到具体房源；
 *   但如果客户说"那套不太行"而无法确定指向哪套，
 *   就标记为 UNKNOWN 并保留原话，**绝不猜测**。
 *   猜错会让系统错误地排除一套其实客户喜欢的房子。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ApiErrorCode,
  PromptKey,
  PropertyFeedbackSentiment,
  type PropertyFeedbackExtraction,
} from '@estatepilot/types';
import { getPromptTemplate } from '@estatepilot/ai';
import { TenantService } from '../tenant/tenant.service.js';
import { AiService, AiCallError } from '../ai/ai.service.js';

/** 记录反馈的输入 */
export interface RecordFeedbackInput {
  customerId: string;
  sourceMessageId: string | null;
  /** 上一轮推荐的房源（用于把"第一套"对应到具体房源） */
  recommendedProperties: Array<{
    propertyId: string;
    externalId: string;
    community: string;
    totalPrice: number;
  }>;
  /** 客户回复的消息原文 */
  messageText: string;
}

/** 记录结果 */
export interface RecordFeedbackOutput {
  /** 记录的反馈条数 */
  recorded: number;
  /** 无法定位到具体房源的反馈条数 */
  unresolved: number;
  /** 识别出的新偏好 */
  preferenceUpdates: Array<{ field: string; newValue: string; reason: string }>;
  /** 是否包含明确否定 */
  hasRejection: boolean;
  /** 反馈来源 */
  source: 'AI' | 'RULES';
  /** 中文摘要 */
  summary: string;
  /** 逐条明细，供前端展示 */
  items: Array<{
    propertyId: string | null;
    community: string | null;
    sentiment: string;
    interestLevel: number | null;
    rawQuote: string | null;
    reactions: Array<{ type: string; reaction: string }>;
    resolved: boolean;
  }>;
}

@Injectable()
export class PropertyFeedbackService {
  private readonly logger = new Logger(PropertyFeedbackService.name);

  constructor(
    private readonly tenant: TenantService,
    private readonly ai: AiService,
  ) {
    // 给 Mock 注册规则实现
    this.ai.registerMockStructuredHook(PromptKey.PROPERTY_FEEDBACK_EXTRACTION, () => null);
  }

  /**
   * 记录客户反馈。
   *
   * 失败不影响主流程 —— 反馈分析是增强能力，不是闭环的必要环节。
   */
  async record(
    organizationId: string,
    input: RecordFeedbackInput,
  ): Promise<RecordFeedbackOutput> {
    const scope = this.tenant.scopeFor(organizationId);

    // ---- 1. 抽取反馈 ----
    const extraction = await this.extractFeedback(input);

    if (extraction.items.length === 0) {
      this.logger.log('客户回复中未识别到对房源的明确反馈');
      return {
        recorded: 0,
        unresolved: 0,
        preferenceUpdates: extraction.preferenceUpdates,
        hasRejection: extraction.hasRejection,
        source: extraction.source,
        summary: extraction.summary,
        items: [],
      };
    }

    // ---- 2. 把客户的指代对应到具体房源 ----
    let recorded = 0;
    let unresolved = 0;
    const items: RecordFeedbackOutput['items'] = [];

    for (const item of extraction.items) {
      // 优先按序号定位（"第一套" → index 1）
      let target = input.recommendedProperties.find(
        (_, index) => item.mentionedIndex !== null && index === item.mentionedIndex - 1,
      );

      // 序号无法定位时，按小区名匹配
      if (!target && item.mentionedCommunity) {
        target = input.recommendedProperties.find((property) =>
          property.community.includes(item.mentionedCommunity ?? ''),
        );
      }

      const resolved = Boolean(target);

      if (!resolved) {
        unresolved += 1;
        this.logger.warn(
          `客户反馈无法定位到具体房源（序号 ${item.mentionedIndex ?? '无'}，` +
            `小区「${item.mentionedCommunity ?? '未提及'}」），已保留原话不猜测`,
        );
      }

      // ---- 3. 落库 ----
      try {
        await scope.create('CustomerPropertyFeedback', {
          data: {
            customerId: input.customerId,
            propertyId: target?.propertyId ?? null,
            sourceMessageId: input.sourceMessageId,
            mentionedIndex: item.mentionedIndex,
            sentiment: this.toSentiment(item.sentiment),
            interestLevel: item.interestLevel,
            rawQuote: item.rawQuote,
            reasons: item.reasons,
            reactions: item.reactions as unknown as object,
            priceReaction: this.findReaction(item.reactions, 'PRICE'),
            locationReaction: this.findReaction(item.reactions, 'LOCATION'),
            layoutReaction: this.findReaction(item.reactions, 'LAYOUT'),
            communityReaction: this.findReaction(item.reactions, 'COMMUNITY'),
          },
        });
        recorded += 1;
      } catch (error) {
        this.logger.warn(
          `反馈落库失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      items.push({
        propertyId: target?.propertyId ?? null,
        community: target?.community ?? item.mentionedCommunity,
        sentiment: item.sentiment,
        interestLevel: item.interestLevel,
        rawQuote: item.rawQuote,
        reactions: item.reactions,
        resolved,
      });
    }

    this.logger.log(
      `客户反馈已记录：${recorded} 条（其中 ${unresolved} 条无法定位到具体房源），` +
        `识别到 ${extraction.preferenceUpdates.length} 项偏好变化`,
    );

    return {
      recorded,
      unresolved,
      preferenceUpdates: extraction.preferenceUpdates,
      hasRejection: extraction.hasRejection,
      source: extraction.source,
      summary: extraction.summary,
      items,
    };
  }

  /** 取客户的反馈历史 */
  async list(
    organizationId: string,
    customerId: string,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      propertyId: string | null;
      sentiment: string;
      interestLevel: number | null;
      rawQuote: string | null;
      reasons: string[];
      priceReaction: string | null;
      locationReaction: string | null;
      createdAt: Date;
    }>
  > {
    const scope = this.tenant.scopeFor(organizationId);

    return scope.findMany<{
      id: string;
      propertyId: string | null;
      sentiment: string;
      interestLevel: number | null;
      rawQuote: string | null;
      reasons: string[];
      priceReaction: string | null;
      locationReaction: string | null;
      createdAt: Date;
    }>('CustomerPropertyFeedback', {
      where: { customerId },
      select: {
        id: true,
        propertyId: true,
        sentiment: true,
        interestLevel: true,
        rawQuote: true,
        reasons: true,
        priceReaction: true,
        locationReaction: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * 统计客户拒绝过的特征，用于后续打分时降权（需求 §37）。
   *
   * 例如客户多次提到"太老了"，那么打分会降低老小区的分数。
   */
  async buildRejectedFeatures(
    organizationId: string,
    customerId: string,
  ): Promise<string[]> {
    const feedbacks = await this.list(organizationId, customerId, 30);

    const features: string[] = [];

    for (const feedback of feedbacks) {
      if (feedback.sentiment !== PropertyFeedbackSentiment.NEGATIVE) continue;

      // 从原因里提取可复用的特征词
      for (const reason of feedback.reasons) {
        const normalized = reason.trim();
        if (normalized.length > 0 && normalized.length <= 20) {
          features.push(normalized);
        }
      }

      // 从维度反应里提取
      if (feedback.locationReaction) features.push('位置不符');
    }

    // 去重并限制数量（过多会让打分过度惩罚）
    return [...new Set(features)].slice(0, 8);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 抽取反馈（AI 优先，规则兜底） */
  private async extractFeedback(input: RecordFeedbackInput): Promise<{
    items: PropertyFeedbackExtraction['items'];
    preferenceUpdates: PropertyFeedbackExtraction['preferenceUpdates'];
    hasRejection: boolean;
    confidence: number;
    summary: string;
    source: 'AI' | 'RULES';
  }> {
    if (this.ai.isLive()) {
      try {
        const template = getPromptTemplate(PromptKey.PROPERTY_FEEDBACK_EXTRACTION);

        const result = await this.ai.run<PropertyFeedbackExtraction>(template, {
          customerName: '客户',
          messageText: input.messageText,
          recommendedProperties: input.recommendedProperties.map((property, index) => ({
            序号: index + 1,
            小区: property.community,
            总价: `${Math.round(property.totalPrice / 10_000)}万`,
          })),
        });

        if (result.data) {
          return { ...result.data, source: 'AI' };
        }
      } catch (error) {
        const reason =
          error instanceof AiCallError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        this.logger.warn(`AI 反馈抽取失败，降级到规则分析：${reason}`);
      }
    }

    return { ...this.extractByRules(input), source: 'RULES' };
  }

  /**
   * 规则反馈抽取。
   *
   * 覆盖最常见的表达模式。虽然不如 AI 细腻，但能抓住主要信号，
   * 且完全确定性 —— 同样的输入永远得到同样的结果。
   */
  private extractByRules(input: RecordFeedbackInput): {
    items: PropertyFeedbackExtraction['items'];
    preferenceUpdates: PropertyFeedbackExtraction['preferenceUpdates'];
    hasRejection: boolean;
    confidence: number;
    summary: string;
  } {
    const text = input.messageText;
    const items: PropertyFeedbackExtraction['items'] = [];
    const preferenceUpdates: PropertyFeedbackExtraction['preferenceUpdates'] = [];

    // 中文序号 → 数字
    const ordinalMap: Record<string, number> = {
      第一: 1, 第二: 2, 第三: 3, 第四: 4, 第五: 5,
      1: 1, 2: 2, 3: 3, 4: 4, 5: 5,
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    };

    // ---- 分句策略（这里踩过坑，逻辑值得说明）----
    //
    // 中文口语里，客户常常一句话评论多套房，且用逗号连接：
    //   "第一套不错，就是有点贵，第二套位置不喜欢"
    //
    // 如果按逗号切分，会得到：
    //   "第一套不错"       → 指向第 1 套，判为 POSITIVE，但**丢失了价格异议**
    //   "就是有点贵"       → 没有指向任何房源 → 被丢弃
    //   "第二套位置不喜欢" → 指向第 2 套，判为 NEGATIVE ✓
    // 结果就是"客户对第 1 套很满意"，完全忽略最重要的价格信号。
    //
    // 如果完全不切分，则第 1 套和第 2 套的反馈会混在一起。
    //
    // 正确做法：按逗号切成**分句**，然后合并 ——
    // 只有明确提到新房源（出现"第X套"或另一个小区名）的分句才另起一条，
    // 否则归入当前正在讨论的那套房。
    const clauses = text
      .split(/[，,。；;!！?？\n]/)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);

    /** 判断分句是否明确指向某套房（返回序号或小区名） */
    const detectTarget = (
      clause: string,
    ): { index: number | null; community: string | null } => {
      let index: number | null = null;
      for (const [key, value] of Object.entries(ordinalMap)) {
        if (clause.includes(`第${key}套`) || clause.includes(`第${key}个`)) {
          index = value;
          break;
        }
      }

      let community: string | null = null;
      for (const property of input.recommendedProperties) {
        if (clause.includes(property.community)) {
          community = property.community;
          break;
        }
      }

      return { index, community };
    };

    // 合并分句：把"没有新指向"的分句并入当前段落
    const segments: Array<{ text: string; index: number | null; community: string | null }> = [];

    for (const clause of clauses) {
      const target = detectTarget(clause);
      const startsNewTarget = target.index !== null || target.community !== null;

      if (startsNewTarget || segments.length === 0) {
        // 新的一段（即使第一段没有明确指向，也先建立段落，后续可能补充指向）
        segments.push({ text: clause, index: target.index, community: target.community });
      } else {
        // 并入上一段（同一套房的补充评价）
        const current = segments[segments.length - 1];
        if (current) {
          current.text = `${current.text}，${clause}`;
        }
      }
    }

    // 只保留真正指向了房源的段落
    const sentences = segments
      .filter((segment) => segment.index !== null || segment.community !== null)
      .map((segment) => segment.text);

    // 没有指向任何房源时，仍然分析一遍全文以提取偏好变化
    if (sentences.length === 0) {
      this.extractPreferenceFromSentence(text, preferenceUpdates);

      return {
        items: [],
        preferenceUpdates,
        hasRejection: false,
        confidence: 0.3,
        summary: preferenceUpdates.length > 0 ? `识别到 ${preferenceUpdates.length} 项偏好变化` : '未识别到明确反馈',
      };
    }

    for (const sentence of sentences) {
      // 找出这句提到的是第几套
      let mentionedIndex: number | null = null;
      for (const [key, value] of Object.entries(ordinalMap)) {
        if (sentence.includes(`第${key}套`) || sentence.includes(`第${key}个`)) {
          mentionedIndex = value;
          break;
        }
      }

      // 找出提到的小区名
      let mentionedCommunity: string | null = null;
      for (const property of input.recommendedProperties) {
        if (sentence.includes(property.community)) {
          mentionedCommunity = property.community;
          break;
        }
      }

      // 没有指向任何房源的句子 → 可能只是偏好表达，跳过
      if (mentionedIndex === null && mentionedCommunity === null) {
        // 但可能包含新的偏好（"最好还是靠张江近点"）
        this.extractPreferenceFromSentence(sentence, preferenceUpdates);
        continue;
      }

      // ---- 判断态度 ----
      //
      // 这里有一个中文特有的坑：**"不喜欢" 里包含 "喜欢"**。
      // 如果直接分别匹配正面词与负面词，会被判为"双匹配"，
      // 进而被当成"先肯定后否定"（中性偏正面）——
      // 实际上客户的意思是完全否定。
      //
      // 解决方式：先把"否定形式"从文本中剔除，再判断是否还含正面词。
      // 例如 "第二套位置不喜欢" → 剔除 "不喜欢" → "第二套位置" → 无正面词 → NEGATIVE
      //      "第一套不错，就是有点贵" → 无否定形式可剔 → 仍有"不错" → 双匹配 → 中性偏正面
      const NEGATED_POSITIVE = /(?:不太|不怎么|不|没)\s*(?:喜欢|满意|考虑|想要|感兴趣|看中)/g;
      const withoutNegatedPositive = sentence.replace(NEGATED_POSITIVE, '【否】');

      const negative =
        /不喜欢|不太喜欢|不满意|不太满意|不考虑|不太考虑|不合适|不太合适|不想要|不太想要|不想看|没兴趣|不感兴趣|算了|放弃|不太好|一般般|有点贵|太贵|贵了|超预算|超出预算|位置(不好|不行|太|不)|太(远|偏|老|旧|吵|小)|不值/.test(
          sentence,
        );

      const positive = /不错|可以|喜欢|满意|挺好|还行|想看|什么时候(能|去)|约(个|看)|有意向|考虑一下|值得看/.test(
        withoutNegatedPositive,
      );

      let sentiment: PropertyFeedbackExtraction['items'][number]['sentiment'] = 'UNKNOWN';
      let interestLevel: number | null = null;

      if (negative && positive) {
        // 先肯定后否定（"不错，就是有点贵"）→ 中性偏高但带明确异议。
        // 注意：这里刻意**不判为 NEGATIVE** —— 客户的整体态度仍是正面的，
        // 只是有具体顾虑。把这种房子直接排除掉是错的（价格可以谈）。
        sentiment = 'POSITIVE';
        interestLevel = 3;
      } else if (negative) {
        sentiment = 'NEGATIVE';
        interestLevel = 1;
      } else if (positive) {
        sentiment = 'POSITIVE';
        interestLevel = /什么时候|想看|约|看房/.test(sentence) ? 5 : 4;
      }

      // ---- 提取维度反应 ----
      const reactions: PropertyFeedbackExtraction['items'][number]['reactions'] = [];

      if (/贵|价格|超预算|总价高|便宜/.test(sentence)) {
        reactions.push({
          type: 'PRICE',
          reaction: /贵|超预算|总价高/.test(sentence) ? '觉得价格偏高' : '关注价格',
        });
      }
      if (/位置|地段|太远|偏|不方便/.test(sentence)) {
        reactions.push({ type: 'LOCATION', reaction: '对位置有意见' });
      }
      if (/户型|格局|房间|厅/.test(sentence)) {
        reactions.push({ type: 'LAYOUT', reaction: '对户型有评价' });
      }
      if (/小区|环境|物业/.test(sentence)) {
        reactions.push({ type: 'COMMUNITY', reaction: '对小区有评价' });
      }
      if (/楼层|几楼|太高|太低/.test(sentence)) {
        reactions.push({ type: 'FLOOR', reaction: '对楼层有意见' });
      }
      if (/装修|毛坯|简装|精装/.test(sentence)) {
        reactions.push({ type: 'DECORATION', reaction: '对装修有评价' });
      }
      if (/老|旧|房龄|年代/.test(sentence)) {
        reactions.push({ type: 'AGE', reaction: '对房龄有意见' });
      }
      if (/学区|学校|上学/.test(sentence)) {
        reactions.push({ type: 'SCHOOL', reaction: '关注学区' });
      }
      if (/地铁|交通|通勤/.test(sentence)) {
        reactions.push({ type: 'SUBWAY', reaction: '关注交通' });
      }

      items.push({
        mentionedIndex,
        mentionedCommunity,
        sentiment,
        interestLevel,
        rawQuote: sentence,
        reasons: reactions.map((reaction) => reaction.reaction),
        reactions,
      });

      // 这句也可能包含偏好
      this.extractPreferenceFromSentence(sentence, preferenceUpdates);
    }

    const hasRejection = items.some((item) => item.sentiment === 'NEGATIVE');

    // 摘要
    const summaryParts: string[] = [];
    const positiveCount = items.filter((item) => item.sentiment === 'POSITIVE').length;
    const negativeCount = items.filter((item) => item.sentiment === 'NEGATIVE').length;
    if (positiveCount > 0) summaryParts.push(`${positiveCount} 套表示感兴趣`);
    if (negativeCount > 0) summaryParts.push(`${negativeCount} 套明确不考虑`);
    if (preferenceUpdates.length > 0) summaryParts.push(`${preferenceUpdates.length} 项偏好变化`);

    return {
      items,
      preferenceUpdates,
      hasRejection,
      // 规则分析对明显表达可靠，对含糊表达无能为力
      confidence: items.length > 0 ? 0.6 : 0.3,
      summary: summaryParts.length > 0 ? summaryParts.join('，') : '未识别到明确反馈',
    };
  }

  /** 从一句话里提取偏好变化 */
  private extractPreferenceFromSentence(
    sentence: string,
    updates: PropertyFeedbackExtraction['preferenceUpdates'],
  ): void {
    // "最好还是靠张江近点" / "希望离XX更近"
    const locationMatch = /(?:最好|希望|要是)?\s*(?:还是)?\s*(?:靠|离|近)\s*([\u4e00-\u9fff]{2,6})\s*(?:近|方便)/.exec(
      sentence,
    );
    if (locationMatch?.[1]) {
      updates.push({
        field: 'districts',
        newValue: `${locationMatch[1]}优先级提高`,
        reason: `客户明确希望离${locationMatch[1]}更近`,
      });
    }

    // "还是有点贵" / "价格能不能再谈谈"
    if (/还是(?:有点|有些)?贵|价格(?:再|能).{0,4}(?:谈|低|少)|预算(?:有点)?紧/.test(sentence)) {
      updates.push({
        field: 'budgetStrictMax',
        newValue: '价格敏感度提高',
        reason: '客户对总价表达顾虑',
      });
    }

    // "房子有点老"
    if (/有点老|太老|房龄(?:有点)?大/.test(sentence)) {
      updates.push({
        field: 'avoidOldCommunity',
        newValue: 'true',
        reason: '客户对房龄有顾虑',
      });
    }

    // "小区环境一般"
    if (/小区.{0,4}(?:一般|不好|差)|环境.{0,4}(?:一般|不好|差)/.test(sentence)) {
      updates.push({
        field: 'communityQualityPriority',
        newValue: 'HIGH',
        reason: '客户对小区环境提出意见',
      });
    }
  }

  private toSentiment(
    value: PropertyFeedbackExtraction['items'][number]['sentiment'],
  ): PropertyFeedbackSentiment {
    switch (value) {
      case 'POSITIVE':
        return PropertyFeedbackSentiment.POSITIVE;
      case 'NEGATIVE':
        return PropertyFeedbackSentiment.NEGATIVE;
      case 'NEUTRAL':
        return PropertyFeedbackSentiment.NEUTRAL;
      default:
        return PropertyFeedbackSentiment.UNKNOWN;
    }
  }

  private findReaction(
    reactions: Array<{ type: string; reaction: string }>,
    type: string,
  ): string | null {
    return reactions.find((reaction) => reaction.type === type)?.reaction ?? null;
  }
}
