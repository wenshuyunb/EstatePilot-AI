/**
 * 微信房产助手控制器。
 *
 * 提供「粘贴微信消息 → 得到真实房源与微信文案」这条闭环的完整 API。
 *
 * 接口设计说明（需求 §54）：
 *   既有**编排入口**（一次调用走完整流程，前端最简单），
 *   也有**分步接口**（每一步可单独调用，便于重试与调试）。
 *   内部全部走 Service 分层，控制器只做参数校验与错误转换。
 *
 * 命名与路由遵循既有约定：全局前缀 /api/v1。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ApiErrorCode,
  MessageImportSource,
  MessageImportType,
  UserRole,
  WeChatReplyStyle,
} from '@estatepilot/types';
import {
  CurrentUser,
  Roles,
  type RequestUser,
} from '../../common/decorators/auth.decorators.js';
import { ZodBody, ZodQuery } from '../../common/pipes/zod-validation.pipe.js';
import {
  BusinessError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../common/filters/all-exceptions.filter.js';
import { BeikePropertyProvider, BeikeCliError } from '../property/providers/beike/beike-property.provider.js';
import { BeikeMcpClient } from '../property/providers/beike/beike-mcp-client.js';
import { TenantService } from '../tenant/tenant.service.js';
import {
  WeChatPropertyAssistantOrchestrator,
  MissingLocationError,
  BeikeTemporarilyUnavailableError,
  NoPropertiesFoundError,
  CustomerNotFoundError,
} from './wechat-assistant.orchestrator.js';
import { MessageImportService, EmptyMessageError } from './message-import.service.js';
import {
  RequirementExtractorService,
  buildProfileHint,
} from './requirement-extractor.service.js';
import { RequirementMergeService } from './requirement-merge.service.js';
import { RequirementProfileService } from './requirement-profile.service.js';
import {
  RequirementSnapshotService,
  describeProfile,
} from './requirement-snapshot.service.js';
import type { RequirementChange } from '@estatepilot/types';
import { PropertyDetailService } from '../property/providers/beike/property-detail.service.js';
import { PropertyDetailStore } from './property-detail.store.js';
import { PropertySearchQueryBuilder } from './property-search-query-builder.service.js';
import { HardFilterService } from './hard-filter.service.js';
import { MatchScoringService } from './match-scoring.service.js';
import { RecommendationService } from './recommendation.service.js';
import { WeChatReplyGenerator } from './wechat-reply-generator.service.js';
import {
  PlatformSearchPlanner,
  type PlatformSearchPlan,
} from './platform-search-planner.service.js';
import { AiService } from '../ai/ai.service.js';

// ---------------------------------------------------------------------------
// 请求 Schema
// ---------------------------------------------------------------------------

/** 编排入口：一次走完整流程 */
const assistantSchema = z.object({
  message: z
    .string()
    .min(1, '请粘贴客户发来的微信消息')
    .max(20_000, '消息过长，请分段处理'),
  recommendationCount: z.coerce.number().int().min(1).max(8).default(5),
  replyStyle: z.nativeEnum(WeChatReplyStyle).default(WeChatReplyStyle.NATURAL_PROFESSIONAL),
  portalUrl: z.string().url().max(500).optional(),
  /**
   * 城市筛选（可选）。界面上选了"厦门"就传"厦门"。
   *
   * 为什么限制长度但不限制必须是预设城市：贝壳支持的城市比我们预设的多，
   * 硬限制反而会挡住合法用法；长度限制是为了防止把超长串塞进查询参数。
   */
  cityOverride: z.string().trim().min(1).max(20).optional(),
  /** 区域筛选（可选）。传具体行政区数组；不传或空数组 = 不限区域（该城市全部） */
  districtOverride: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
});

/** 仅导入消息（不触发 AI） */
const importMessageSchema = z.object({
  message: z.string().min(1, '消息不能为空').max(20_000),
  source: z.nativeEnum(MessageImportSource).default(MessageImportSource.WECHAT_MANUAL_PASTE),
  sourceType: z.nativeEnum(MessageImportType).default(MessageImportType.CUSTOMER_MESSAGE),
});

