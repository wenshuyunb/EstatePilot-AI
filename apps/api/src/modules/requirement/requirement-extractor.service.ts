/**
 * 客户需求抽取服务。
 *
 * 从一条粘贴的微信消息中抽取结构化购房需求。
 *
 * 双通道设计（这是本服务的核心决策）：
 *
 *   通道 1：AI（WECHAT_REQUIREMENT_EXTRACTION Prompt）
 *     负责理解复杂、含糊、跨句的表达，例如
 *       "我老婆比较在意小区环境，离地铁最好也别太远"
 *     规则很难覆盖这类隐含优先级。
 *
 *   通道 2：中文房产表达规则解析器
 *     负责模式固定的表达，并且是 **AI 不可用时的兜底**。
 *
 * 为什么必须有兜底：
 *   客户需求是产品命脉。如果 AI 服务超时、限流、或未配置密钥（本项目默认
 *   AI_PROVIDER=mock），整个「粘贴 → 推荐」链路就会瘫痪。
 *   有了规则兜底，即使没有任何 AI 密钥，经纪人依然能完成核心工作 ——
 *   只是理解能力弱一些，但流程不断。
 *
 * 关于 AI 失败的处理（需求 §43）：
 *   AI 失败**不会**导致消息丢失（原文已由 MessageImportService 保存），
 *   也不会让整条流程失败 —— 而是降级到规则解析并标记 degraded。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DecorationPreferenceLevel,
  PromptKey,
  RequirementFloorPreference,
  PreferencePriority,
  BuildingAgePreference,
  DecisionMaker,
  type RequirementExtraction,
} from '@estatepilot/types';
import { getPromptTemplate } from '@estatepilot/ai';
import { AiService, AiCallError } from '../ai/ai.service.js';
import { parseRequirementByRules } from './chinese-expression-parser.js';

/** 抽取结果 */
export interface ExtractionOutcome {
  /** 抽取出的需求 */
  extraction: RequirementExtraction;
  /** 使用的通道 */
  source: 'AI' | 'RULES';
  /** 是否因为 AI 失败而降级 */
  degraded: boolean;
  /** 降级原因 */
  degradedReason: string | null;
  /** 耗时 */
  durationMs: number;
  /** 使用的模型（AI 通道时有值） */
  model: string | null;
  /** Prompt 版本（AI 通道时有值） */
  promptVersion: string | null;
}

/** 已有画像的精简描述，用于给 AI 提供上下文 */
export interface ExistingProfileHint {
  city: string | null;
  districts: string[];
  subDistricts: string[];
  budgetTarget: number | null;
  budgetNormalMax: number | null;
  budgetStretchMax: number | null;
  bedrooms: number[];
  summary: string;
}

@Injectable()
export class RequirementExtractorService {
  private readonly logger = new Logger(RequirementExtractorService.name);

  constructor(private readonly ai: AiService) {
    // 给 Mock Provider 注册真实规则实现。
    //
    // 这一步很关键：AI_PROVIDER=mock 时（本项目默认），
    // Mock 会按 Schema 生成空洞占位值 —— 那会让需求抽取返回一条
    // "城市为示例文本、预算为 0" 的垃圾数据，整个闭环失效。
    // 这里把 Mock 接到真实的中文房产规则解析器上，
    // 使无密钥环境下依然能产出正确的结构化需求。
    this.ai.registerMockStructuredHook(PromptKey.WECHAT_REQUIREMENT_EXTRACTION, (promptText) =>
      this.mockExtract(promptText),
    );
  }

  /**
   * 抽取客户需求。
   *
   * @param messageText 客户微信消息原文
   * @param options.customerName 客户姓名（用于 Prompt 上下文）
   * @param options.existingProfile 已有画像（帮助 AI 判断是否矛盾/改口）
   * @param options.cityHint 已知城市（用于规则兜底，避免规则拿不到城市）
   */
  async extract(
    messageText: string,
    options: {
      customerName?: string;
      existingProfile?: ExistingProfileHint | null;
      cityHint?: string | null;
    } = {},
  ): Promise<ExtractionOutcome> {
    const startedAt = Date.now();
    const trimmed = messageText.trim();

    // ---- 空消息直接拒绝，不浪费 AI 调用 ----
    if (trimmed.length === 0) {
      throw new RequirementEmptyError();
    }

    // ---- 尝试 AI 通道 ----
    if (this.ai.isLive()) {
      try {
        const template = getPromptTemplate(PromptKey.WECHAT_REQUIREMENT_EXTRACTION);

        const result = await this.ai.run<RequirementExtraction>(
          template,
          {
            customerName: options.customerName ?? '客户',
            messageText: trimmed,
            existingProfile: options.existingProfile ?? '（首次沟通，无历史画像）',
            today: new Date().toISOString().slice(0, 10),
          },
          {
            // 业务级校验：城市不能凭空出现（防止模型猜测）
            validate: (data) => this.validateExtraction(data),
          },
        );

        if (result.data) {
          this.logger.log(
            `AI 需求抽取成功：置信度 ${result.data.confidence}，` +
              `缺失关键字段 ${result.data.missingCriticalFields.join('/') || '无'}，` +
              `耗时 ${result.durationMs}ms`,
          );

          return {
            extraction: result.data,
            source: 'AI',
            degraded: result.degraded,
            degradedReason: result.degradedReason,
            durationMs: Date.now() - startedAt,
            model: result.model,
            promptVersion: result.promptVersion,
          };
        }

        // AI 返回了但没有结构化数据 → 走规则兜底
        this.logger.warn('AI 未返回结构化需求，降级到规则解析');
      } catch (error) {
        const reason =
          error instanceof AiCallError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);

        this.logger.warn(`AI 需求抽取失败，降级到规则解析：${reason}`);
      }
    }

