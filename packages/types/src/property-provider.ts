/**
 * 多房源供应商聚合层 · 契约定义
 *
 * ============================================================================
 * 为什么单独一个文件，而不是改 `property.ts`？
 * ============================================================================
 * `property.ts` 里的 `PropertyProvider` / `NormalizedProperty` 已被
 * Mock/Beike 两个 Provider 与一批验证脚本依赖，改动风险高。
 *
 * 本文件**只做扩展**（新增类型与可选字段），不改动已有定义：
 *   - `PropertySourceType`    区分 API / 用户提供 / 私有 / 演示
 *   - `ProviderCapability`    供应商能力声明（驱动搜索策略）
 *   - `ProviderCredentialType` 凭证类型（合规强约束，见下）
 *   - `PropertyProviderV2`    扩展后的 Provider 接口
 *
 * ============================================================================
 * 合规强约束（这是本文件存在的核心理由之一）
 * ============================================================================
 * `ProviderCredentialType` 枚举里**只有合法来源**：
 *   OFFICIAL_API       供应商官方开放平台
 *   BUSINESS_AGREEMENT 正式商务合同授权的数据接口
 *   SELF_OWNED         经纪公司自有房源（无第三方权利）
 *   USER_PROVIDED      用户主动提供（粘贴/上传/导入），与"粘贴微信消息"同理
 *
 * **不存在 `SCRAPING` 选项。** 任何尝试用抓取类凭证注册的 Provider
 * 都会因为类型不匹配而无法注册（编译期拦截），而不是依赖人工审查。
 *
 * 关于低频爬虫（开发验证用）的定位：
 *   它不以 Provider 形态进入生产链路，而是作为一个**开发环境专用**的
 *   数据获取工具（`DevFetchTool`），其产物走 `USER_PROVIDED` 路径入库。
 *   这样生产链路上不存在任何抓取型 Provider。
 */

import type {
  Decoration,
  ListingStatus,
  NormalizedProperty,
  Orientation,
  OwnershipType,
  PropertyImage,
  PropertyProviderKind,
  PropertyType,
  SchoolInfo,
  SubwayInfo,
} from './property.js';

// ============================================================================
// 一、来源分类
// ============================================================================

/**
 * 数据来源形态。
 *
 * 与 `PropertyProviderKind`（哪一家）正交：
 *   kind = BEIKE + sourceType = OFFICIAL_API
 *   kind = ANJUKE + sourceType = USER_PROVIDED
 *
 * 分开的原因：同一家平台在不同阶段可能是不同形态
 * （安居客现在只能 USER_PROVIDED，未来授权后变成 OFFICIAL_API），
 * 而 sourceType 决定的是**可信度与可用范围**，不是"是哪一家"。
 */
export enum PropertySourceType {
  /** 官方开放平台 API */
  OFFICIAL_API = 'OFFICIAL_API',
  /** 商务合同授权的数据接口 */
  AUTHORIZED_API = 'AUTHORIZED_API',
  /** 用户主动提供（粘贴文本 / 上传 HTML / Excel 导入） */
  USER_PROVIDED = 'USER_PROVIDED',
  /** 经纪公司自有房源（独家、钥匙房等） */
  PRIVATE = 'PRIVATE',
  /** 演示数据（必须显式标注 Demo，禁止冒充真实房源） */
  DEMO = 'DEMO',
}

export const PROPERTY_SOURCE_TYPE_LABELS: Record<PropertySourceType, string> = {
  [PropertySourceType.OFFICIAL_API]: '官方接口',
  [PropertySourceType.AUTHORIZED_API]: '授权接口',
  [PropertySourceType.USER_PROVIDED]: '用户录入',
  [PropertySourceType.PRIVATE]: '自有房源',
  [PropertySourceType.DEMO]: '演示数据',
};

/**
 * 凭证类型 —— 合规强约束。
 *
 * ⚠️ 这里**故意不包含** `SCRAPING` / `BROWSER_AUTOMATION`。
 * 新增数据源时如果它的凭证类型不是这四种之一，说明该来源不合法，
 * 应当重新评估，而不是往枚举里加一项。
 */