/** 仅分析需求（不搜索房源） */
const analyzeSchema = z.object({
  messageId: z.string().min(1).optional(),
  message: z.string().min(1).max(20_000).optional(),
});

/** 搜索房源 */
const searchSchema = z.object({
  /** 复用已解析的需求（避免重复调用 AI） */
  useStoredProfile: z.boolean().default(true),
  /** 手动放宽条件（需求 §44：必须经纪人确认后才生效） */
  relax: z
    .object({
      budgetMax: z.coerce.number().int().positive().optional(),
      bedrooms: z.array(z.coerce.number().int().min(1).max(10)).optional(),
      builtAfterYear: z.coerce.number().int().min(1900).max(2100).optional(),
      areaMin: z.coerce.number().int().positive().optional(),
      areaMax: z.coerce.number().int().positive().optional(),
      ignoreSubDistricts: z.boolean().optional(),
    })
    .optional(),
});

/** 生成推荐 */
const generateSchema = z.object({
  recommendationCount: z.coerce.number().int().min(1).max(8).default(5),
  replyStyle: z.nativeEnum(WeChatReplyStyle).default(WeChatReplyStyle.NATURAL_PROFESSIONAL),
  portalUrl: z.string().url().max(500).optional(),
});

/** 分页 */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

type AssistantInput = z.infer<typeof assistantSchema>;
type ImportMessageInput = z.infer<typeof importMessageSchema>;
type AnalyzeInput = z.infer<typeof analyzeSchema>;
type SearchInput = z.infer<typeof searchSchema>;
type GenerateInput = z.infer<typeof generateSchema>;
type ListQuery = z.infer<typeof listQuerySchema>;

@Controller('customers/:customerId')
export class WeChatAssistantController {
  private readonly logger = new Logger(WeChatAssistantController.name);

  constructor(
    private readonly orchestrator: WeChatPropertyAssistantOrchestrator,
    private readonly tenant: TenantService,
    private readonly beikeClient: BeikeMcpClient,
    private readonly messageImport: MessageImportService,
    private readonly extractor: RequirementExtractorService,
    private readonly merger: RequirementMergeService,
    private readonly profileService: RequirementProfileService,
    private readonly snapshotService: RequirementSnapshotService,
    private readonly queryBuilder: PropertySearchQueryBuilder,
    private readonly hardFilter: HardFilterService,
    private readonly scoring: MatchScoringService,
    private readonly recommendation: RecommendationService,
    private readonly replyGenerator: WeChatReplyGenerator,
    private readonly ai: AiService,
    private readonly platformPlanner: PlatformSearchPlanner,
    /**
     * 按需加载房源详情。
     *
     * 为什么需要：实测一次搜索预取全部详情会产生 11-15 次贝壳调用，
     * 密集发出即触发限流（恢复 30 分钟以上），且限流按账号计 ——
     * 多个经纪人共用同一份额度。
     *
     * 因此改为：列表只用搜索响应自带的摘要，经纪人点开某一套时才加载详情。
     * 一次搜索从 11 次调用降到 **1 次**。
     */
    private readonly propertyDetail: PropertyDetailService,
    private readonly detailStore: PropertyDetailStore,
  ) {}

