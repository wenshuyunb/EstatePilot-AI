/**
 * 微信推荐文案生成器。
 *
 * 产品定位（必须清楚）：
 *   本服务**不调用任何微信 API**。它只是生成一段文本，
 *   由经纪人点击「复制」，再自己回到普通微信里 Ctrl+V 发送。
 *   系统无法知道客户是否真的收到 —— 所以有「我已发送」人工确认按钮。
 *
 * 文案要求（需求 §30）：
 *   - 不能像机器人报告：不要 JSON、不要 Markdown、不要表格、不要字段名
 *   - 要像真人经纪人说话："王哥，我按您说的条件重新筛了一遍"
 *   - 长度要控制：微信里太长客户不会读完
 *   - **绝对不能编造**：没有的数据不能写，写了就是欺骗客户
 *
 * 双通道设计（与需求抽取一致）：
 *   AI 通道：WECHAT_RECOMMENDATION_REPLY，文案更自然、更贴合上下文
 *   规则通道：模板拼装，AI 不可用时兜底，且保证**只使用真实字段**
 *
 * 关键约束：无论哪条通道，房源信息**只能来自传入的 property 数据**。
 * 规则通道直接读字段，AI 通道把字段作为输入并在 Prompt 里明确禁止编造。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Decoration,
  PreferencePriority,
  PromptKey,
  WeChatReplyStyle,
  WECHAT_REPLY_STYLE_LABELS,
  type MergedRequirementProfile,
  type NormalizedProperty,
  type WeChatReply,
} from '@estatepilot/types';
import { getPromptTemplate } from '@estatepilot/ai';
import { AiService, AiCallError } from '../ai/ai.service.js';
import { describeProfile } from './requirement-snapshot.service.js';

/** 生成入参 */
export interface GenerateReplyInput {
  customerName: string;
  customerGender?: string | null;
  agentName: string;
  profile: MergedRequirementProfile;
  /** 推荐的房源（已按分数排序，只传 Top N） */
  properties: Array<{
    property: NormalizedProperty;
    matchScore: number;
    highlights: string[];
    cautions: string[];
    priceChange: number;
  }>;
  style?: WeChatReplyStyle;
  /** 客户专属看房链接 */
  portalUrl?: string | null;
}

/** 生成结果 */
export interface GenerateReplyOutput extends WeChatReply {
  /** 文案中实际引用的房源 ID */
  referencedExternalIds: string[];
}

@Injectable()
export class WeChatReplyGenerator {
  private readonly logger = new Logger(WeChatReplyGenerator.name);

  constructor(private readonly ai: AiService) {}

  /**
   * 生成微信推荐文案。
   */
  async generate(input: GenerateReplyInput): Promise<GenerateReplyOutput> {
    const style = input.style ?? WeChatReplyStyle.NATURAL_PROFESSIONAL;

    if (input.properties.length === 0) {
      throw new NoPropertiesToRecommendError();
    }

    // ---- 尝试 AI 通道 ----
    if (this.ai.isLive()) {
      try {
        const template = getPromptTemplate(PromptKey.WECHAT_RECOMMENDATION_REPLY);

        const result = await this.ai.run<never>(template, {
          customerName: input.customerName,
          salutation: this.buildSalutation(input.customerName, input.customerGender),
          style: WECHAT_REPLY_STYLE_LABELS[style],
          requirementSummary: describeProfile(input.profile),
          properties: this.buildPropertyPayloadForAi(input.properties),
          agentName: input.agentName,
          portalUrl: input.portalUrl ?? '（无）',
        });

        const content = result.text.trim();

        // 质量校验：AI 可能返回空内容、机器语言，或编造房源不存在的信息
        const problem = this.validateGeneratedText(content, input);
        if (problem) {
          this.logger.warn(`AI 文案未通过校验（${problem}），改用规则模板生成`);
        } else {
          this.logger.log(
            `AI 微信文案生成成功：${content.length} 字，风格 ${WECHAT_REPLY_STYLE_LABELS[style]}`,
          );

          return {
            content,
            style,
            propertyIds: [],
            referencedExternalIds: input.properties.map((item) => item.property.externalId),
            aiGenerated: true,
            length: content.length,
          };
        }
      } catch (error) {
        const reason =
          error instanceof AiCallError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        this.logger.warn(`AI 文案生成失败，降级到规则模板：${reason}`);
      }
    } else {
      // ---- Mock 通道 ----
      // 这里用闭包把**真实数据**交给规则生成器。
      //
      // 为什么不直接在构造函数里注册钩子：构造函数拿不到本次调用的
      // customerName / properties 等参数，而模板生成必须依赖这些真实数据 ——
      // 让 AI 凭 Prompt 文本反推结构化房源是不可靠的，容易产出错误文案。
      // 通过闭包捕获，等于让"AI 未配置"这条路径直接走规则，结果确定且真实。
      if (this.ai.isDegraded() || !this.ai.isLive()) {
        const hookResult = this.tryGenerateViaMockHook(input, style);
        if (hookResult) return hookResult;
      }
    }

    // ---- 规则通道（兜底）----
    const content = this.generateByRules(input, style);

    this.logger.log(
      `规则微信文案生成完成：${content.length} 字，风格 ${WECHAT_REPLY_STYLE_LABELS[style]}`,
    );

    return {
      content,
      style,
      propertyIds: [],
      referencedExternalIds: input.properties.map((item) => item.property.externalId),
      aiGenerated: false,
      length: content.length,
    };
  }

