/**
 * 微信房产助手编排器 —— 整条业务闭环的协调者。
 *
 * 这是项目**最核心的一个类**。它把下面这些独立服务串成一条完整链路：
 *
 *   保存消息 → 抽取需求 → 增量合并 → 生成快照 → 生成搜索条件
 *   → 调用贝壳搜索 → 硬性过滤 → 房源入库去重 → 匹配打分
 *   → 详情补全（只对 Top N） → 生成微信文案 → 记录推荐批次
 *
 * 设计原则：
 *
 * 1. **本类只做协调，不含业务规则。**
 *    过滤、打分、合并的全部逻辑都在各自的服务里，可以单独测试。
 *    这里如果堆积逻辑，会变成一个几百行、无法测试的"上帝类"（需求 §54 明确禁止）。
 *
 * 2. **每个阶段有明确的失败语义。**
 *    - 消息为空 → MESSAGE_EMPTY
 *    - AI 失败   → 降级到规则，不失败
 *    - 缺城市    → MISSING_LOCATION（不让 AI 猜）
 *    - 贝壳不可达 → BEIKE_UNAVAILABLE，但**需求已保存**，用户只需重试房源查询
 *    - 零结果    → NO_PROPERTIES_FOUND + 放宽建议
 *
 * 3. **贝壳失败不应让前面所有工作白费。**
 *    需求解析结果、快照、画像都已落库。用户点「重新查询房源」时
 *    直接复用已解析的需求，**不重新调用 AI**（需求 §43）——
 *    既省 Token，也避免两次解析结果不一致。
 *
 * 4. **进度是真实的。**
 *    返回的 steps 数组记录每一步的真实执行结果与耗时，
 *    前端据此显示进度，绝不编造"正在搜索"这种假状态（需求 §27）。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ApiErrorCode,
  ASSISTANT_STEP_LABELS,
  AssistantStep,
  PreferencePriority,
  PropertyProviderKind,
  RecommendationStatus,
  WeChatReplyStyle,
  type AssistantStepStatus,
  type NormalizedProperty,
  type RequirementChange,
  type ScoredPropertyMatch,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';
import { BeikePropertyProvider, BeikeCliError, BeikeNotConfiguredError } from '../property/providers/beike/beike-property.provider.js';
import { BeikeQuotaExceededError } from '../property/providers/beike/beike-rate-limiter.service.js';
import { BeikeMcpClient } from '../property/providers/beike/beike-mcp-client.js';
import { MessageImportService } from './message-import.service.js';
import { RequirementExtractorService, buildProfileHint } from './requirement-extractor.service.js';
import { sanitizeRegionsForCity } from './city-locations.js';
import { RequirementMergeService } from './requirement-merge.service.js';
import { RequirementProfileService } from './requirement-profile.service.js';
import { RequirementSnapshotService, describeProfile } from './requirement-snapshot.service.js';
import { PropertySearchQueryBuilder } from './property-search-query-builder.service.js';
import { RELIABILITY_TIERS } from '@estatepilot/types';
import { HardFilterService } from './hard-filter.service.js';
import { MatchScoringService } from './match-scoring.service.js';
import { PropertyUpsertService } from './property-upsert.service.js';
import { CachedPropertySearchService } from './cached-property-search.service.js';
import { PropertyReliabilityService } from '../property/reliability/property-reliability.service.js';
import type {
  PropertyFullDetail,
  PropertyImage,
} from '../property/providers/beike/beike-detail-parser.service.js';
import { BeikeDetailCache } from '../property/providers/beike/beike-detail-cache.service.js';
import { PropertyDetailStore } from './property-detail.store.js';
import { VERIFICATION_TTL, PropertySourceType } from '@estatepilot/types';
import { WeChatReplyGenerator } from './wechat-reply-generator.service.js';
import { RecommendationService } from './recommendation.service.js';
import type { MergedRequirementProfile } from '@estatepilot/types';

// ---------------------------------------------------------------------------
// 输入与输出
// ---------------------------------------------------------------------------

export interface RunAssistantInput {
  customerId: string;
  agentId: string;
  /**
   * 经纪人姓名，用于生成文案里的自我介绍。
   * 不传时编排器会自己去数据库取 —— 这比依赖前端传参更可靠，
   * 也避免前端为了显示一个称呼而多查一次用户信息。
   */
  agentName?: string;
  /** 经纪人从微信复制粘贴的消息原文 */
  message: string;
  /** 推荐房源数量（默认 5，前端可选 3/5/8） */
  recommendationCount?: number;
  /** 文案风格 */
  replyStyle?: WeChatReplyStyle;
  /** 客户专属看房链接 */
  portalUrl?: string | null;
  /** 是否强制禁用 AI（用于对比测试） */
  skipAi?: boolean;
  /**
   * 城市筛选（经纪人界面选择）。
   *
   * 语义：**本次搜索只看这个城市**，优先级高于客户画像与客户资料里的城市。
   * 不写回客户画像 —— 筛选器是"这次想看哪里"，不是"客户要什么"。
   */
  cityOverride?: string | null;
  /**
   * 区域筛选（经纪人界面选择的行政区）。
   *
   * 语义：**本次搜索只看这些区**。空数组或未传 = 不限区域（该城市全部）。
   * 同样不写回客户画像。
   */
  districtOverride?: string[] | null;
}

/** 推荐房源（返回给前端的完整信息） */
export interface RecommendedPropertyDto {
  propertyId: string;
  externalId: string;
  matchScore: number;
  /** 房源基本信息 */
  community: string;
  /**
   * 城市。
   *
   * 前端加载"按需详情"时必须带上它 —— 贝壳的 `entity_detail`
   * 要求 `city_name` 必填，缺了会返回参数校验错误。
   * 让前端从列表直接拿，比再查一次画像更可靠（画像可能已变）。
   */
  city: string;
  district: string;
  subDistrict: string | null;
  title: string;
  totalPrice: number;
  unitPrice: number;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: number;
  floor: number | null;
  totalFloors: number | null;
  buildYear: number | null;
  decoration: string | null;
  orientation: string | null;
  /** 交通（可能为空 —— 为空时前端必须显示"暂无数据"而不是编造） */
  subwayDistance: number | null;
  subwayText: string | null;
  /** 学区（可能为空） */
  schoolText: string | null;
  /** 图片 */
  images: string[];
  coverImage: string | null;
  tags: string[];
  listingStatus: string;
  /** 打分明细 */
  breakdown: Array<{ key: string; label: string; score: number; maxScore: number; detail: string }>;
  highlights: string[];
  cautions: string[];
  explanation: string | null;
  /** 是否曾经推荐过 */
  previouslyRecommended: boolean;
  /** 价格变化（负数表示降价） */
  priceChange: number;
  /** 来源标注 —— 让经纪人清楚数据来自哪里 */
  source: string;

  // ---- 数据可信度（Phase 12，需求 §4/§5/§6）----
  //
  // 这一组字段与 matchScore **完全独立**，不参与需求匹配计算。
  // 需求 §5 明确要求：不要让来源名称影响评分，只影响真实性权重。
  // 因此前端展示时应把「匹配度」与「可信度」分成两块，不能混成一个数。