export enum ProviderCredentialType {
  /** 官方开放平台申请的应用凭证 */
  OFFICIAL_API = 'OFFICIAL_API',
  /** 商务合同约定的接口凭证 */
  BUSINESS_AGREEMENT = 'BUSINESS_AGREEMENT',
  /** 自有数据，无需第三方凭证 */
  SELF_OWNED = 'SELF_OWNED',
  /** 用户主动提供，凭证即用户本人授权 */
  USER_PROVIDED = 'USER_PROVIDED',
}

export const PROVIDER_CREDENTIAL_TYPE_LABELS: Record<ProviderCredentialType, string> = {
  [ProviderCredentialType.OFFICIAL_API]: '官方应用凭证',
  [ProviderCredentialType.BUSINESS_AGREEMENT]: '商务合同凭证',
  [ProviderCredentialType.SELF_OWNED]: '自有数据',
  [ProviderCredentialType.USER_PROVIDED]: '用户授权提供',
};

/** 数据源优先级层级（需求 §9） */
export enum ProviderTier {
  /** Level 1：官方 API */
  OFFICIAL = 1,
  /** Level 2：商务授权数据 */
  AUTHORIZED = 2,
  /** Level 3：用户提供 / 自有房源 */
  SUPPLEMENTARY = 3,
  /** Level 4：仅演示，永不进入生产结果 */
  DEMO = 4,
}

// ============================================================================
// 二、能力声明
// ============================================================================

/**
 * 供应商能力声明。
 *
 * 为什么必须显式声明（而不是让上层猜）：
 *   1. 贝壳单次只返回约 10 条 —— 上层必须知道才能决定是否做"区域放宽重搜"
 *   2. 有的源能给图片/学区，有的不能 —— 界面要据此决定显示"暂无数据"
 *   3. 限流与配额决定并发与缓存策略
 */
export interface ProviderCapability {
  /** 能否翻页取全量。false 表示单次 TopK，需要上层做搜索策略补偿 */
  canPaginate: boolean;
  /** 单次查询返回条数上限（贝壳实测约 10） */
  maxResultsPerQuery: number;

  // ---- 字段能力 ----
  supportsDetail: boolean;
  supportsImages: boolean;
  supportsFloorPlan: boolean;
  supportsCommunity: boolean;
  supportsSchool: boolean;
  supportsSubway: boolean;
  supportsSoldHistory: boolean;
  /** 能否核验"是否仍在售"（决定发送给客户前能否做状态校验） */
  supportsRealtimeStatus: boolean;

  // ---- 范围 ----
  /** 支持的城市；'ALL' 表示不限 */
  cities: string[] | 'ALL';
  /** 限流与配额 */
  rateLimit: {
    requestsPerMinute: number;
    /** 每日配额，null 表示无明确上限 */
    dailyQuota: number | null;
  };

  // ---- 数据可信度（Phase 12）----
  //
  // 这两项由 Provider 自己声明，然后由 `PropertyReliabilityService` 统一换算成
  // 0~100 的可信度分数。**不让业务层硬编码"贝壳=100"** ——
  // 那样每加一个源都要改业务代码，而且容易漏。

  /**
   * 该来源的**基础可信度**（0~100）。
   *
   * 参考档位（需求 §4）：
   *   贝壳实时 API   100
   *   公司自有        95
   *   经纪人上传      80
   *   本地缓存        70
   *   演示数据         0   ← DEMO 恒为 0，且生产环境禁止使用
   */
  baseReliabilityScore: number;

  /**
   * 核验有效期（小时）。超过这个时间未重新核验 → 房源状态变为 EXPIRED。
   *
   * 为什么必须有时效：房源是**会过期**的数据。今天在售，下周可能已成交。
   * 把过期房源发给客户是**不可接受的错误**（会让经纪人在客户面前失信）。
   *
   *   贝壳实时     24 小时（在售状态变化快）
   *   公司自有     72 小时（自己维护，相对可控）
   *   经纪人上传   null（**无法核验**，永远 PENDING，界面必须提示"需确认"）
   */
  verificationTtlHours: number | null;
}