    // ---- 规则通道（兜底）----
    //
    // ⚠️ 这里**刻意不把 existingProfile.city 当作 hint 兜底**（踩过的坑）。
    //
    // 原实现：`city: options.cityHint ?? options.existingProfile?.city ?? null`
    //
    // 问题：`parseRequirementByRules` 里 `hint.city` 的优先级**高于消息内容**，
    // 且会被标记成 `citySource: 'explicit'`。所以只要有兜底：
    //   - 客户画像记着"上海"
    //   - 客户这次说"厦门岛外的房子"
    //   - hint 取到画像的"上海" → 解析结果 city=上海、citySource=explicit
    //   - **客户明说的厦门被历史画像彻底压掉**，系统去搜上海房源
    //
    // 结果（实测）：客户要厦门岛外的房子，系统推荐了 5 套浦东新区的房源。
    //
    // 正确做法：城市优先级由**调用方**（编排器）统一决定 ——
    // 编排器掌握完整上下文（经纪人筛选 > 客户本次原话 > 画像 > 资料），
    // 比抽取器局部兜底更可靠。这里只忠实使用传进来的 hint。
    const extraction = parseRequirementByRules(trimmed, {
      city: options.cityHint ?? null,
      knownDistricts: options.existingProfile?.districts ?? [],
    });

    this.logger.log(
      `规则需求抽取完成：置信度 ${extraction.confidence}，` +
        `摘要「${extraction.summary}」，耗时 ${Date.now() - startedAt}ms`,
    );

    return {
      extraction,
      source: 'RULES',
      degraded: true,
      degradedReason: this.ai.isLive()
        ? 'AI 抽取失败，已使用内置规则解析'
        : '未配置 AI 厂商密钥，使用内置规则解析',
      durationMs: Date.now() - startedAt,
      model: null,
      promptVersion: null,
    };
  }

  /**
   * 业务级校验。
   *
   * 主要防的是模型"自作聪明"地补全城市 —— 猜错城市会让系统去搜完全错误的房源，
   * 这种错误对用户来说不可解释且伤害很大。
   */
  private validateExtraction(data: unknown): string | null {
    if (typeof data !== 'object' || data === null) return '输出不是对象';

    const extraction = data as Partial<RequirementExtraction>;

    // 城市必须是 null 或合理的字符串
    if (extraction.city !== null && extraction.city !== undefined) {
      if (typeof extraction.city !== 'string' || extraction.city.length > 10) {
        return `city 取值异常：${String(extraction.city)}`;
      }
    }

    // 预算数值的合理性：房产语境下 10 万 ~ 10 亿
    const budget = extraction.budget;
    if (budget) {
      for (const [key, value] of Object.entries(budget)) {
        if (key === 'strictMax') continue;
        if (value === null || value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return `budget.${key} 不是有效数字：${String(value)}`;
        }
        if (value < 100_000 || value > 1_000_000_000) {
          return `budget.${key} 超出合理范围（10万～10亿）：${value}`;
        }
      }
    }

    if (extraction.confidence !== undefined) {
      if (
        typeof extraction.confidence !== 'number' ||
        extraction.confidence < 0 ||
        extraction.confidence > 1
      ) {
        return `confidence 必须在 0～1 之间：${String(extraction.confidence)}`;
      }
    }

    return null;
  }

  /**
   * Mock 通道：从 Prompt 文本里还原出客户原话，再用规则解析。
   *
   * 这样做的原因：Mock 收到的是一整段渲染后的 Prompt（含系统提示与变量），
   * 需要从中定位【经纪人粘贴的客户微信消息】那一段，才能拿到真正的用户输入。
   */
  private mockExtract(promptText: string): Record<string, unknown> | null {
    const messageText = this.extractMessageFromPrompt(promptText);
    if (!messageText) return null;

    const cityHint = this.extractCityHintFromPrompt(promptText);

    const extraction = parseRequirementByRules(messageText, { city: cityHint });

    // 返回普通的 JSON 对象（会被 Mock 当作 parsed 输出）
    return extraction as unknown as Record<string, unknown>;
  }

  /** 从渲染后的 Prompt 中提取客户消息原文 */
  private extractMessageFromPrompt(promptText: string): string | null {
    // 模板里的分段是「【经纪人粘贴的客户微信消息】\n{{messageText}}」
    const match = /【经纪人粘贴的客户微信消息】\s*\n([\s\S]*?)(?:\n\s*请抽取结构化需求|\n\s*$)/.exec(
      promptText,
    );
    if (match?.[1]) return match[1].trim();

    // 兜底：取最后一段非空内容
    const segments = promptText.split('\n').map((line) => line.trim()).filter(Boolean);
    return segments.length > 0 ? (segments[segments.length - 1] ?? null) : null;
  }

  /** 从 Prompt 中提取已有画像里的城市（作为规则解析的提示） */
  private extractCityHintFromPrompt(promptText: string): string | null {
    const match = /"city"\s*:\s*"([^"]+)"/.exec(promptText);
    return match?.[1] ?? null;
  }
}