  /** 数据可信度评分 0~100 */
  dataReliabilityScore: number;
  /** 星级 0~5（界面用） */
  reliabilityStars: number;
  /** 核验状态：VERIFIED 可发 / PENDING 需确认 / EXPIRED 已过期需重新确认 */
  verificationStatus: 'VERIFIED' | 'PENDING' | 'EXPIRED';
  /** 给经纪人看的可信度说明（必须诚实，不隐藏风险） */
  reliabilityNote: string;
  /** 最后核验时间（ISO 字符串，无则 null） */
  lastVerifiedAt: string | null;
  /** 时效性得分 0~100 */
  freshnessScore: number;
  /** 综合排序分 = 匹配度×0.7 + 可信度×0.2 + 时效性×0.1 */
  finalScore: number;

  // ---- 完整详情（Phase 15）----
  //
  // 让经纪人**不用再回贝壳 App 翻**就能向客户介绍房源。
  // 全部字段来自贝壳官方 `entity_detail` / `entity_material`，
  // 我们不加工、不推测 —— 拿不到就是 null，界面显示"暂无数据"。

  /**
   * 完整详情（基础信息 + 小区 + 周边配套）。
   *
   * 为 null 表示详情补全未成功（如贝壳限流、缓存降级），
   * 此时界面只展示摘要字段，不假装有详情。
   */
  fullDetail: PropertyFullDetail | null;

  /**
   * 房源图片（房间实景图 + 户型图 + VR 封面），已按 URL 去重。
   *
   * 与旧的 `images: string[]` 的区别：这里带**房间名**与**类型**，
   * 界面可以按"客厅/卧室/厨房"分组展示，而不是一堆无序图片。
   */
  imageDetails: PropertyImage[];

  /**
   * VR 看房跳转地址（贝壳 App scheme，形如 `lianjiabeike://...`）。
   *
   * ⚠️ 这是**手机 App 专用**协议，PC 浏览器打不开。
   * 界面应提示"手机打开"而不是给一个点了没反应的链接。
   */
  vrUrl: string | null;
}

/** 编排结果 */
export interface RunAssistantResult {
  /** 消息记录 ID（原文已落库） */
  messageId: string;
  /** 需求快照 ID（有新变化时有值） */
  snapshotId: string | null;
  /** 快照版本号 */
  snapshotVersion: number | null;
  /** 合并后的画像 */
  profile: MergedRequirementProfile;
  /** 画像的中文描述 */
  profileSummary: string;
  /** 本次识别到的需求变化 */
  changes: Array<{
    field: string;
    label: string;
    before: string;
    after: string;
    type: string;
    isOverride: boolean;
  }>;
  /** 是否需要经纪人确认（冲突或低置信度） */
  needsConfirmation: boolean;
  /** 需求理解的来源：AI 还是规则 */
  extractionSource: 'AI' | 'RULES';
  /** 抽取置信度 */
  extractionConfidence: number;
  /** 缺失的关键字段 */
  missingCriticalFields: string[];
  /** 使用的搜索条件（让经纪人知道系统按什么搜的） */
  searchQuery: {
    naturalQuery: string;
    rationale: string;
    hardConditions: string[];
    softConditions: string[];
  };
  /** 贝壳检索统计 */
  beikeStats: {
    totalRecalled: number | null;
    returned: number;
    passedHardFilter: number;
    rejectedByReason: Record<string, number>;
  };
  /**
   * 房源数据来源。
   *
   * LIVE        = 实时调用贝壳开放平台
   * LOCAL_CACHE = 贝壳不可用，改用本地已同步的真实房源
   *
   * 界面必须把这个标记显示出来（并在缓存模式下给出同步时间），
   * 否则经纪人可能误以为是实时数据，向客户承诺"这套还在卖"。
   */
  dataSource: 'LIVE' | 'LOCAL_CACHE';
  /** 缓存模式下的数据来源说明，如「本地缓存房源（41 套） · 3 小时前同步」 */
  cacheNote: string | null;
  /** 推荐房源 */
  recommendations: RecommendedPropertyDto[];
  /** 生成的微信文案 */
  reply: {
    replyId: string;
    content: string;
    style: string;
    aiGenerated: boolean;
    length: number;
  };
  /** 推荐批次 ID */
  batchId: string;
  /** 零结果时的放宽建议（需求 §44） */
  zeroResultSuggestions: Array<{
    label: string;
    description: string;
    relaxField: string;
    suggestedValue: string;
  }>;
  /** 真实执行步骤（前端据此显示进度，禁止假 loading） */
  steps: AssistantStepStatus[];
  /** 总耗时 */
  durationMs: number;
  /** 警告信息（如贝壳部分数据缺失） */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 缺少城市 */
export class MissingLocationError extends Error {
  readonly errorCode = ApiErrorCode.MISSING_LOCATION;

  constructor() {
    super(
      '客户需求中缺少城市信息，无法搜索房源。' +
        '请在客户资料中补充城市，或在粘贴的消息中体现（例如"上海浦东"）。',
    );
    this.name = 'MissingLocationError';
  }
}

/** 贝壳暂时不可用 —— 注意：需求已保存，用户只需重试房源查询 */
export class BeikeTemporarilyUnavailableError extends Error {
  readonly errorCode = ApiErrorCode.BEIKE_UNAVAILABLE;

  constructor(
    message: string,
    readonly context: {
      messageId: string;
      snapshotId: string | null;
      profileSummary: string;
      changes: RequirementChange[];
      searchQuery: { naturalQuery: string; rationale: string };
    },
  ) {
    super(message);
    this.name = 'BeikeTemporarilyUnavailableError';
  }
}

/** 零结果 */
export class NoPropertiesFoundError extends Error {
  readonly errorCode = ApiErrorCode.NO_PROPERTIES_FOUND;

  constructor(
    readonly context: {
      messageId: string;
      snapshotId: string | null;
      profileSummary: string;
      rejectedByReason: Record<string, number>;
      suggestions: Array<{
        label: string;
        description: string;
        relaxField: string;
        suggestedValue: string;
      }>;
      totalRecalled: number | null;
    },
  ) {
    super(
      context.totalRecalled !== null && context.totalRecalled > 0
        ? `贝壳找到 ${context.totalRecalled} 套房源，但没有一套满足您的硬性条件。请参考建议适当放宽条件。`
        : '贝壳没有找到符合条件的在售房源，请尝试调整搜索条件。',
    );
    this.name = 'NoPropertiesFoundError';
  }
}

@Injectable()
export class WeChatPropertyAssistantOrchestrator {
  private readonly logger = new Logger(WeChatPropertyAssistantOrchestrator.name);

  /** 详情补全的并发上限（需求 §67：不能无限 Promise.all） */
  private readonly detailConcurrency = 4;

  constructor(
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
    private readonly propertyUpsert: PropertyUpsertService,
    private readonly cachedSearch: CachedPropertySearchService,
    private readonly replyGenerator: WeChatReplyGenerator,
    private readonly recommendation: RecommendationService,
    /** Phase 12：可信度评估（与 matchScore 分离，不参与需求匹配计算） */
    private readonly reliability: PropertyReliabilityService,
    /**
     * 详情缓存。
     *
     * 避免同一房源在多次搜索中反复请求（实测这是触发贝壳限流的主因之一）。
     */
    private readonly detailCache: BeikeDetailCache,
    /**
     * 详情持久化。
     *
     * 详情要落库：限流恢复需 20 分钟以上、重启会清空内存缓存，
     * 只放内存的话限流期间界面只能显示"暂无详情"。
     */
    private readonly detailStore: PropertyDetailStore,
  ) {}