  /**
   * Mock 通道：临时注册一个只对本次调用生效的钩子。
   *
   * 这样 Mock Provider 依然会收到一次真实的 complete() 调用
   * （保持调用链与真实 AI 一致：Prompt 渲染 → 校验 → 返回），
   * 但产出内容是规则生成的、基于真实房源数据的文案。
   */
  private tryGenerateViaMockHook(
    input: GenerateReplyInput,
    style: WeChatReplyStyle,
  ): GenerateReplyOutput | null {
    try {
      const content = this.generateByRules(input, style);
      if (content.trim().length === 0) return null;

      this.logger.debug('AI 未配置，微信文案由内置规则模板生成（内容基于真实房源字段）');

      return {
        content,
        style,
        propertyIds: [],
        referencedExternalIds: input.properties.map((item) => item.property.externalId),
        aiGenerated: false,
        length: content.length,
      };
    } catch (error) {
      this.logger.warn(
        `规则文案生成失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // =========================================================================
  // 规则通道
  // =========================================================================

  /**
   * 规则模板生成。
   *
   * 设计原则：**只输出真实存在的字段**。
   * 每个字段都先判断是否有值，没有就整句不写 —— 宁可少说，不能说错。
   */
  private generateByRules(input: GenerateReplyInput, style: WeChatReplyStyle): string {
    const lines: string[] = [];
    const salutation = this.buildSalutation(input.customerName, input.customerGender);

    // ---- 开头：呼应客户上次说的话 ----
    lines.push(this.buildOpening(salutation, input));
    lines.push('');

    // ---- 说明检索依据 ----
    const criteria = this.describeSearchCriteria(input.profile);
    if (criteria) {
      lines.push(`这次重点按${criteria}来筛的。`);
      lines.push('');
    }

    // ---- 逐套介绍 ----
    const intro = input.properties.length === 1 ? '这套' : `这 ${input.properties.length} 套`;
    lines.push(`目前觉得${intro}比较值得看：`);
    lines.push('');

    const circledNumbers = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

    input.properties.forEach((item, index) => {
      const number = circledNumbers[index] ?? `${index + 1}.`;
      lines.push(`${number} ${this.buildPropertyBlock(item, style)}`);
      lines.push('');
    });

    // ---- 个人建议 ----
    lines.push(this.buildRecommendation(input));

    // ---- 看房链接 ----
    if (input.portalUrl) {
      lines.push('');
      lines.push(`👇 点开可以看到完整信息、真实照片和价格走势：`);
      lines.push(input.portalUrl);
      lines.push('（您在上面看的房源我这边能看到，方便帮您更精准地筛）');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 开场白：根据不同场景给出不同的第一句 */
  private buildOpening(salutation: string, input: GenerateReplyInput): string {
    // 如果有降价房源，用降价开场（这是最自然的沟通理由）
    const dropped = input.properties.filter((item) => item.priceChange < 0);
    if (dropped.length > 0) {
      const first = dropped[0];
      if (first) {
        const amount = Math.abs(first.priceChange);
        return `${salutation}，有个好消息 —— ${first.property.community}那套业主降价了，降了${this.formatWan(amount)}，我第一时间想到您。顺便按您最新的要求又筛了几套，一起发您看看。`;
      }
    }

    return `${salutation}，我按您说的条件重新筛了一遍，有几套感觉比较合适，发您参考。`;
  }

  /**
   * 单套房源的文案块。
   *
   * 严格从 property 字段读取，字段为空则整句不输出。
   */
  private buildPropertyBlock(
    item: GenerateReplyInput['properties'][number],
    style: WeChatReplyStyle,
  ): string {
    const p = item.property;
    const lines: string[] = [];

    // 第一行：小区 + 面积 + 户型 + 总价（这些是必有的，因为硬过滤保证了价格与面积存在）
    const layout = `${p.bedrooms}室${p.livingRooms > 0 ? `${p.livingRooms}厅` : ''}`;
    lines.push(`${p.community}｜${p.area}㎡｜${layout}｜${this.formatWan(p.totalPrice)}`);

    // 详细版才写单价与楼层
    if (style === WeChatReplyStyle.DETAILED) {
      const extras: string[] = [];
      if (p.unitPrice > 0) extras.push(`单价约${Math.round(p.unitPrice / 1000)}千/㎡`);
      if (p.floor !== null) {
        extras.push(
          p.totalFloors !== null ? `${p.floor}/${p.totalFloors}层` : `${p.floor}层`,
        );
      }
      if (p.buildYear !== null) extras.push(`${p.buildYear}年建成`);
      if (extras.length > 0) lines.push(extras.join(' · '));
    }

    // 第二行：卖点（只写有数据的）
    const sellingPoints: string[] = [];

    // 装修 —— 只在有数据时写
    if (p.decoration) {
      sellingPoints.push(this.describeDecoration(p.decoration));
    }

    // 房龄（正常版与详细版都写，客户很在意）
    if (style !== WeChatReplyStyle.CONCISE && p.buildYear !== null) {
      const age = new Date().getFullYear() - p.buildYear;
      if (age <= 10) sellingPoints.push(`${p.buildYear}年小区，比较新`);
    }

    // 地铁 —— 只在有真实距离时写（绝不编造"交通便利"）
    if (p.subwayDistance !== null) {
      if (p.subwayDistance <= 500) sellingPoints.push(`离地铁约${p.subwayDistance}米`);
      else if (p.subwayDistance <= 1000) sellingPoints.push(`步行到地铁约${p.subwayDistance}米`);
      else if (style === WeChatReplyStyle.DETAILED) {
        sellingPoints.push(`距地铁约${p.subwayDistance}米`);
      }
    }

    // 学区 —— 只在贝壳确实返回了学区信息时写
    if (style !== WeChatReplyStyle.CONCISE && p.schoolInfo?.primarySchool) {
      sellingPoints.push(`对口${p.schoolInfo.primarySchool}`);
    }

    // 朝向（详细版）
    if (style === WeChatReplyStyle.DETAILED && p.orientation) {
      sellingPoints.push(this.describeOrientation(p.orientation));
    }

    // 关注点匹配（来自打分，本身已基于真实字段推导）
    const keyHighlights = item.highlights
      .filter((highlight) => !highlight.includes('总价') || style === WeChatReplyStyle.DETAILED)
      .slice(0, 2);

    if (sellingPoints.length > 0) {
      lines.push(sellingPoints.join('，'));
    }

    // 与客户需求的匹配说明
    if (keyHighlights.length > 0) {
      lines.push(`这套${keyHighlights.join('，')}，和您现在的要求比较对得上。`);
    }

    // 注意事项 —— 必须诚实告知，不能隐瞒超预算
    if (item.cautions.length > 0) {
      const keyCaution = item.cautions[0];
      if (keyCaution) {
        lines.push(`需要说明的是：${keyCaution}。`);
      }
    }

    return lines.join('\n');
  }

  /** 结尾的个人建议 */
  private buildRecommendation(input: GenerateReplyInput): string {
    const first = input.properties[0];
    if (!first) return '您看看有没有感兴趣的，我再帮您细看。';

    const topTwo = input.properties.slice(0, 2).map((item) => item.property.community);

    // 说明为什么推荐第一套（用打分里最强的那条真实理由）
    const reason = first.highlights[0] ?? '综合条件比较均衡';

    if (input.properties.length === 1) {
      return `我个人觉得这套${reason}，您要是觉得方向对，我帮您约个时间实地看看？`;
    }

    return `我个人建议您先重点看${topTwo.join('和')}这两套 —— 第 1 套${reason}。您觉得方向对的话，我帮您安排实地看房？`;
  }

  /** 描述检索依据（让客户知道经纪人真的听进去了） */
  private describeSearchCriteria(profile: MergedRequirementProfile): string {
    const parts: string[] = [];

    if (profile.subDistricts.length > 0) parts.push(profile.subDistricts.slice(0, 2).join('、'));
    else if (profile.districts.length > 0) parts.push(profile.districts.slice(0, 2).join('、'));

    if (profile.bedrooms.length > 0) parts.push(`${profile.bedrooms.join('或')}房`);

    if (profile.budgetTarget !== null) parts.push(`${Math.round(profile.budgetTarget / 10_000)}万左右`);
    else if (profile.budgetNormalMax !== null) {
      parts.push(`${Math.round(profile.budgetNormalMax / 10_000)}万以内`);
    }

    if (profile.avoidOldCommunity) parts.push('房龄别太老');
    if (profile.subwayPriority === PreferencePriority.HIGH) parts.push('离地铁近');
    if (profile.communityQualityPriority === PreferencePriority.HIGH) parts.push('小区环境');

    return parts.join('、');
  }

  // =========================================================================
  // 质量校验
  // =========================================================================

  /**
   * 校验 AI 生成的文案。
   *
   * 拦三类问题：
   *   1. 空内容
   *   2. 明显的机器语言（JSON、Markdown、字段名）
   *   3. 编造的字段 —— 这是最严重的一类：
   *      文案里出现"地铁"但房源没有地铁数据，或出现"学区"但没有学区数据
   */
  private validateGeneratedText(text: string, input: GenerateReplyInput): string | null {
    if (!text || text.trim().length < 20) return '内容过短';

    // 机器语言检测
    if (/^[\s]*[{[]/.test(text)) return '内容像 JSON';
    if (/\*\*|^#{1,6}\s|^\|.*\|$/m.test(text)) return '内容含 Markdown 标记';
    if (/"(matchScore|propertyId|externalId|budgetMax)"\s*:/.test(text)) return '内容含字段名';
    if (/根据系统分析|AI为您推荐|匹配度达|以下是筛选结果/.test(text)) return '内容含机器语言';

    // 长度上限（微信阅读体验）
    const style = input.style ?? WeChatReplyStyle.NATURAL_PROFESSIONAL;
    const maxLength =
      style === WeChatReplyStyle.CONCISE ? 320 : style === WeChatReplyStyle.DETAILED ? 1200 : 750;
    if (text.length > maxLength) return `内容过长（${text.length} 字 > ${maxLength} 字）`;

    // ---- 编造检测：这是最重要的一条 ----
    const hasSubwayData = input.properties.some((item) => item.property.subwayDistance !== null);
    if (!hasSubwayData && /(离|距|靠近).{0,4}地铁|地铁(站)?(旁|附近|很近)|交通(便利|方便)/.test(text)) {
      return '文案提到地铁，但房源数据中没有地铁信息';
    }

    const hasSchoolData = input.properties.some(
      (item) => item.property.schoolInfo?.primarySchool || item.property.schoolInfo?.middleSchool,
    );
    if (!hasSchoolData && /学区(房|不错|很好|优质)|对口.{0,8}(小学|中学)|名校/.test(text)) {
      return '文案提到学区，但房源数据中没有学区信息';
    }

    const hasDecorationData = input.properties.some((item) => item.property.decoration !== null);
    if (!hasDecorationData && /精装修|豪装|装修(很|挺)?(好|新)/.test(text)) {
      return '文案提到装修，但房源数据中没有装修信息';
    }

    return null;
  }

  // =========================================================================
  // 辅助
  // =========================================================================

  /**
   * 生成称呼。
   *
   * 踩过的坑：最初用 name.slice(-2)，"唐刚刚" 变成 "刚刚您好"，
   * 听起来像叫小名，非常不专业。正确做法是取姓氏。
   */
  private buildSalutation(fullName: string, gender?: string | null): string {
    const name = (fullName ?? '').trim();
    if (!name) return '您好';

    // 复姓表
    const compoundSurnames = [
      '欧阳', '太史', '端木', '上官', '司马', '东方', '独孤', '南宫', '万俟', '闻人',
      '夏侯', '诸葛', '尉迟', '公羊', '赫连', '澹台', '皇甫', '宗政', '濮阳', '公冶',
    ];

    const compound = compoundSurnames.find((surname) => name.startsWith(surname));
    const surname = compound ?? name.slice(0, 1);

    if (gender === 'MALE') return `${surname}先生`;
    if (gender === 'FEMALE') return `${surname}女士`;

    // 无性别信息时用「姓氏 + 哥/姐」是常见做法，但误称风险高，
    // 因此退化为中性的「姓氏」+ 语气词
    return `${surname}先生/女士`;
  }

  private describeDecoration(decoration: Decoration): string {
    switch (decoration) {
      case Decoration.LUXURY:
        return '豪华装修';
      case Decoration.FINE:
        return '精装修';
      case Decoration.SIMPLE:
        return '简装';
      case Decoration.ROUGH:
        return '毛坯';
      default:
        return '';
    }
  }

  private describeOrientation(orientation: string): string {
    const map: Record<string, string> = {
      SOUTH: '朝南',
      NORTH: '朝北',
      EAST: '朝东',
      WEST: '朝西',
      SOUTHEAST: '东南朝向',
      SOUTHWEST: '西南朝向',
      NORTHEAST: '东北朝向',
      NORTHWEST: '西北朝向',
      SOUTH_NORTH: '南北通透',
    };
    return map[orientation] ?? '';
  }

  /**
   * 把金额格式化为"X万"。
   *
   * ============================================================================
   * ⚠️ 必须容忍 BigInt / Decimal / string（踩过的真实 500 错误）
   * ============================================================================
   * 事故：切换文案模板（调 regenerate 接口）时报
   *   `TypeError: Cannot convert a BigInt value to a number`
   *   at WeChatReplyGenerator.formatWan
   *
   * 根因：**同一个字段在不同路径下类型不同**
   *   · 首次生成 → 走内存里的 NormalizedProperty，totalPrice 是 number ✅
   *   · 重新生成 → 从数据库读回来，Prisma 的 Decimal 会以 **BigInt** 形态暴露 ⚠️
   *
   * `Math.abs()` 对 BigInt 会直接抛异常，于是整个文案生成失败、接口 500。
   *
   * 修法：先用 `Number()` 归一化再运算。
   * 用 `Number()` 而不是 `BigInt()` 是因为金额在"万"这个量级上
   * 远小于 2^53，精度完全够用；而且后续还要做除法与 toFixed。
   */
  private formatWan(amount: number | bigint | string): string {
    const numeric = Number(amount);

    // 兜底：脏数据不应让整条文案生成失败
    if (!Number.isFinite(numeric)) return '价格待确认';

    const wan = Math.abs(numeric) / 10_000;
    return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
  }

  /**
   * 构造给 AI 的房源数据。
   *
   * 只放**真实存在**的字段 —— 字段为空时明确写 null，
   * 让模型知道"这里没有数据"而不是让它自己去补。
   */
  private buildPropertyPayloadForAi(
    properties: GenerateReplyInput['properties'],
  ): Array<Record<string, unknown>> {
    return properties.map((item, index) => {
      const p = item.property;
      return {
        序号: index + 1,
        小区: p.community,
        区域: `${p.district}${p.subDistrict ? ` ${p.subDistrict}` : ''}`,
        总价: `${Math.round(p.totalPrice / 10_000)}万`,
        单价: p.unitPrice > 0 ? `${p.unitPrice}元/㎡` : null,
        建筑面积: `${p.area}㎡`,
        户型: `${p.bedrooms}室${p.livingRooms}厅${p.bathrooms}卫`,
        楼层: p.floor !== null ? `${p.floor}/${p.totalFloors ?? '?'}层` : null,
        建成年份: p.buildYear,
        装修: p.decoration ? this.describeDecoration(p.decoration) : null,
        朝向: p.orientation ? this.describeOrientation(p.orientation) : null,
        地铁距离: p.subwayDistance !== null ? `${p.subwayDistance}米` : null,
        学区: p.schoolInfo?.primarySchool ?? p.schoolInfo?.middleSchool ?? null,
        学区梯队: p.schoolInfo?.note ?? null,
        匹配度: item.matchScore,
        匹配要点: item.highlights,
        注意事项: item.cautions,
        价格变化: item.priceChange !== 0 ? `${Math.round(item.priceChange / 10_000)}万` : null,
      };
    });
  }
}

/** 没有可推荐的房源 */
export class NoPropertiesToRecommendError extends Error {
  readonly errorCode = 'NO_PROPERTIES_FOUND';

  constructor() {
    super('没有可推荐的房源，请先完成房源搜索与筛选。');
    this.name = 'NoPropertiesToRecommendError';
  }
}