  /**
   * 贝壳用量与配额诊断。
   *
   * ============================================================================
   * 为什么需要这个端点（重要背景）
   * ============================================================================
   * 实测确认：贝壳**没有任何途径可以查询配额**：
   *   · MCP 的 18 个工具里没有 quota/usage 类工具
   *   · 响应头里没有 X-RateLimit-* / Retry-After
   *   · 拿 Key 的页面（building.ke.com）不显示额度
   *   · 本地 CLI 只有 `auth` 命令
   *
   * 因此"我的配额是多少"这个问题**无法从贝壳直接得到答案**。
   * 唯一可行的做法是**自己统计调用量**，并通过观测
   * "首次被限流前发了多少请求"来反推阈值。
   *
   * 本端点就是这个统计的出口。
   */
  @Get('diagnostics/beike-usage')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  getBeikeUsage(@Query('hours') hours?: string): unknown {
    const windowHours = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 24;

    const usageStats = this.beikeClient.getUsageStats();
    const quotaGuard = this.beikeClient.getQuotaGuard();

    /**
     * 立刻判断"下一次调用会不会被挡"—— 比让调用方自己去试更友好。
     *
     * ⚠️ 注意副作用：`check()` 本身不消耗预算（只读判断），可以安全调用。
     */
    const nextCallDecision = quotaGuard.check();

    return {
      report: usageStats.report(windowHours),
      headroom: usageStats.estimateHeadroom(),
      /**
       * 预算护栏状态 —— 这是"我们现在还能调用多少次"的直接答案。
       *
       * 与 `report` 的区别：report 是**事后统计**（已经发了多少），
       * guard 是**事前控制**（还能发多少、现在能不能发）。
       */
      budget: quotaGuard.snapshot(),
      /** 下一次调用是否会被允许（及原因） */
      nextCall: {
        allowed: nextCallDecision.allowed,
        reason: nextCallDecision.reason,
        remaining: nextCallDecision.remaining,
        retryAfter: nextCallDecision.retryAfter,
      },
      /**
       * 说明必须随数据一起返回 —— 避免前端/使用者
       * 误以为这个数字是贝壳给的"官方配额"。
       */
      disclaimer:
        '贝壳不提供配额查询接口，以上是我们自己统计的调用量。' +
        '限额（每小时/每日）是我们**自我保护**设的上限，不是贝壳的真实配额 ——' +
        '真实配额未知，因此设得偏保守。可用环境变量 BEIKE_HOURLY_LIMIT / ' +
        'BEIKE_DAILY_LIMIT 调整。',
    };
  }

  /**
   * 暂停 / 恢复贝壳实时调用（运维开关）。
   *
   * 用途：当发现贝壳开始限流、或需要控制配额消耗时，
   * 可一键切到"只用本地缓存"模式 —— 平台功能不中断，
   * 只是数据不再实时。
   */
  @Post('diagnostics/beike-live-calls')
  @Roles(UserRole.OWNER, UserRole.STORE_MANAGER)
  setLiveCalls(@Body() body: { enabled?: boolean }): unknown {
    const enabled = body?.enabled !== false;

    this.beikeClient.getQuotaGuard().setLiveCallsEnabled(enabled);

    return {
      liveCallsEnabled: enabled,
      message: enabled
        ? '已恢复贝壳实时调用'
        : '已暂停贝壳实时调用，平台将只使用本地缓存数据（功能不中断）',
    };
  }