  /**
   * 执行完整闭环。
   *
   * 这是「粘贴微信 → 得到推荐」的一站式入口。
   */
  async run(organizationId: string, input: RunAssistantInput): Promise<RunAssistantResult> {
    const startedAt = Date.now();
    const steps: AssistantStepStatus[] = [];
    const warnings: string[] = [];

    const recommendationCount = Math.min(8, Math.max(1, input.recommendationCount ?? 5));
    const replyStyle = input.replyStyle ?? WeChatReplyStyle.NATURAL_PROFESSIONAL;

    /** 记录一步的执行情况 */
    const track = <T>(
      step: AssistantStep,
      detail: string | null,
      durationMs: number | null,
      status: AssistantStepStatus['status'] = 'SUCCESS',
    ): void => {
      steps.push({
        step,
        label: ASSISTANT_STEP_LABELS[step],
        status,
        detail,
        durationMs,
      });
    };

    // =====================================================================
    // 0. 校验客户存在
    // =====================================================================
    const scope = this.tenant.scopeFor(organizationId);
    const customer = await scope.findFirst<{
      id: string;
      name: string;
      gender: string;
      preferredCity: string | null;
      preferredDistricts: string[];
      budgetMin: number | null;
      budgetMax: number | null;
      bedrooms: number[];
    }>('Customer', {
      where: { id: input.customerId, deletedAt: null },
      select: {
        id: true,
        name: true,
        gender: true,
        // 注意字段名：Customer 表用的是 preferredCity，不是 city
        preferredCity: true,
        preferredDistricts: true,
        budgetMin: true,
        budgetMax: true,
        bedrooms: true,
      },
    });

    if (!customer) {
      throw new CustomerNotFoundError(input.customerId);
    }

    // 经纪人姓名：优先用调用方传入的，否则从数据库取
    let agentName = input.agentName ?? '';
    if (!agentName) {
      const agent = await scope.findFirst<{ name: string }>('User', {
        where: { id: input.agentId },
        select: { name: true },
      });
      agentName = agent?.name ?? '您的经纪人';
    }

    // =====================================================================
    // 1. 保存消息（最先做 —— 保证原文永不丢失）
    // =====================================================================
    const stepStart1 = Date.now();
    const message = await this.messageImport.save(organizationId, {
      customerId: input.customerId,
      agentId: input.agentId,
      rawText: input.message,
    });
    track(
      AssistantStep.SAVING_MESSAGE,
      `已保存 ${message.rawText.length} 字（原文已落库，后续步骤失败也不会丢失）`,
      Date.now() - stepStart1,
    );

    // =====================================================================
    // 2. 读取已有画像
    // =====================================================================
    const { profile: existingProfile } = await this.profileService.get(
      organizationId,
      input.customerId,
    );

    /**
     * 城市提示的优先级（Phase 14 区域筛选）。
     *
     * 顺序见下方 §3 抽取完成后的赋值 —— 因为"客户本次明说的城市"
     * 必须等抽取结果出来才知道，所以这里先只定下前两层与兜底层。
     *
     * ⚠️ 踩过的坑：
     *   第一版写成 `cityOverride ?? existingProfile.city ?? customer.preferredCity`，
     *   而 `Customer.preferredCity` 在 schema 里的默认值是 **"上海"** ——
     *   于是新建客户（还没聊过）说"想看厦门思明区三房"时，
     *   cityHint 是"上海"，**客户明说的厦门被一个默认值压掉了**，
     *   结果是"上海 + 思明区"这种自相矛盾的条件，房源必然为 0。
     *
     *   正确顺序（越靠上越权威）：
     *     1. **经纪人显式选择的城市** —— 界面上选了就是明确意图
     *     2. **客户本次消息里明说的城市** —— 客户原话永远比历史推断可信
     *     3. **已有画像里的城市** —— 之前对话确认过的
     *     4. **客户资料里的城市** —— 建档时填的（可能是默认值，最不可信）
     */
    const cityFallback = existingProfile.city ?? customer.preferredCity ?? null;

    // 区域覆盖：仅当经纪人**明确选了区**时才限制。
    // 选了"全部区域"时不限制 —— 否则会把客户本来能接受的区也过滤掉。
    const districtOverride =
      input.districtOverride && input.districtOverride.length > 0
        ? input.districtOverride
        : null;

    // =====================================================================
    // 3. 抽取需求
    // =====================================================================
    const stepStart3 = Date.now();

    /**
     * ⚠️ 刻意**不传 cityHint**（踩过的坑）。
     *
     * `parseRequirementByRules` 里 `hint.city` 的优先级**高于消息内容**，
     * 且会被标记为 `citySource: 'explicit'`。所以只要传了 hint：
     *   - 客户说"想看厦门思明区三房"，hint 是"上海"（客户资料默认值）
     *   - 结果 city = 上海、citySource = 'explicit'
     *   - **客户明说的厦门被一个默认值彻底压掉**
     *
     * 不传 hint，规则解析器就会老老实实从消息里认城市；
     * 认不出来时（返回 null）我们在下面用画像/资料兜底。
     * 这样"客户现在说的"天然优先于"系统以前记的"。
     */
    const extraction = await this.extractor.extract(message.rawText, {
      customerName: customer.name,
      existingProfile:
        existingProfile.sourceMessageCount > 0 ? buildProfileHint(existingProfile) : null,
      cityHint: null,
    });

    /**
     * 确定最终生效的城市（越靠上越权威）：
     *   1. **经纪人显式选择的城市** —— 界面上选了就是明确意图
     *   2. **客户本次消息里明说的城市** —— 客户原话永远比历史推断可信
     *   3. 已有画像 / 客户资料 —— 兜底
     */
    const explicitCityFromMessage =
      extraction.extraction.citySource === 'explicit' ? extraction.extraction.city : null;

    const cityHint = input.cityOverride ?? explicitCityFromMessage ?? cityFallback;

    track(
      AssistantStep.EXTRACTING_REQUIREMENT,
      `${extraction.source === 'AI' ? 'AI' : '内置规则'}识别，置信度 ${Math.round(
        extraction.extraction.confidence * 100,
      )}%${extraction.extraction.summary ? ` —— ${extraction.extraction.summary}` : ''}`,
      Date.now() - stepStart3,
    );

    if (extraction.degraded && extraction.degradedReason) {
      warnings.push(extraction.degradedReason);
    }

    // 城市是推断出来的 → 必须明确告知经纪人，让他有机会纠正
    // （客户只说"浦东"时系统按"浦东唯一属于上海"补全，这不是猜测，但也不是客户原话）
    if (
      extraction.extraction.citySource === 'inferred' &&
      extraction.extraction.cityInferredFrom
    ) {
      warnings.push(
        `客户未直接说明城市，系统按「${extraction.extraction.cityInferredFrom}」推断为` +
          `${extraction.extraction.city}。如果不是这个城市，请在客户资料中修正后重新查询。`,
      );
    }

    // =====================================================================
    // 4. 增量合并需求（新消息是证据，不覆盖旧画像）
    // =====================================================================
    const stepStart4 = Date.now();
    const mergeResult = this.merger.merge(existingProfile, extraction.extraction);

    track(
      AssistantStep.MERGING_PROFILE,
      mergeResult.changes.length > 0
        ? `识别到 ${mergeResult.changes.length} 项变化` +
            `${mergeResult.hasOverride ? `（含 ${mergeResult.changes.filter((c) => c.isOverride).length} 项改口）` : ''}`
        : '需求无变化（已与历史画像合并）',
      Date.now() - stepStart4,
    );

    // =====================================================================
    // 5. 保存画像与快照
    // =====================================================================
    const stepStart5 = Date.now();
    await this.profileService.save(organizationId, input.customerId, mergeResult.merged, {
      lastMessageId: message.id,
    });

    const snapshot = await this.snapshotService.save(organizationId, {
      customerId: input.customerId,
      profile: mergeResult.merged,
      changes: mergeResult.changes,
      previousProfile: existingProfile.sourceMessageCount > 0 ? existingProfile : null,
      hasOverride: mergeResult.hasOverride,
      needsConfirmation: mergeResult.needsConfirmation,
      sourceMessageId: message.id,
    });

    await this.messageImport.markParsed(organizationId, message.id, {
      extraction: extraction.extraction,
      source: extraction.source,
      model: extraction.model,
      durationMs: extraction.durationMs,
      snapshotId: snapshot?.id ?? null,
    });

    track(
      AssistantStep.MERGING_PROFILE,
      snapshot
        ? `已更新画像到 v${snapshot.version}`
        : '画像已保存（无新变化，未生成新版本）',
      Date.now() - stepStart5,
    );

    // =====================================================================
    // 6. 生成搜索条件
    // =====================================================================
    //
    // 区域筛选的作用范围（重要）：
    //   经纪人在界面上选的区域是**本次搜索的临时筛选**，
    //   因此只作用于搜索条件，**不写回客户画像**。
    //
    //   为什么不写回：客户画像记录的是"客户的真实需求"，
    //   而筛选器是"经纪人这次想看哪里"。两者语义不同 ——
    //   把筛选写进画像会让一次临时筛选永久改变客户档案，
    //   下次不带筛选时结果就错了。
    //
    // ⚠️ 踩过的坑（实测定位，两个 bug）：
    //
    //   1) 只覆盖 city 不够。画像里的 districts 可能来自**别的城市**
    //      （客户先聊厦门、后聊上海 → 画像里同时有"浦东新区"和"思明区"）。
    //      选了"上海"却不选具体区时，厦门的区名仍参与硬筛 → 上海房源被筛光。
    //
    //   2) **只清洗 districts 仍然不够**。板块同样会串：画像里留着厦门的
    //      "软件园"，而上海房源没有任何一套的 subDistrict 叫"软件园"，
    //      这条条件把全部候选筛空 —— 日志表现为"匹配 0 套（缓存共 41 套）"。
    //
    //   因此这里对**行政区与板块一起清洗**。cityHint 是本次生效的权威城市
    //   （优先级：经纪人选择 > 画像 > 客户资料）。
    const sanitized = districtOverride
      ? {
          districts: districtOverride,
          // 经纪人指定了具体区时，板块条件没有意义（通常与其不匹配），清掉更安全
          subDistricts: [],
        }
      : sanitizeRegionsForCity(
          {
            districts: mergeResult.merged.districts,
            subDistricts: mergeResult.merged.subDistricts,
          },
          cityHint,
        );

    const searchProfile = {
      ...mergeResult.merged,
      /**
       * ⚠️ 城市也必须覆盖（踩过的坑）。
       *
       * 第一版只把 cityOverride 用在 cityHint（需求抽取的提示），
       * 忘了覆盖 searchProfile.city —— 而查询构造器读的是 searchProfile。
       * 结果：经纪人在界面上选了"上海"，界面上显示了筛选标签，
       * 但实际搜索条件仍是画像里的"厦门"，推荐结果与选择完全不符。
       *
       * 教训：**"提示"与"生效值"是两回事**。
       * 凡是读取配置生成查询的地方，都要用同一个权威值。
       */
      city: cityHint ?? mergeResult.merged.city,
      districts: sanitized.districts,
      subDistricts: sanitized.subDistricts,
    };

    const built = this.queryBuilder.build(searchProfile);

    // 城市缺失 → 明确报错，绝不让 AI 猜（需求 §12）
    if (!built.query.city) {
      await this.messageImport.markFailed(
        organizationId,
        message.id,
        '缺少城市信息，无法搜索房源',
      );
      throw new MissingLocationError();
    }

    // 区域筛选生效时，把"按哪个区域搜的"记进搜索步骤，
    // 这样经纪人在步骤条里能直接看到系统确实按他选的区域搜了。
    // （不新增枚举值：AssistantStep 有 Record<AssistantStep, string> 的标签映射，
    //   加值会连带改多处，收益不值当。）
    const regionFilterLabel =
      input.cityOverride || districtOverride
        ? `已按选定区域筛选：${built.query.city}` +
          `${districtOverride ? ` · ${districtOverride.join('、')}` : '（全部区域）'}`
        : null;

    // =====================================================================
    // 7. 调用贝壳搜索真实房源
    // =====================================================================
    const stepStart7 = Date.now();
    const provider = new BeikePropertyProvider(this.beikeClient);

    /** 一次搜索的结果 */
    interface SearchAttempt {
      query: string;
      /** 本次使用的搜索条件（回退时会被放宽） */
      searchQuery: typeof built.query;
      candidates: NormalizedProperty[];
      totalRecalled: number | null;
      filterResult: ReturnType<HardFilterService['filter']>;
      /** 是否放宽了位置条件 */
      relaxed: boolean;
    }

    /**
     * 执行一次「搜索 + 硬筛」。
     *
     * 抽成函数是因为下面要做**搜索策略回退**：贝壳单次只返回约 10 条，
     * 如果这 10 条恰好都不在客户要的板块（例如"张江"），硬筛后就是 0 条 ——
     * 但整个行政区（浦东新区）其实有几千套。这时应当自动降一级重搜，
     * 而不是告诉客户"没有房源"。
     */
    const attemptSearch = async (
      searchQuery: typeof built.query,
      options: { relaxed: boolean },
    ): Promise<SearchAttempt> => {
      const searchResult = await this.beikeClient.searchHouses({
        city: searchQuery.city,
        query: searchQuery.naturalQuery,
        houseType: 'second',
      });

      const entities = searchResult.parsed.entities.filter((entity) => entity.kind === 'house');
      const candidates = await provider.mapEntitiesForReuse(entities, searchQuery.city);
      const filterResult = this.hardFilter.filter(candidates, searchQuery);

      return {
        query: searchQuery.naturalQuery,
        searchQuery,
        candidates,
        totalRecalled: searchResult.parsed.overview.totalRecalled,
        filterResult,
        relaxed: options.relaxed,
      };
    };

    let attempt: SearchAttempt;

    /**
     * 是否使用了本地缓存房源。
     *
     * 这个标记必须一路传到返回结果里，让界面明确标注
     * "本地缓存 · N 小时前同步" —— 绝不能让经纪人误以为是实时房源
     * 而向客户承诺"这套还在卖"。
     */
    let usedLocalCache = false;
    /** 缓存数据来源说明（直接展示给用户） */
    let cacheSourceNote: string | null = null;

    /**
     * 降级到本地缓存的原因（跨步骤复用）。
     *
     * 为什么提升到函数作用域：搜索步骤与详情步骤都要用它，
     * 且文案必须**区分"贝壳故障"与"我们主动停手"** ——
     * 预算护栏拦截时贝壳其实是好的，说"贝壳不可用"会误导经纪人。
     */
    let cacheFallbackReason: string | null = null;

    try {
      attempt = await attemptSearch(built.query, { relaxed: false });

      // ---- 搜索策略回退（只在位置条件过窄导致零结果时触发）----
      const hasNarrowLocation =
        built.query.subDistricts.length > 0 || built.query.districts.length > 0;
      const zeroAfterFilter = attempt.filterResult.passed.length === 0;
      const locationIsBlamed =
        (attempt.filterResult.rejectionStats['位置不符'] ?? 0) > 0 ||
        attempt.filterResult.rejectionStats['其他'] === attempt.candidates.length;

      if (zeroAfterFilter && hasNarrowLocation && locationIsBlamed && attempt.candidates.length > 0) {
        // 逐级放宽：先去掉板块（保留行政区），仍为 0 则去掉行政区
        const relaxLevels: Array<{ label: string; apply: (q: typeof built.query) => void }> = [
          {
            label: '扩大到整个行政区',
            apply: (q) => {
              q.subDistricts = [];
              q.naturalQuery = this.queryBuilder.rebuildNaturalQuery(q);
            },
          },
          {
            label: '取消区域限制',
            apply: (q) => {
              q.subDistricts = [];
              q.districts = [];
              q.naturalQuery = this.queryBuilder.rebuildNaturalQuery(q);
            },
          },
        ];

        for (const level of relaxLevels) {
          // 每次都从原始条件复制一份，避免叠加放宽
          const relaxedQuery = {
            ...built.query,
            districts: [...built.query.districts],
            subDistricts: [...built.query.subDistricts],
            bedrooms: [...built.query.bedrooms],
          };
          level.apply(relaxedQuery);

          const relaxedAttempt = await attemptSearch(relaxedQuery, { relaxed: true });

          if (relaxedAttempt.filterResult.passed.length > 0) {
            this.logger.log(
              `位置条件过窄导致零结果，已自动${level.label}：` +
                `「${built.query.naturalQuery}」→「${relaxedQuery.naturalQuery}」，` +
                `通过 ${relaxedAttempt.filterResult.passed.length} 套`,
            );

            warnings.push(
              `按「${[...built.query.subDistricts, ...built.query.districts].join('、')}」` +
                `没有找到符合其他条件的房源，已自动${level.label}。` +
                `如果想严格限定在该区域，可以放宽其他条件（如预算）后重试。`,
            );

            attempt = relaxedAttempt;
            break;
          }
        }
      }

      track(
        AssistantStep.SEARCHING_BEIJE,
        (attempt.totalRecalled !== null
          ? `贝壳召回 ${attempt.totalRecalled} 套，本次返回 ${attempt.candidates.length} 套` +
            `${attempt.relaxed ? '（已放宽区域以找到结果）' : ''}`
          : `贝壳返回 ${attempt.candidates.length} 套候选`) +
          (regionFilterLabel ? `｜${regionFilterLabel}` : ''),
        Date.now() - stepStart7,
      );
    } catch (error) {
      // 需求已保存，但贝壳搜不了。
      //
      // 关键决策：**不要立刻失败**。贝壳的 MCP 服务会整体不可用
      // （实测所有数据查询工具同时返回 service temporarily unavailable，
      //  而 CLI 诊断显示连接与凭证都正常）。
      // 这时如果直接报错，产品就完全不可用 —— 而经纪人此刻可能正在跟客户对话。
      //
      // 因此降级到**本地已入库的真实房源**（此前每次成功调用都落了库），
      // 并明确标注数据来源与同步时间。
      const reason = this.describeBeikeError(error);

      /**
       * 记录降级原因到函数作用域。
       *
       * 为什么需要：`reason` 是 catch 块内的局部变量，但后面
       * "详情补全"步骤也要用它来生成**准确的**文案 ——
       * 必须区分"贝壳坏了"与"我们主动停手（预算护栏）"。
       */
      cacheFallbackReason = reason;
      this.logger.warn(`贝壳搜索失败，尝试本地缓存降级：${reason}`);

      const fallback = await this.cachedSearch.search(organizationId, built.query);

      if (fallback.properties.length > 0) {
        // 对缓存房源同样执行硬筛，保持与实时路径完全一致的过滤语义
        const cachedFilterResult = this.hardFilter.filter(fallback.properties, built.query);

        /**
         * 注：历史详情的读回在详情补全阶段统一处理（见下方 fullDetails 构造），
         * 这里不再重复读库 —— 重复实现会让两处逻辑随时间漂移。
         */
        void cachedFilterResult;

        attempt = {
          query: `${built.query.naturalQuery}（本地缓存）`,
          searchQuery: built.query,
          candidates: fallback.properties,
          totalRecalled: fallback.matched,
          filterResult: cachedFilterResult,
          relaxed: false,
        };

        usedLocalCache = true;
        cacheSourceNote = fallback.sourceNote;

        track(
          AssistantStep.SEARCHING_BEIJE,
          /**
           * 文案必须区分**"贝壳坏了"**与**"我们主动停手"**（踩过的真实问题）。
           *
           * 预算护栏拦截时，贝壳其实是好的 —— 是我们为了保护配额
           * 主动停止实时查询。若这里统一说"贝壳暂时不可用"，
           * 会让经纪人误以为数据源故障，甚至去联系贝壳，
           * 而真实原因是我们自己的限流保护。
           *
           * `reason` 由 describeBeikeError 生成，已经区分了：
           *   · 预算超限 → "本小时已调用 N 次（上限 M 次）…"
           *   · 限流冷却 → "贝壳已限流，正在冷却…"
           *   · 手动停用 → "实时调用已被手动停用…"
           *   · 真实故障 → "贝壳房源服务临时繁忙…"
           */
          `${reason}｜已改用本地缓存房源（匹配 ${fallback.matched} 套，${fallback.sourceNote}）` +
            (regionFilterLabel ? `｜${regionFilterLabel}` : ''),
          Date.now() - stepStart7,
          'SUCCESS',
        );

        warnings.push(
          `贝壳房源服务当前不可用，本次改用本地已同步的真实房源（${fallback.sourceNote}）。` +
            `房源信息不是实时的，发送给客户前请确认房源是否仍在售。`,
        );
      } else {
        // 本地也没有缓存 → 只能明确失败（此时确实无能为力）
        track(AssistantStep.SEARCHING_BEIJE, reason, Date.now() - stepStart7, 'FAILED');

        this.logger.error(`贝壳搜索失败且本地无缓存房源：${reason}`);

        /**
         * ⚠️ 错误提示必须区分**两种完全不同的原因**（踩过的真实问题）。
         *
         * 原来只有一句笼统的话：
         *   "贝壳房源暂时无法查询，且本地没有可用的缓存房源"
         *
         * 但实际情况可能是：
         *   A. 贝壳真的挂了 / 被限流熔断
         *   B. 贝壳是好的，只是**这个区域**本地没缓存
         *      （客户搜"厦门湖里区"，而缓存里只有集美/海沧/同安/翔安）
         *
         * 两种情况的处理方式完全不同：
         *   A → 等 1-2 分钟重试
         *   B → 重试也没用，应该换区域或等贝壳恢复后实时查询
         *
         * 混成一句话会让经纪人**反复重试一个永远不会成功的查询**。
         */
        const isCircuitOpen = /熔断|circuit/i.test(reason);
        const cachedElsewhere = fallback.totalCached > 0;

        const hint = cachedElsewhere
          ? `本地有 ${fallback.totalCached} 套房源，但都不在本次搜索的区域` +
            `（${built.query.districts.join('、') || '未指定区域'}）。` +
            `可以换个区域试试，或等贝壳恢复后实时查询。`
          : isCircuitOpen
            ? '贝壳服务当前被限流保护（短时间内调用过多）。请等 1-2 分钟后再试。'
            : '请稍后点击「重新查询房源」，无需重新分析需求。';

        throw new BeikeTemporarilyUnavailableError(
          `客户需求已识别并保存，但这次没能查到房源。${hint}`,
          {
            messageId: message.id,
            snapshotId: snapshot?.id ?? null,
            profileSummary: describeProfile(mergeResult.merged),
            changes: mergeResult.changes,
            searchQuery: {
              naturalQuery: built.query.naturalQuery,
              rationale: built.query.rationale,
            },
          },
        );
      }
    }

    // ---- 两条路径都汇合到这里：贝壳实时结果 或 本地缓存结果 ----
    const candidates = attempt.candidates;
    const totalRecalled = attempt.totalRecalled;
    const filterResult = attempt.filterResult;

    track(
      AssistantStep.HARD_FILTERING,
      `候选 ${candidates.length} 套 → 通过 ${filterResult.passed.length} 套` +
        (Object.keys(filterResult.rejectionStats).length > 0
          ? `（排除：${Object.entries(filterResult.rejectionStats)
              .map(([key, count]) => `${key} ${count}`)
              .join('，')}）`
          : '') +
        (usedLocalCache ? '（本地缓存数据）' : ''),
      null,
    );

    // 零结果 → 分析原因并给建议，但不自动放宽（需求 §44）
    if (filterResult.passed.length === 0) {
      const analysis = this.hardFilter.analyzeZeroResult(
        filterResult.rejected.map((item) => ({
          property: item.property,
          reason: item.reason,
        })),
        built.query,
      );

      throw new NoPropertiesFoundError({
        messageId: message.id,
        snapshotId: snapshot?.id ?? null,
        profileSummary: describeProfile(mergeResult.merged),
        rejectedByReason: filterResult.rejectionStats,
        suggestions: analysis.suggestions,
        totalRecalled,
      });
    }

    // =====================================================================
    // 9. 房源入库去重（provider + externalId 唯一）
    // =====================================================================
    //
    // Phase 12：同时写入**数据可信度**。
    // 判定来源分两种情况：
    //   - 实时路径：数据来自贝壳官方 API → 可信度 100
    //   - 降级路径：数据来自本地缓存 → 可信度 70（历史快照，需要重新确认）
    // 这两个值必须区分开，否则"缓存数据"会被当成"刚查到的实时数据"展示给经纪人。
    const reliabilityForUpsert = usedLocalCache
      ? {
          score: RELIABILITY_TIERS.LOCAL_CACHE,
          // 缓存数据**不是刚核验的** —— 它的核验时间应保持库里原值，
          // 因此这里传 canVerify=false，不写 lastVerifiedAt
          status: 'PENDING' as const,
          canVerify: false,
        }
      : {
          score: RELIABILITY_TIERS.OFFICIAL_REALTIME,
          status: 'VERIFIED' as const,
          canVerify: true,
        };

    const upsertResult = await this.propertyUpsert.upsertMany(
      organizationId,
      filterResult.passed,
      PropertyProviderKind.BEIKE,
      reliabilityForUpsert,
    );

    if (upsertResult.priceChanges.length > 0) {
      warnings.push(
        `${upsertResult.priceChanges.length} 套房源价格发生变化` +
          `（${upsertResult.priceChanges
            .slice(0, 3)
            .map((change) => `${change.community}${change.changeAmount < 0 ? '降' : '涨'}${Math.abs(Math.round(change.changeAmount / 10_000))}万`)
            .join('，')}）`,
      );
    }

    // =====================================================================
    // 10. 匹配打分（含推荐去重）
    // =====================================================================
    const stepStart10 = Date.now();
    const previouslyRecommended = await this.propertyUpsert.findPreviouslyRecommended(
      organizationId,
      input.customerId,
    );

    const scored = this.scoring.score(filterResult.passed, mergeResult.merged, {
      previouslyRecommended,
      priceSensitive: false,
    });

    track(
      AssistantStep.SCORING,
      `已为 ${scored.length} 套房源计算匹配度，最高 ${scored[0]?.matchScore ?? 0} 分`,
      Date.now() - stepStart10,
    );

    // =====================================================================
    // 11. 详情补全（只对 Top N，控制贝壳调用次数）
    // =====================================================================
    const stepStart11 = Date.now();
    const topN = scored.slice(0, recommendationCount);

    /**
     * ⚠️ Phase 12 性能修复：降级模式下**跳过详情补全**。
     *
     * 问题（实测踩到）：搜索步骤已经判定贝壳不可用并降级到本地缓存，
     * 但详情补全仍然去调贝壳 —— 这些调用**必定失败**，
     * 只是白白等待重试与退避。
     *
     * 实测代价：Top 5 分两批并发，每批 2 次尝试 + 退避，
     * 最坏情况让整体耗时从 20 秒涨到 **70 秒**（其中一次 45 秒卡顿）。
     *
     * 逻辑上也说不通：既然实时接口已不可用，就不该再去请求它。
     * 缓存数据本身已包含摘要字段（价格/户型/面积/建成年代），
     * 足够生成推荐与文案；详情补全只是"锦上添花"。
     */
    const enriched = usedLocalCache
      ? new Map<string, NormalizedProperty>()
      : await this.enrichTopProperties(
          topN.map((item) => item.property.externalId),
          built.query.city,
        );

    /**
     * 完整详情 —— **不再预取**，改为前端按需加载（容量数据驱动的决策）。
     *
     * ============================================================================
     * 为什么改（真实容量数据）
     * ============================================================================
     * 实测调用量分析（20 次搜索/天/人的典型场景）：
     *   · 列表预取全部详情：一次搜索 11 次调用 → 约 220 次/天/人
     *   · 列表只取摘要：      一次搜索 1 次调用  → 约 30 次/天/人
     *
     * 而实测：11 次密集调用即触发贝壳限流，**恢复需 30 分钟以上**；
     * 且限流按**账号/Key** 计 —— 10 个经纪人共用同一份额度。
     *
     * 因此改为：
     *   · **列表**：只用搜索响应自带的摘要（面积/户型/朝向/楼层/年份/小区/标签）
     *   · **详情**：经纪人点开某一套时，前端调
     *     `GET /customers/:id/properties/:externalId/detail` 按需加载
     *   · **缓存**：详情加载后落库，同一房源反复查看零额外调用
     *
     * ============================================================================
     * 缓存降级时仍然读库
     * ============================================================================
     * 贝壳不可用时（限流/故障），列表虽然拿不到实时摘要，
     * 但**此前持久化的详情**仍应从库里读回并附在卡片上 ——
     * 这样限流期间界面依然能展示小区信息、周边配套与图片。
     */
    const fullDetails = new Map<string, { detail: PropertyFullDetail; vrUrl: string | null }>();

    if (usedLocalCache && topN.length > 0) {
      try {
        const persisted = await this.detailStore.loadMany(
          organizationId,
          topN.map((item) => item.property.externalId),
        );

        for (const [externalId, value] of persisted) {
          fullDetails.set(externalId, { detail: value.detail, vrUrl: value.detail.vrUrl });
        }

        if (persisted.size > 0) {
          this.logger.log(
            `已从库中读回 ${persisted.size} 套完整详情（限流期间仍可展示小区信息与图片）`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `读回历史详情失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    track(
      AssistantStep.ENRICHING_DETAIL,
      usedLocalCache
        ? fullDetails.size > 0
          ? `${cacheFallbackReason ?? '贝壳暂时不可用'}｜已从库中读回 ${fullDetails.size} 套历史详情`
          : `${cacheFallbackReason ?? '贝壳暂时不可用'}｜本次无历史详情可用`
        : '完整详情与图片按需加载（点开房源时获取，避免额外调用触发限流）',
      Date.now() - stepStart11,
      usedLocalCache ? (fullDetails.size > 0 ? 'SUCCESS' : 'SKIPPED') : 'SKIPPED',
    );

    // 用详情数据替换摘要（详情字段更全），并重新计算匹配度
    const enrichedTop = topN.map((item) => {
      const detail = enriched.get(item.property.externalId);
      if (!detail) return item;

      // 详情数据更完整 → 重新打分，让学区/配套等信息体现在分数里
      const rescored = this.scoring.score([detail], mergeResult.merged, {
        previouslyRecommended,
      })[0];

      return rescored ?? item;
    });

    // 重新排序（详情补全后分数可能变化）
    enrichedTop.sort((a, b) => b.matchScore - a.matchScore);

    const finalRecommendations = enrichedTop.slice(0, recommendationCount);

    // =====================================================================
    // 12. 生成微信文案
    // =====================================================================
    const stepStart12 = Date.now();
    const reply = await this.replyGenerator.generate({
      customerName: customer.name,
      customerGender: customer.gender,
      agentName,
      profile: mergeResult.merged,
      properties: finalRecommendations.map((item) => ({
        property: item.property,
        matchScore: item.matchScore,
        highlights: item.highlights,
        cautions: item.cautions,
        priceChange: item.priceChange,
      })),
      style: replyStyle,
      portalUrl: input.portalUrl ?? null,
    });

    track(
      AssistantStep.GENERATING_REPLY,
      `${reply.aiGenerated ? 'AI' : '规则'}生成 ${reply.length} 字微信文案`,
      Date.now() - stepStart12,
    );

    // =====================================================================
    // 13. 记录推荐批次与匹配结果
    // =====================================================================
    const durationMs = Date.now() - startedAt;

    // 把 externalId 映射回数据库 ID
    const matchResults: ScoredPropertyMatch[] = finalRecommendations.map((item) => {
      const propertyId = upsertResult.idMap.get(item.property.externalId) ?? '';
      return {
        propertyId,
        externalId: item.property.externalId,
        matchScore: item.matchScore,
        breakdown: item.breakdown,
        highlights: item.highlights,
        cautions: item.cautions,
        explanation: item.highlights.join('；') || null,
        previouslyRecommended: item.previouslyRecommended,
        priceDropReentry: item.priceDropReentry,
        priceChange: item.priceChange,
      };
    });

    const validMatches = matchResults.filter((match) => match.propertyId.length > 0);

    await this.recommendation.recordMatches(organizationId, input.customerId, validMatches);

    const batch = await this.recommendation.createBatch(organizationId, {
      customerId: input.customerId,
      agentId: input.agentId,
      sourceMessageId: message.id,
      requirementSnapshotId: snapshot?.id ?? null,
      candidateCount: candidates.length,
      hardFilteredCount: filterResult.passed.length,
      properties: validMatches.map((match) => ({
        propertyId: match.propertyId,
        externalId: match.externalId,
        matchScore: match.matchScore,
        breakdown: match.breakdown,
        highlights: match.highlights,
        cautions: match.cautions,
        explanation: match.explanation,
      })),
      searchQuery: {
        naturalQuery: built.query.naturalQuery,
        rationale: built.query.rationale,
        hardConditions: built.hardConditionSummary,
        softConditions: built.softConditionSummary,
      },
      beikeTotalRecalled: totalRecalled,
      durationMs,
      reply: {
        content: reply.content,
        style: reply.style,
        aiGenerated: reply.aiGenerated,
      },
    });

    track(AssistantStep.DONE, `全流程完成，耗时 ${(durationMs / 1000).toFixed(1)} 秒`, durationMs);

    this.logger.log(
      `闭环完成：客户 ${customer.name} | 候选 ${candidates.length} → 硬筛 ${filterResult.passed.length} ` +
        `→ 推荐 ${finalRecommendations.length} 套 | 耗时 ${durationMs}ms | ` +
        `需求来源 ${extraction.source} | 文案来源 ${reply.aiGenerated ? 'AI' : '规则'}`,
    );

    // =====================================================================
    // 14. 组装返回
    // =====================================================================
    return {
      messageId: message.id,
      snapshotId: snapshot?.id ?? null,
      snapshotVersion: snapshot?.version ?? null,
      profile: mergeResult.merged,
      profileSummary: describeProfile(mergeResult.merged),
      changes: RequirementSnapshotService.describeChanges(mergeResult.changes),
      needsConfirmation: mergeResult.needsConfirmation,
      extractionSource: extraction.source,
      extractionConfidence: extraction.extraction.confidence,
      missingCriticalFields: extraction.extraction.missingCriticalFields,
      searchQuery: {
        naturalQuery: built.query.naturalQuery,
        rationale: built.query.rationale,
        hardConditions: built.hardConditionSummary,
        softConditions: built.softConditionSummary,
      },
      beikeStats: {
        totalRecalled,
        returned: candidates.length,
        passedHardFilter: filterResult.passed.length,
        rejectedByReason: filterResult.rejectionStats,
      },
      dataSource: usedLocalCache ? 'LOCAL_CACHE' : 'LIVE',
      cacheNote: cacheSourceNote,
      recommendations: finalRecommendations.map((item) => {
        const propertyId = upsertResult.idMap.get(item.property.externalId) ?? '';
        // Phase 12：把本次搜索的取数路径传进去 —— 它决定可信度
        // （实时查询 100 分 / 本地缓存 70 分），进而决定卡片的可信度展示
        // Phase 15：把完整详情传进去 —— 卡片要展示与贝壳 App 同等详细的信息
        return this.toRecommendationDto(item, propertyId, {
          usedLocalCache,
          fullDetail: fullDetails.get(item.property.externalId)?.detail ?? null,
          vrUrl: fullDetails.get(item.property.externalId)?.vrUrl ?? null,
        });
      }),
      reply: {
        replyId: batch.replyId,
        content: reply.content,
        style: reply.style,
        aiGenerated: reply.aiGenerated,
        length: reply.length,
      },
      batchId: batch.batchId,
      zeroResultSuggestions: [],
      steps,
      durationMs,
      warnings,
    };
  }

  // =========================================================================
  // 详情补全
  // =========================================================================

  /**
   * 对 Top N 房源补全详情。
   *
   * 为什么要限制并发（需求 §67）：
   *   每次详情补全都要启动一次 CLI 子进程（约 2～10 秒）。
   *   如果对 30 套用 Promise.all，会同时启动 30 个进程，
   *   既拖慢整体响应，也可能触发贝壳的限流。
   *   这里用分批并发（每批 4 个），在总耗时与资源占用之间取平衡。
   */
  private async enrichTopProperties(
    externalIds: string[],
    city: string,
  ): Promise<Map<string, NormalizedProperty>> {
    const result = new Map<string, NormalizedProperty>();

    if (externalIds.length === 0) return result;

    const provider = new BeikePropertyProvider(this.beikeClient);

    // 分批并发
    for (let i = 0; i < externalIds.length; i += this.detailConcurrency) {
      const batch = externalIds.slice(i, i + this.detailConcurrency);

      const settled = await Promise.allSettled(
        batch.map((externalId) => provider.fetchPropertiesDetail([externalId], city)),
      );

      settled.forEach((outcome, index) => {
        const externalId = batch[index];
        if (!externalId) return;

        if (outcome.status === 'fulfilled') {
          const property = outcome.value[0];
          if (property) result.set(externalId, property);
        } else {
          // 单套失败不影响整批（需求 §66：要测试"detail 一套失败"的场景）
          this.logger.warn(
            `房源 ${externalId} 详情补全失败：` +
              `${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
        }
      });
    }

    return result;
  }

  // =========================================================================
  // 组装 DTO
  // =========================================================================

  private toRecommendationDto(
    item: ReturnType<MatchScoringService['score']>[number],
    propertyId: string,
    /**
     * Phase 12：本次搜索的可信度上下文。
     *
     * 为什么由调用方传入而不是在方法内判断：
     *   同一次搜索里所有房源来自同一条路径（实时查询 或 本地缓存降级），
     *   因此可信度是**批次级**属性，不是单条房源的属性。
     *   在方法内重复判断既浪费又容易不一致。
     *
     * Phase 15：新增完整详情与 VR 链接 ——
     *   这两个是**单条房源级**数据，由详情补全阶段逐套获取。
     */
    reliabilityContext: {
      usedLocalCache: boolean;
      fullDetail: PropertyFullDetail | null;
      vrUrl: string | null;
    },
  ): RecommendedPropertyDto {
    const p = item.property;

    // ---- 可信度评估（Phase 12）----
    // 实时路径：贝壳官方 API → 100 分，刚核验，24 小时有效
    // 降级路径：本地缓存 → 70 分，核验时间保持库里原值（不伪造"刚确认过"）
    const baseScore = reliabilityContext.usedLocalCache
      ? RELIABILITY_TIERS.LOCAL_CACHE
      : RELIABILITY_TIERS.OFFICIAL_REALTIME;

    const ttlHours = VERIFICATION_TTL.OFFICIAL_REALTIME;

    // 实时路径下"此刻"就是核验时间；缓存路径下没有可信的核验时间
    const lastVerifiedAt = reliabilityContext.usedLocalCache ? null : new Date();

    const reliabilityAssessment = this.reliability.assess({
      baseScore,
      ttlHours,
      lastVerifiedAt,
      sourceType: PropertySourceType.OFFICIAL_API,
      sourceName: '贝壳',
      // 降级取数时必须明确告知"这是历史快照"，而不是含糊地说"需要确认"
      fromCache: reliabilityContext.usedLocalCache,
    });

    const finalScore = this.reliability.computeFinalScore({
      matchScore: item.matchScore,
      dataReliabilityScore: reliabilityAssessment.score,
      lastVerifiedAt,
    });

    const subwayText =
      p.subwayDistance !== null
        ? `${p.subway?.line ? `${p.subway.line} ` : ''}${p.subway?.station ?? ''}${
            p.subway?.station ? ' ' : ''
          }约${p.subwayDistance}米`
        : null;

    const schoolText = p.schoolInfo
      ? [p.schoolInfo.primarySchool, p.schoolInfo.middleSchool, p.schoolInfo.note]
          .filter(Boolean)
          .join(' ｜ ')
      : null;

    return {
      propertyId,
      externalId: p.externalId,
      matchScore: item.matchScore,
      community: p.community,
      city: p.city,
      district: p.district,
      subDistrict: p.subDistrict,
      title: p.title,
      totalPrice: p.totalPrice,
      unitPrice: p.unitPrice,
      bedrooms: p.bedrooms,
      livingRooms: p.livingRooms,
      bathrooms: p.bathrooms,
      area: p.area,
      floor: p.floor,
      totalFloors: p.totalFloors,
      buildYear: p.buildYear,
      decoration: p.decoration,
      orientation: p.orientation,
      subwayDistance: p.subwayDistance,
      subwayText: subwayText && subwayText.trim().length > 0 ? subwayText : null,
      schoolText: schoolText && schoolText.length > 0 ? schoolText : null,
      images: p.images.map((image) => image.url).slice(0, 12),
      coverImage: p.images[0]?.url ?? null,
      tags: p.tags.slice(0, 12),
      listingStatus: p.listingStatus,
      breakdown: item.breakdown.map((dimension) => ({
        key: dimension.key,
        label: dimension.label,
        score: dimension.score,
        maxScore: dimension.maxScore,
        detail: dimension.detail,
      })),
      highlights: item.highlights,
      cautions: item.cautions,
      explanation: item.highlights.length > 0 ? item.highlights.join('；') : null,
      previouslyRecommended: item.previouslyRecommended,
      priceChange: item.priceChange,

      // ---- 来源标注（Phase 12 修正）----
      //
      // ⚠️ 之前这里硬编码为 '贝壳开放平台'。
      // 问题：贝壳不可用走**本地缓存降级**时，房源其实是历史快照，
      // 却仍被标成"贝壳开放平台" —— 经纪人会误以为是实时数据。
      // 现在按实际取数路径区分：实时查询 vs 本地缓存。
      source: reliabilityContext.usedLocalCache ? '贝壳（本地缓存）' : '贝壳开放平台',

      // ---- 数据可信度（Phase 12，需求 §6）----
      //
      // 与 matchScore **分开传递**，不参与需求匹配计算
      // （需求 §5：不要让来源名称影响评分，只影响真实性权重）。
      dataReliabilityScore: reliabilityAssessment.score,
      reliabilityStars: reliabilityAssessment.stars,
      verificationStatus: reliabilityAssessment.status,
      reliabilityNote: reliabilityAssessment.note,
      lastVerifiedAt: reliabilityAssessment.lastVerifiedAt?.toISOString() ?? null,
      freshnessScore: reliabilityAssessment.freshnessScore,
      finalScore: finalScore.finalScore,

      // ---- 完整详情（Phase 15）----
      // 未补全时为 null / 空数组 —— 界面据此显示"暂无数据"，
      // **绝不编造**（需求 §13：不得编造房源信息）
      fullDetail: reliabilityContext.fullDetail,
      imageDetails: reliabilityContext.fullDetail?.images ?? [],
      vrUrl: reliabilityContext.vrUrl,
    };
  }

  /** 把贝壳错误转成人能理解的中文 */
  private describeBeikeError(error: unknown): string {
    if (error instanceof BeikeNotConfiguredError) {
      return `贝壳数据源未配置：${error.message}`;
    }

    /**
     * 预算护栏主动拒绝 —— 与"贝壳故障"必须分开说。
     *
     * 差异对使用者很重要：
     *   · 护栏拒绝 → 是**我们主动保护**，原因明确，稍后自动恢复
     *   · 贝壳故障 → 外部问题，原因不明
     * 混在一起会让使用者以为"系统坏了"，而实际是我们有意为之。
     */
    if (error instanceof BeikeQuotaExceededError) {
      return error.message;
    }

    if (error instanceof BeikeCliError) {
      if (error.isServiceBusy) {
        return '贝壳房源服务临时繁忙（已自动重试仍未成功），请稍后重试';
      }
      if (error.isUnavailable) {
        return '贝壳服务暂时不可达（网络超时），请稍后重试';
      }
      return `贝壳查询失败：${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/** 客户不存在 */
export class CustomerNotFoundError extends Error {
  readonly errorCode = ApiErrorCode.CUSTOMER_NOT_FOUND;

  constructor(customerId: string) {
    super(`客户（${customerId}）不存在或无权访问`);
    this.name = 'CustomerNotFoundError';
  }
}