/** 默认能力（保守值：什么都不能，必须显式声明） */
export const CONSERVATIVE_CAPABILITY: ProviderCapability = {
  canPaginate: false,
  maxResultsPerQuery: 10,
  supportsDetail: false,
  supportsImages: false,
  supportsFloorPlan: false,
  supportsCommunity: false,
  supportsSchool: false,
  supportsSubway: false,
  supportsSoldHistory: false,
  supportsRealtimeStatus: false,
  cities: 'ALL',
  rateLimit: { requestsPerMinute: 10, dailyQuota: null },
  // 保守默认：可信度最低、且无法核验（必须显式声明才能提高）
  baseReliabilityScore: 50,
  verificationTtlHours: null,
};

/**
 * 可信度档位（需求 §4 规定的标准值）。
 *
 * 集中定义在这里，避免各 Provider 各写各的数字导致口径漂移。
 */
export const RELIABILITY_TIERS = {
  /** 官方 API 实时数据 */
  OFFICIAL_REALTIME: 100,
  /** 公司自有房源（自己维护） */
  COMPANY_OWNED: 95,
  /** 经纪人手动上传（无法实时核验） */
  AGENT_UPLOADED: 80,
  /** 本地缓存（历史快照） */
  LOCAL_CACHE: 70,
  /** 演示数据 —— 恒为 0，且生产环境禁止使用 */
  DEMO: 0,
} as const;

/** 核验时效档位（小时） */
export const VERIFICATION_TTL = {
  /** 官方实时源：24 小时（在售状态变化快） */
  OFFICIAL_REALTIME: 24,
  /** 公司自有：72 小时 */
  COMPANY_OWNED: 72,
  /** 经纪人上传：无法核验 → null */
  AGENT_UPLOADED: null,
} as const;

// ============================================================================
// 三、查询模型
// ============================================================================

/**
 * 结构化搜索条件。
 *
 * 与 `PropertyQuery`（旧接口，只有 city/district/page）的区别：
 * 这是**业务真正需要**的条件集合，是 `PropertySearchQuery` 的 Provider 层投影。
 *
 * 设计要点：**不再有 `naturalQuery`**。
 * 自然语言是贝壳**语义检索特有**的输入方式，结构化 API 用不上。
 * 需要它的 Provider 自己在适配器内部生成（见 `BeikeProvider` 的 buildNaturalQuery）。
 */
export interface ProviderSearchQuery {
  city: string;
  districts: string[];
  subDistricts: string[];
  communities: string[];

  /** 预算上限（元）。语义检索类 Provider 会把区间收敛到目标价附近 */
  budgetMax: number | null;
  budgetMin: number | null;

  bedrooms: number[];
  livingRooms: number[];

  areaMin: number | null;
  areaMax: number | null;

  /** 房龄下限（建成晚于该年份） */
  builtAfterYear: number | null;

  /** 必须带电梯 */
  requireElevator?: boolean;

  /** 只要在售 */
  onlyActive?: boolean;

  /** 期望返回条数（Provider 可自行截断） */
  limit: number;
}

/**
 * Provider 搜索结果。
 *
 * `perProvider` 语义：本结果**只来自一个 Provider**。
 * 多源合并由 `MultiSourceAggregator` 负责，Provider 不感知其它源。
 */
export interface ProviderSearchResult {
  provider: PropertyProviderKind;
  items: NormalizedProperty[];
  /** 该源声称的总召回数（可能为 null —— 并非所有源都提供） */
  totalRecalled: number | null;

  /**
   * 是否为「精确命中」。
   * 贝壳会返回 matchedConditions，标示条件是 EXACT 还是 LIKE 匹配。
   * 其它源如果没有这个概念，返回 true。
   */
  exactMatch: boolean;

  /** 实际生效的查询条件（Provider 可能做了调整/放宽，必须如实上报） */
  effectiveQuery: Partial<ProviderSearchQuery>;

  /** 耗时（毫秒），用于健康监控 */
  durationMs: number;
}

/** 房源在售状态核验结果 */
export interface AvailabilityResult {
  externalId: string;
  status: ListingStatus;
  /** 核验时的价格（可能已变动） */
  currentTotalPrice: number | null;
  /** 核验时间 */
  checkedAt: Date;
  /** 核验方式说明（便于审计：是实时查询还是缓存判断） */
  method: 'REALTIME_QUERY' | 'CACHED' | 'UNAVAILABLE';
}