  /**
   * 按需加载单套房源的完整详情与图片。
   *
   * 数据来源优先级（服务内部实现）：
   *   内存缓存 → 数据库持久化 → 贝壳实时接口
   *
   * 因此同一套房源**反复查看不产生额外调用** —— 这是控制配额的核心。
   */
  @Get('properties/:externalId/detail')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async getPropertyDetail(
    @Param('customerId') customerId: string,
    @Param('externalId') externalId: string,
    @Query('city') city: string | undefined,
    @CurrentUser() user: RequestUser,
  ): Promise<{
    detail: unknown;
    images: unknown[];
    vrUrl: string | null;
    from: string;
    fetchedAt: string | null;
    note: string | null;
    message: string;
  }> {
    /**
     * 城市：优先用查询参数，否则回退到客户画像里的城市。
     *
     * 为什么不能省：贝壳的 `entity_detail` 必须传 city_name，
     * 缺了会返回参数校验错误（且该错误曾误触发熔断）。
     */
    let resolvedCity = city?.trim() ?? '';

    if (resolvedCity.length === 0) {
      const { profile } = await this.profileService.get(user.organizationId, customerId);
      resolvedCity = profile.city ?? '';
    }

    if (resolvedCity.length === 0) {
      return {
        detail: null,
        images: [],
        vrUrl: null,
        from: 'NONE',
        fetchedAt: null,
        note: null,
        message: '缺少城市信息，无法获取房源详情。请确认客户需求里包含城市。',
      };
    }

    const loaded = await this.propertyDetail.load(
      externalId,
      resolvedCity,
      (id) => this.detailStore.loadOne(user.organizationId, id),
      async (id, detail) => {
        await this.detailStore.persistOne(user.organizationId, id, detail);
      },
    );

    if (!loaded) {
      return {
        detail: null,
        images: [],
        vrUrl: null,
        from: 'NONE',
        fetchedAt: null,
        note: null,
        message:
          '暂时无法获取这套房源的完整详情（贝壳可能繁忙或限流）。' +
          '可以稍后重试；列表里的摘要信息仍然可用。',
      };
    }

    const messageBySource: Record<string, string> = {
      MEMORY_CACHE: '详情来自本次会话缓存',
      DATABASE: '详情来自之前获取并保存的数据',
      BEIKE_LIVE: '详情已从贝壳实时获取',
    };

    return {
      detail: loaded.detail,
      images: loaded.images,
      vrUrl: loaded.vrUrl,
      from: loaded.from,
      fetchedAt: loaded.fetchedAt,
      note: loaded.note,
      message: messageBySource[loaded.from] ?? '详情已加载',
    };
  }