/** 消息为空 */
export class RequirementEmptyError extends Error {
  readonly errorCode = 'MESSAGE_EMPTY';

  constructor() {
    super('粘贴的内容为空，请先把客户在微信里说的话复制进来。');
    this.name = 'RequirementEmptyError';
  }
}

/** 缺少城市，无法继续搜索 */
export class MissingLocationError extends Error {
  readonly errorCode = 'MISSING_LOCATION';

  constructor() {
    super(
      '客户需求中缺少城市信息，无法搜索房源。' +
        '请在客户资料中补充城市，或在粘贴的消息中体现（例如"上海浦东"）。',
    );
    this.name = 'MissingLocationError';
  }
}

/**
 * 把已有画像转成给 AI 看的精简描述。
 *
 * 注意控制长度：不要把整个画像塞进去，只放与判断"是否矛盾/改口"相关的字段。
 */
export function buildProfileHint(profile: {
  city: string | null;
  districts: string[];
  subDistricts: string[];
  budgetTarget: number | null;
  budgetNormalMax: number | null;
  budgetStretchMax: number | null;
  bedrooms: number[];
  bedroomsStrict: boolean;
  avoidOldCommunity: boolean;
  subwayDistanceMax: number | null;
  schoolRequired: boolean;
  schoolNotNeeded: boolean;
  communityQualityPriority: string | null;
  subwayPriority: string | null;
}): ExistingProfileHint {
  const parts: string[] = [];
  if (profile.city) parts.push(profile.city);
  if (profile.subDistricts.length > 0) parts.push(profile.subDistricts.join('、'));
  else if (profile.districts.length > 0) parts.push(profile.districts.join('、'));
  if (profile.bedrooms.length > 0) {
    parts.push(`${profile.bedrooms.join('/')}房${profile.bedroomsStrict ? '（硬性）' : ''}`);
  }
  if (profile.budgetTarget !== null) parts.push(`理想${Math.round(profile.budgetTarget / 10_000)}万`);
  if (profile.budgetNormalMax !== null) parts.push(`最高${Math.round(profile.budgetNormalMax / 10_000)}万`);
  if (profile.budgetStretchMax !== null) parts.push(`极限${Math.round(profile.budgetStretchMax / 10_000)}万`);
  if (profile.avoidOldCommunity) parts.push('排除老小区');
  if (profile.subwayDistanceMax !== null) parts.push(`地铁${profile.subwayDistanceMax}米内`);
  if (profile.schoolRequired) parts.push('需要学区');
  if (profile.schoolNotNeeded) parts.push('学区无所谓');
  if (profile.communityQualityPriority === PreferencePriority.HIGH) parts.push('在意小区环境');
  if (profile.subwayPriority === PreferencePriority.HIGH) parts.push('在意地铁');

  return {
    city: profile.city,
    districts: profile.districts,
    subDistricts: profile.subDistricts,
    budgetTarget: profile.budgetTarget,
    budgetNormalMax: profile.budgetNormalMax,
    budgetStretchMax: profile.budgetStretchMax,
    bedrooms: profile.bedrooms,
    summary: parts.length > 0 ? parts.join('，') : '（画像为空的客户）',
  };
}