/** 小区信息 */
export interface CommunityProfile {
  name: string;
  district: string;
  subDistrict: string | null;
  buildYear: number | null;
  /** 容积率 */
  floorAreaRatio: number | null;
  /** 绿化率（百分比数值，如 35 表示 35%） */
  greenRate: number | null;
  /** 物业费（元/㎡/月） */
  propertyFee: number | null;
  /** 总户数 */
  totalHouseholds: number | null;
  /** 开发商 */
  developer: string | null;
  /** 物业公司 */
  propertyManagementCompany: string | null;
  /** 周边配套描述 */
  facilities: string[];
  rawData?: Record<string, unknown> | null;
}

// ============================================================================
// 四、统一错误模型
// ============================================================================

/** Provider 错误分类 */
export enum ProviderErrorCode {
  /** 凭证未配置 */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** 凭证无效/过期 */
  AUTH_FAILED = 'AUTH_FAILED',
  /** 服务端不可用（对方问题，可重试） */
  UNAVAILABLE = 'UNAVAILABLE',
  /** 触发限流（可重试，需等待） */
  RATE_LIMITED = 'RATE_LIMITED',
  /** 查询条件非法（重试无用） */
  INVALID_QUERY = 'INVALID_QUERY',
  /** 零结果（不是错误，但要能区分于"服务挂了"） */
  EMPTY_RESULT = 'EMPTY_RESULT',
  /** 解析失败（响应格式变了） */
  PARSE_FAILED = 'PARSE_FAILED',
  /** 超时 */
  TIMEOUT = 'TIMEOUT',
  /** 未知 */
  UNKNOWN = 'UNKNOWN',
}

/**
 * 统一的 Provider 错误。
 *
 * 业务层只需处理这一种错误类型 —— 不再需要 `instanceof BeikeCliError`
 * 这类供应商专属判断（这是当前架构的主要耦合点之一）。
 */
export class ProviderError extends Error {
  readonly provider: PropertyProviderKind;
  readonly code: ProviderErrorCode;
  /** 是否值得重试（业务层据此决定是否等待后重试） */
  readonly retryable: boolean;
  /** 建议等待多久再重试 */
  readonly retryAfterMs: number | null;
  /** 原始错误（保留用于日志与排查） */
  readonly originalError: Error | null;

  constructor(
    provider: PropertyProviderKind,
    code: ProviderErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number | null;
      originalError?: Error | null;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.originalError = options.originalError ?? null;
  }

  /** 是否为"供应商侧问题"（用于给用户展示恰当的提示） */
  get isProviderSideIssue(): boolean {
    return (
      this.code === ProviderErrorCode.UNAVAILABLE ||
      this.code === ProviderErrorCode.RATE_LIMITED ||
      this.code === ProviderErrorCode.TIMEOUT
    );
  }

  /** 是否为"我方配置问题"（需要用户/运维处理，重试无用） */
  get isConfigurationIssue(): boolean {
    return (
      this.code === ProviderErrorCode.NOT_CONFIGURED ||
      this.code === ProviderErrorCode.AUTH_FAILED
    );
  }
}

// ============================================================================
// 五、Provider 接口
// ============================================================================

/**
 * 多源 Provider 统一接口（扩展版）。
 *
 * 与旧 `PropertyProvider` 的差异：
 *   1. 新增 `getImages` / `getCommunity` / `checkAvailability` / `healthCheck`
 *      —— 覆盖需求 §3 要求的完整能力面
 *   2. `search` 接收**结构化条件**，不再依赖 `naturalQuery`
 *   3. 新增 `describe()` 元信息（凭证类型、层级、能力），供注册表与后台展示
 *
 * ⚠️ 业务层**只依赖本接口**，不得 import 任何具体 Provider 实现。
 */
export interface PropertyProviderV2 {
  // ---- 身份 ----
  readonly kind: PropertyProviderKind;
  readonly sourceType: PropertySourceType;
  readonly credentialType: ProviderCredentialType;
  readonly tier: ProviderTier;
  readonly capability: ProviderCapability;