  /**
   * 官方平台检索方案。
   *
   * 用途：把客户需求翻译成**可在贝壳 App 里一键搜索**的检索式与条件。
   *
   * 为什么单独开一个端点而不是塞进 wechat-assistant：
   *   - 它**不查房源**，因此不需要贝壳可用、不需要等 10 秒
   *   - 经纪人可以在"只想拿搜索条件去 App 里搜"时单独调用
   *   - 秒级返回，适合做成按钮即时反馈
   *
   * 合规性：本端点**不抓取任何平台数据**，只做本地条件翻译与链接生成。
   */
  @Get('platform-search-plan')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async platformSearchPlan(
    @Param('customerId') customerId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{
    plan: PlatformSearchPlan | null;
    message: string;
  }> {
    const { profile } = await this.profileService.get(user.organizationId, customerId);

    if (profile.sourceMessageCount === 0) {
      return {
        plan: null,
        message: '该客户还没有需求记录。请先在微信消息框粘贴客户的几句话。',
      };
    }

    const built = this.queryBuilder.build(profile);

    if (!built.query.city) {
      return {
        plan: null,
        message: '客户需求里还没识别出城市。请让客户提到城市（例如「厦门」）。',
      };
    }

    return {
      plan: this.platformPlanner.plan(built.query),
      message: '已生成检索方案。可以把「检索式」粘进贝壳 App 搜索框。',
    };
  }

  // =========================================================================
  // 编排入口 —— 前端最主要调用的接口
  // =========================================================================

  /**
   * POST /customers/:id/wechat-assistant
   *
   * 一次完成：保存消息 → 识别需求 → 更新画像 → 搜贝壳 → 硬筛 → 打分
   *          → 补详情 → 生成微信文案 → 记录推荐批次
   *
   * 前端只需要这一个接口就能实现核心功能。
   * 返回的 steps 数组包含每一步的真实执行情况，用于显示真实进度。
   */
  @Post('wechat-assistant')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async runAssistant(
    @Param('customerId') customerId: string,
    @Body(ZodBody(assistantSchema)) body: AssistantInput,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    const startedAt = Date.now();

    try {
      const result = await this.orchestrator.run(user.organizationId, {
        customerId,
        agentId: user.id,
        message: body.message,
        recommendationCount: body.recommendationCount,
        replyStyle: body.replyStyle,
        portalUrl: body.portalUrl ?? null,
        // 区域筛选：经纪人界面选择，只作用于本次搜索，不写回客户画像
        cityOverride: body.cityOverride ?? null,
        districtOverride: body.districtOverride ?? null,
      });

      this.logger.log(
        `微信助手执行成功：客户 ${customerId}，推荐 ${result.recommendations.length} 套，` +
          `耗时 ${Date.now() - startedAt}ms`,
      );

      return result;
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  // =========================================================================
  // 分步接口
  // =========================================================================

  /**
   * POST /customers/:id/messages/import
   *
   * 仅保存粘贴的原始消息，不触发 AI。
   * 用途：经纪人想先存下来，稍后再分析；或网络不好时分步操作。
   */
  @Post('messages/import')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async importMessage(
    @Param('customerId') customerId: string,
    @Body(ZodBody(importMessageSchema)) body: ImportMessageInput,
    @CurrentUser() user: RequestUser,
  ): Promise<{ messageId: string; length: number; createdAt: Date }> {
    try {
      const saved = await this.messageImport.save(user.organizationId, {
        customerId,
        agentId: user.id,
        rawText: body.message,
        source: body.source,
        sourceType: body.sourceType,
      });

      return { messageId: saved.id, length: saved.rawText.length, createdAt: saved.createdAt };
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  /**
   * POST /customers/:id/requirements/analyze
   *
   * 仅做需求识别与画像合并，**不搜索房源**、**不生成文案**。
   *
   * 用途：
   *   - 贝壳暂时不可用时，先保存需求理解结果
   *   - 经纪人只想确认"AI 理解得对不对"
   */
  @Post('requirements/analyze')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async analyzeRequirement(
    @Param('customerId') customerId: string,
    @Body(ZodBody(analyzeSchema)) body: AnalyzeInput,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    try {
      // 取消息：优先用 messageId，否则现场保存一条
      let messageText = body.message ?? '';
      let messageId = body.messageId ?? null;

      if (!messageText && messageId) {
        const found = await this.messageImport.findById(user.organizationId, messageId);
        if (!found) throw new NotFoundError('消息', messageId);
        messageText = found.rawText;
      }

      if (!messageText) {
        throw new BusinessError(
          ApiErrorCode.MESSAGE_EMPTY,
          '请提供消息内容（message）或已保存的消息 ID（messageId）',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!messageId) {
        const saved = await this.messageImport.save(user.organizationId, {
          customerId,
          agentId: user.id,
          rawText: messageText,
        });
        messageId = saved.id;
      }

      const { profile: existing } = await this.profileService.get(user.organizationId, customerId);

      const extraction = await this.extractor.extract(messageText, {
        existingProfile:
          existing.sourceMessageCount > 0 ? buildProfileHint(existing) : null,
        /**
         * ⚠️ 不把画像城市当 hint（踩过的坑，与编排器同一问题）。
         *
         * `parseRequirementByRules` 里 hint.city 的优先级高于消息内容，
         * 且会被标成 `citySource: 'explicit'`。用画像城市做 hint 会导致
         * "客户说厦门、画像记着上海"时解析成上海 —— 客户原话被历史覆盖。
         *
         * 这里只做**无消息城市时的兜底**，不参与优先级竞争：
         * 传 null 让解析器从消息里认城市，认不出来由调用方决定怎么处理。
         */
        cityHint: null,
      });

      const mergeResult = this.merger.merge(existing, extraction.extraction);

      await this.profileService.save(user.organizationId, customerId, mergeResult.merged, {
        lastMessageId: messageId,
      });

      const snapshot = await this.snapshotService.save(user.organizationId, {
        customerId,
        profile: mergeResult.merged,
        changes: mergeResult.changes,
        previousProfile: existing.sourceMessageCount > 0 ? existing : null,
        hasOverride: mergeResult.hasOverride,
        needsConfirmation: mergeResult.needsConfirmation,
        sourceMessageId: messageId,
      });

      await this.messageImport.markParsed(user.organizationId, messageId, {
        extraction: extraction.extraction,
        source: extraction.source,
        model: extraction.model,
        durationMs: extraction.durationMs,
        snapshotId: snapshot?.id ?? null,
      });

      return {
        messageId,
        snapshotId: snapshot?.id ?? null,
        snapshotVersion: snapshot?.version ?? null,
        profile: mergeResult.merged,
        profileSummary: describeProfile(mergeResult.merged),
        changes: RequirementSnapshotService.describeChanges(mergeResult.changes),
        needsConfirmation: mergeResult.needsConfirmation,
        extractionSource: extraction.source,
        extractionConfidence: extraction.extraction.confidence,
        missingCriticalFields: extraction.extraction.missingCriticalFields,
      };
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  /**
   * POST /customers/:id/property-search
   *
   * 只搜索房源，返回**通过硬性过滤**的候选（不补详情、不生成文案）。
   * 用途：经纪人想先看看有哪些房源，再决定推荐哪几套。
   */
  @Post('property-search')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async searchProperties(
    @Param('customerId') customerId: string,
    @Body(ZodBody(searchSchema)) body: SearchInput,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    try {
      const { profile, exists } = await this.profileService.get(user.organizationId, customerId);

      if (!exists) {
        throw new BusinessError(
          ApiErrorCode.REQUIREMENT_PARSE_FAILED,
          '尚未识别到该客户的需求，请先粘贴客户微信消息并执行需求分析。',
          HttpStatus.PRECONDITION_FAILED,
        );
      }

      // 生成搜索条件（可选手动放宽 —— 需求 §44 要求必须由经纪人确认后才能放宽）
      const built = this.queryBuilder.build(profile);

      // 应用经纪人确认的放宽项
      if (body.relax) {
        if (body.relax.budgetMax !== undefined) built.query.budgetMax = body.relax.budgetMax;
        if (body.relax.bedrooms !== undefined) built.query.bedrooms = body.relax.bedrooms;
        if (body.relax.builtAfterYear !== undefined) {
          built.query.builtAfterYear = body.relax.builtAfterYear;
        }
        if (body.relax.areaMin !== undefined) built.query.areaMin = body.relax.areaMin;
        if (body.relax.areaMax !== undefined) built.query.areaMax = body.relax.areaMax;
        if (body.relax.ignoreSubDistricts) built.query.subDistricts = [];
      }

      if (!built.query.city) {
        throw new MissingLocationError();
      }

      const provider = new BeikePropertyProvider(this.beikeClient);

      const properties = await provider.searchForCustomer({
        city: built.query.city,
        districts: built.query.districts,
        bedrooms: built.query.bedrooms,
        ...(built.query.budgetMax !== null ? { budgetMax: built.query.budgetMax } : {}),
        ...(built.query.budgetMin !== null ? { budgetMin: built.query.budgetMin } : {}),
        keywords: undefined,
      });

      const filterResult = this.hardFilter.filter(properties, built.query);

      const scored = this.scoring.score(filterResult.passed, profile);

      return {
        searchQuery: {
          naturalQuery: built.query.naturalQuery,
          rationale: built.query.rationale,
          hardConditions: built.hardConditionSummary,
          softConditions: built.softConditionSummary,
          appliedRelaxations: body.relax ?? null,
        },
        stats: {
          returned: properties.length,
          passedHardFilter: filterResult.passed.length,
          rejectedByReason: filterResult.rejectionStats,
        },
        candidates: scored.slice(0, 20).map((item) => ({
          externalId: item.property.externalId,
          community: item.property.community,
          district: item.property.district,
          subDistrict: item.property.subDistrict,
          totalPrice: item.property.totalPrice,
          area: item.property.area,
          bedrooms: item.property.bedrooms,
          livingRooms: item.property.livingRooms,
          buildYear: item.property.buildYear,
          subwayDistance: item.property.subwayDistance,
          matchScore: item.matchScore,
          highlights: item.highlights,
          cautions: item.cautions,
        })),
        warnings: built.warnings,
      };
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  /**
   * POST /customers/:id/recommendations/generate
   *
   * 对已选定的房源生成微信文案（需求 §29：经纪人可以人工调整后再生成）。
   */
  @Post('recommendations/generate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER)
  async generateRecommendation(
    @Param('customerId') customerId: string,
    @Body(ZodBody(generateSchema)) body: GenerateInput,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    try {
      const batches = await this.recommendation.listByCustomer(
        user.organizationId,
        customerId,
        1,
      );

      const latest = batches[0];
      if (!latest) {
        throw new NotFoundError('推荐批次');
      }

      const { profile } = await this.profileService.get(user.organizationId, customerId);

      const scope = this.tenant.scopeFor(user.organizationId);
      const properties = await scope.findMany<Record<string, unknown>>('Property', {
        where: { id: { in: latest.recommendedPropertyIds } },
      });

      if (properties.length === 0) {
        throw new NotFoundError('推荐房源');
      }

      // 这里只做文案生成，因此用一个简化的映射（完整字段已在编排器里处理过）
      const reply = await this.replyGenerator.generate({
        customerName: '客户',
        agentName: '',
        profile,
        properties: properties.slice(0, body.recommendationCount).map((property) => ({
          property: property as never,
          matchScore: Number(property['matchScore'] ?? 0),
          highlights: [],
          cautions: [],
          priceChange: 0,
        })),
        style: body.replyStyle,
        portalUrl: body.portalUrl ?? null,
      });

      return {
        batchId: latest.id,
        content: reply.content,
        style: reply.style,
        aiGenerated: reply.aiGenerated,
        length: reply.length,
      };
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  // =========================================================================
  // 记录与查询
  // =========================================================================

  /** GET /customers/:id/messages —— 消息历史 */
  @Get('messages')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async listMessages(
    @Param('customerId') customerId: string,
    @Query(ZodQuery(listQuerySchema)) query: ListQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    const result = await this.messageImport.list(user.organizationId, customerId, {
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: result.items.map((item) => ({
        ...item,
        // 长文本在列表里截断，避免响应过大
        rawText: item.rawText.length > 500 ? `${item.rawText.slice(0, 500)}…` : item.rawText,
      })),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(result.total / query.pageSize),
    };
  }

  /** GET /customers/:id/requirement —— 当前需求画像 */
  @Get('requirement')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async getRequirement(
    @Param('customerId') customerId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    const { profile, exists } = await this.profileService.get(user.organizationId, customerId);

    return {
      exists,
      profile,
      summary: describeProfile(profile),
    };
  }

  /** GET /customers/:id/requirement-history —— 需求版本历史（需求 §9） */
  @Get('requirement-history')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async getRequirementHistory(
    @Param('customerId') customerId: string,
    @Query(ZodQuery(listQuerySchema)) query: ListQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    const snapshots = await this.snapshotService.list(
      user.organizationId,
      customerId,
      query.pageSize,
    );

    return {
      items: snapshots.map((snapshot) => ({
        id: snapshot.id,
        version: snapshot.version,
        changedFields: snapshot.changedFields,
        /**
         * ⚠️ 必须经 `describeChanges` 转换（踩过的真实 bug）。
         *
         * `snapshot.changeSummary` 里存的是 `RequirementChange[]`，
         * 字段名是 `previousDisplay` / `newDisplay`；
         * 而前端（`RequirementSnapshotItem`）读的是 `before` / `after`。
         *
         * 直接返回会让前端**拿到 undefined 并渲染空值** ——
         * 界面上"需求变化"一直显示空白，而且因为多条变更的
         * key 都变成 `districts-undefined`，触发 React 重复 key 报错
         * （非唯一 key 会导致子元素被重复或遗漏，属未定义行为）。
         *
         * `describeChanges` 正是为这个转换而存在的静态方法，之前漏调了。
         */
        changes: RequirementSnapshotService.describeChanges(
          (snapshot.changeSummary ?? []) as RequirementChange[],
        ),
        hasOverride: snapshot.hasOverride,
        needsConfirmation: snapshot.needsConfirmation,
        sourceMessageId: snapshot.sourceMessageId,
        createdAt: snapshot.createdAt,
      })),
      total: snapshots.length,
    };
  }

  /** GET /customers/:id/recommendations —— 推荐历史（需求 §35） */
  @Get('recommendations')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async listRecommendations(
    @Param('customerId') customerId: string,
    @Query(ZodQuery(listQuerySchema)) query: ListQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    const batches = await this.recommendation.listByCustomer(
      user.organizationId,
      customerId,
      query.pageSize,
    );

    return { items: batches, total: batches.length };
  }

  /** GET /ai/status —— AI 能力状态（前端据此提示"当前使用内置规则"） */
  @Get('assistant-capabilities')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async capabilities(): Promise<unknown> {
    // 贝壳数据源可用性：这里做一次**真实探测**，让界面能明确告诉经纪人
    // "是贝壳服务的问题，不需要你改配置"，避免用户反复检查自己的设置。
    let beikeProbe: {
      ok: boolean;
      failureKind: string;
      message: string;
      durationMs: number;
    } | null = null;

    try {
      const startedAt = Date.now();
      const result = await this.beikeClient.searchHouses({
        city: '上海',
        query: '房',
        houseType: 'second',
        // 探测用较少重试，避免用户等太久；真正查询时用默认的 5 次
      });
      const count = result.parsed.entities.filter((entity) => entity.kind === 'house').length;

      beikeProbe = {
        ok: true,
        failureKind: 'NONE',
        message: `贝壳数据服务正常（探测返回 ${count} 条）`,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isServiceIssue =
        error instanceof BeikeCliError && (error.isServiceBusy || error.isUnavailable);

      beikeProbe = {
        ok: false,
        failureKind: isServiceIssue ? 'SERVICE' : 'CONNECTION',
        message: isServiceIssue
          ? '贝壳数据服务暂时不可用（你的凭证与连接都正常，属于对方服务端问题）。稍后重试即可，不需要修改任何配置。'
          : `贝壳连接异常：${message}`,
        durationMs: 0,
      };
    }

    return {
      ai: this.ai.describeStatus(),
      beike: beikeProbe,
      notes: [
        '需求识别优先使用 AI，AI 不可用时自动降级到内置中文房产规则解析。',
        '贝壳数据来自官方开放平台，房源信息以实际带看为准。',
        '系统不会读取你的微信聊天记录 —— 所有消息都由你主动粘贴。',
      ],
    };
  }

  // =========================================================================
  // 错误转换
  // =========================================================================

  /**
   * 把业务错误转成合适的 HTTP 响应。
   *
   * 关键点：每种错误都给出**人能理解的中文**，并把可执行的下一步告诉用户。
   * 绝不把堆栈或技术细节暴露给经纪人（需求 §56）。
   */
  private toHttpError(error: unknown): Error {
    if (error instanceof BusinessError) return error;

    if (error instanceof CustomerNotFoundError) {
      return new NotFoundError('客户');
    }

    if (error instanceof EmptyMessageError) {
      return new BusinessError(
        ApiErrorCode.MESSAGE_EMPTY,
        error.message,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (error instanceof MissingLocationError) {
      return new BusinessError(
        ApiErrorCode.MISSING_LOCATION,
        error.message,
        HttpStatus.PRECONDITION_FAILED,
      );
    }

    // 贝壳暂时不可用 → 503，并明确告知"需求已保存，只需重试房源查询"
    if (error instanceof BeikeTemporarilyUnavailableError) {
      return new ServiceUnavailableError(error.message, ApiErrorCode.BEIKE_UNAVAILABLE);
    }

    // 零结果 → 200 之外的语义化错误：这是可预期的业务结果，不是故障
    if (error instanceof NoPropertiesFoundError) {
      return new BusinessError(
        ApiErrorCode.NO_PROPERTIES_FOUND,
        error.message,
        HttpStatus.UNPROCESSABLE_ENTITY,
        // 把放宽建议放进 details，前端可以直接渲染成按钮
        error.context.suggestions.map((suggestion) => ({
          field: suggestion.relaxField,
          message: `${suggestion.label}：${suggestion.description}`,
        })),
      );
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}