  /** 人类可读的源名称（用于界面来源标签） */
  displayName(): string;

  // ---- 状态 ----
  /** 凭证是否已配置 */
  isConfigured(): boolean;
  /** 健康探测（轻量调用，用于健康监控） */
  healthCheck(): Promise<ProviderHealth>;

  // ---- 核心检索 ----
  search(query: ProviderSearchQuery): Promise<ProviderSearchResult>;

  // ---- 补充能力（不支持时返回 null / 空数组，不抛错） ----
  getDetail(externalId: string): Promise<NormalizedProperty | null>;
  getImages(externalId: string): Promise<PropertyImage[]>;
  getCommunity(externalId: string): Promise<CommunityProfile | null>;
  checkAvailability(externalId: string): Promise<AvailabilityResult>;
}

/** 健康状态 */
export enum ProviderHealthStatus {
  ONLINE = 'ONLINE',
  /** 降级：仍可调用但成功率低 */
  DEGRADED = 'DEGRADED',
  OFFLINE = 'OFFLINE',
  /** 管理员手动停用 */
  DISABLED = 'DISABLED',
  /** 未配置凭证 */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
}

export interface ProviderHealth {
  provider: PropertyProviderKind;
  sourceType: PropertySourceType;
  status: ProviderHealthStatus;
  /** 本次探测耗时（毫秒） */
  responseTimeMs: number | null;
  /** 最近一次错误信息 */
  lastErrorMessage: string | null;
  checkedAt: Date;
}

// ============================================================================
// 六、多源聚合结果
// ============================================================================

/**
 * 聚合后的房源（带来源追溯）。
 *
 * 这是交给 AI Matching 的输入 —— 注意它**继承 NormalizedProperty 的全部字段**，
 * 因此匹配与打分逻辑完全不需要改动。
 */
export interface AggregatedProperty extends NormalizedProperty {
  /** 该房源出现在哪些源（≥1） */
  sources: PropertySourceRef[];
  /** 主来源（决定卡片显示哪个平台标签） */
  primarySource: PropertySourceRef;
  /** 跨源归并指纹 */
  fingerprint: string;
  /** 数据可信度 0~1（多源一致 → 高） */
  dataConfidence: number;

  // ---- Phase 12：可信度（与 matchScore 分离，不参与需求匹配计算）----
  /** 数据可信度评分 0~100 */
  dataReliabilityScore: number;
  /** 最后一次确认在售的时间 */
  lastVerifiedAt: Date | null;
  /** 核验状态 */
  verificationStatus: 'VERIFIED' | 'PENDING' | 'EXPIRED';
  /** 给经纪人看的可信度说明（必须诚实，不隐藏风险） */
  reliabilityNote: string;
  /** 星级 0~5 */
  reliabilityStars: number;
  /** 时效性得分 0~100 */
  channelFreshness: number;
}

/** 单一来源引用 */
export interface PropertySourceRef {
  provider: PropertyProviderKind;
  sourceType: PropertySourceType;
  externalId: string;
  /** 原始房源链接（经纪人可点开核实；无则为 null） */
  sourceUrl: string | null;
  /** 该源显示用的名称 */
  displayName: string;
  /** 该源的价格（不同源报价可能不同） */
  totalPrice: number;
  /** 该源最后同步时间 */
  syncedAt: Date;
}

/** 单个 Provider 的执行结果（含失败） */
export interface ProviderExecutionResult {
  provider: PropertyProviderKind;
  displayName: string;
  success: boolean;
  itemCount: number;
  durationMs: number;
  error: ProviderError | null;
}

/** 多源搜索的完整结果 */
export interface MultiSourceSearchResult {
  /** 归并后的房源（已去重） */
  properties: AggregatedProperty[];
  /** 每个源的执行情况（含失败的源，用于界面说明与健康监控） */
  executions: ProviderExecutionResult[];
  /** 归并统计 */
  stats: {
    /** 各源原始返回条数之和 */
    rawCount: number;
    /** 归并后条数 */
    mergedCount: number;
    /** 因跨源重复而合并掉的条数 */
    mergedAway: number;
    /** 有多少条房源出现在多个源 */
    multiSourceCount: number;
  };
  totalDurationMs: number;
}
