/**
 * API 通用约定：分页、统一响应包装、错误码、搜索、Dashboard 数据结构。
 */

// ---------------------------------------------------------------------------
// 通用响应
// ---------------------------------------------------------------------------

/** 分页查询参数 */
export interface PaginationQuery {
  page?: number;
  pageSize?: number;
  /** 排序字段 */
  sortBy?: string;
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc';
}

/** 分页结果 */
export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** 统一错误码 */
export enum ApiErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSED = 'REFRESH_TOKEN_REUSED',
  FORBIDDEN = 'FORBIDDEN',
  /** 跨组织访问被拒绝 —— 多租户隔离的核心错误码 */
  TENANT_MISMATCH = 'TENANT_MISMATCH',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  LINK_EXPIRED = 'LINK_EXPIRED',
  LINK_REVOKED = 'LINK_REVOKED',
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  PROVIDER_NOT_CONFIGURED = 'PROVIDER_NOT_CONFIGURED',
  AI_UNAVAILABLE = 'AI_UNAVAILABLE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  // ---------------------------------------------------------------------
  // 微信复制 → AI 需求 → 贝壳 → 推荐 闭环（Phase 11）
  // 每个阶段都有明确错误类型，前端据此给出人能理解的中文提示
  // ---------------------------------------------------------------------

  /** 粘贴内容为空 */
  MESSAGE_EMPTY = 'MESSAGE_EMPTY',
  /** 客户不存在或无权访问 */
  CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND',
  /** AI 未能从消息中解析出需求 */
  REQUIREMENT_PARSE_FAILED = 'REQUIREMENT_PARSE_FAILED',
  /** 缺少城市信息，无法搜索（不能让 AI 编） */
  MISSING_LOCATION = 'MISSING_LOCATION',
  /** 需求字段校验失败 */
  REQUIREMENT_INVALID = 'REQUIREMENT_INVALID',
  /** 贝壳服务暂时不可达 —— 需求已保存，只需重试房源查询 */
  BEIKE_UNAVAILABLE = 'BEIKE_UNAVAILABLE',
  /** 贝壳凭证未配置 */
  BEIKE_NOT_CONFIGURED = 'BEIKE_NOT_CONFIGURED',
  /** 贝壳查询失败（非网络原因） */
  BEIKE_SEARCH_FAILED = 'BEIKE_SEARCH_FAILED',
  /** 严格条件下无匹配房源，需放宽某条件 */
  NO_PROPERTIES_FOUND = 'NO_PROPERTIES_FOUND',
  /** 房源详情补全失败 */
  DETAIL_FETCH_FAILED = 'DETAIL_FETCH_FAILED',
  /** 匹配打分失败 */
  MATCHING_FAILED = 'MATCHING_FAILED',
  /** AI 生成微信文案失败 */
  AI_REPLY_FAILED = 'AI_REPLY_FAILED',
  /** 推荐批次不存在 */
  RECOMMENDATION_NOT_FOUND = 'RECOMMENDATION_NOT_FOUND',
}

/** 统一错误响应体 */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  /** 字段级校验错误 */
  details?: Array<{ field: string; message: string }>;
  /** 请求追踪 ID，便于对照日志 */
  traceId?: string;
}

// ---------------------------------------------------------------------------
// 全局搜索
// ---------------------------------------------------------------------------

export enum SearchResultType {
  CUSTOMER = 'CUSTOMER',
  PROPERTY = 'PROPERTY',
  COMMUNITY = 'COMMUNITY',
  DISTRICT = 'DISTRICT',
  AGENT = 'AGENT',
}

export const SEARCH_RESULT_TYPE_LABELS: Record<SearchResultType, string> = {
  [SearchResultType.CUSTOMER]: '客户',
  [SearchResultType.PROPERTY]: '房源',
  [SearchResultType.COMMUNITY]: '小区',
  [SearchResultType.DISTRICT]: '区域',
  [SearchResultType.AGENT]: '经纪人',
};

/** 单条搜索结果 */
export interface SearchResultItem {
  type: SearchResultType;
  id: string;
  /** 主标题 */
  title: string;
  /** 副标题（如区域+价格、脱敏手机号） */
  subtitle: string | null;
  /** 点击跳转路由 */
  link: string;
  /** 附加信息 */
  meta: Record<string, string | number | null>;
}

/** 全局搜索响应 */
export interface GlobalSearchResponse {
  query: string;
  groups: Array<{
    type: SearchResultType;
    label: string;
    items: SearchResultItem[];
    total: number;
  }>;
  totalHits: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 经纪人首页 Dashboard —— 以「今天做什么」为核心，不是传统 ERP 首页
// ---------------------------------------------------------------------------

/** 首页「今日 AI 发现」条目 */
export interface DashboardDiscovery {
  /** 统计键 */
  key: string;
  /** 展示文案，如「3 套客户关注房源降价」 */
  label: string;
  count: number;
  /** 点击后跳转 */
  link: string;
  /** 视觉强调级别 */
  emphasis: 'PRIMARY' | 'SECONDARY';
}

/** 首页重点客户卡片 */
export interface DashboardPriorityCustomer {
  customerId: string;
  name: string;
  /** 脱敏手机号 */
  phoneMasked: string;
  status: string;
  intentLevel: string | null;
  /** AI 意向分 0～100 */
  intentScore: number;
  /** 为什么要联系他 */
  reason: string;
  /** 建议怎么做 */
  suggestion: string;
  /** 建议联系时间，如「上午 10 点前」 */
  suggestedContactBy: string | null;
  /** 主要机会类型 */
  topOpportunityType: string | null;
  topOpportunityPriority: string | null;
  /** 关联机会 ID，便于一键处理 */
  opportunityId: string | null;
  /** 最近活动时间 */
  lastActiveAt: string | null;
  /** 未跟进天数 */
  daysSinceLastContact: number | null;
}

/** 今日带看条目 */
export interface DashboardViewingItem {
  viewingId: string;
  customerId: string;
  customerName: string;
  scheduledAt: string;
  status: string;
  propertyCount: number;
  /** 首个房源标题，便于快速识别 */
  firstPropertyTitle: string | null;
}

/** 首页待跟进条目 */
export interface DashboardFollowUpItem {
  customerId: string;
  customerName: string;
  phoneMasked: string;
  /** 超期天数；0 表示今天到期 */
  overdueDays: number;
  reason: string;
  lastContactAt: string | null;
  intentScore: number;
}

/** 经纪人首页数据 */
export interface AgentDashboard {
  /** 问候语，如「早上好，张伟」 */
  greeting: string;
  agentName: string;
  /** 今日日期 */
  today: string;
  /** 今日 AI 发现 —— 首页最核心模块 */
  discoveries: DashboardDiscovery[];
  /** 今日重点客户 */
  priorityCustomers: DashboardPriorityCustomer[];
  /** 今日带看 */
  todayViewings: DashboardViewingItem[];
  /** 待跟进（含超期） */
  followUps: DashboardFollowUpItem[];
  /** 高意向客户数 */
  highIntentCount: number;
  /** 我的客户总数 */
  myCustomerCount: number;
  /** 未读通知数 */
  unreadNotificationCount: number;
  /** AI 是否可用；不可用时界面需标注 */
  aiAvailable: boolean;
  generatedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 店长驾驶舱
// ---------------------------------------------------------------------------

/** 门店核心指标 */
export interface StoreMetrics {
  totalCustomers: number;
  highIntentCustomers: number;
  newCustomersToday: number;
  /** 今日已跟进次数 */
  followUpsToday: number;
  /** 今日遗漏跟进数 */
  missedFollowUpsToday: number;
  viewingsToday: number;
  viewingsThisMonth: number;
  negotiationsThisMonth: number;
  dealsThisMonth: number;
  /** 30 天成交预测（套数） */
  forecastDeals30Days: number;
  /** 30 天预测成交额（元） */
  forecastRevenue30Days: number;
}

/** 单个经纪人的表现 */
export interface AgentPerformance {
  agentId: string;
  agentName: string;
  avatarUrl: string | null;
  /** 负责客户数 */
  customerCount: number;
  /** 联系次数 */
  contactCount: number;
  /** 带看次数 */
  viewingCount: number;
  /** 进入谈判数 */
  negotiationCount: number;
  /** 成交数 */
  dealCount: number;
  /** 各环节转化率 */
  funnel: {
    customerToViewing: number;
    viewingToNegotiation: number;
    negotiationToDeal: number;
    /** 客户到成交的总转化率 */
    overallConversion: number;
  };
  /** 平均跟进间隔（天） */
  avgFollowUpIntervalDays: number | null;
  /** AI 诊断结论 */
  diagnosis: AgentDiagnosis | null;
}

/** AI 对经纪人漏斗的诊断 */
export interface AgentDiagnosis {
  /** 表现正常的环节 */
  healthyStages: string[];
  /** 表现薄弱的环节 */
  weakStages: string[];
  /** 主要问题定位，如「成交推进能力」 */
  primaryIssue: string;
  /** 具体说明 */
  detail: string;
  /** 改进建议 */
  suggestions: string[];
  /** 置信度 */
  confidence: number;
  aiGenerated: boolean;
}

/** 店长驾驶舱数据 */
export interface StoreDashboard {
  storeId: string;
  storeName: string;
  metrics: StoreMetrics;
  /** 经纪人表现列表，按成交降序 */
  agents: AgentPerformance[];
  /** 全店漏斗 */
  funnel: {
    customers: number;
    viewings: number;
    negotiations: number;
    deals: number;
  };
  /** 近 30 天每日趋势，用于图表 */
  trend: Array<{
    date: string;
    newCustomers: number;
    followUps: number;
    viewings: number;
    deals: number;
  }>;
  /** 客户状态分布 */
  statusDistribution: Array<{ status: string; label: string; count: number }>;
  aiAvailable: boolean;
  generatedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 客户成交概率
// ---------------------------------------------------------------------------

/** 成交概率评分的单个贡献因子 */
export interface IntentScoreFactor {
  key: string;
  label: string;
  /** 该因子原始得分 0～100 */
  rawScore: number;
  /** 权重 */
  weight: number;
  /** 加权贡献 */
  contribution: number;
  /** 说明 */
  explanation: string;
}

/** 客户成交概率（AI 辅助判断，非承诺） */
export interface CustomerIntentScore {
  customerId: string;
  /** 0～100 */
  score: number;
  /** 等级标签 */
  level: 'HOT' | 'WARM' | 'COOL' | 'COLD';
  levelLabel: string;
  factors: IntentScoreFactor[];
  /** 一句话结论 */
  summary: string;
  aiGenerated: boolean;
  /** 免责声明，必填 */
  disclaimer: string;
  calculatedAt: string;
}

export const INTENT_SCORE_LEVEL_LABELS: Record<CustomerIntentScore['level'], string> = {
  HOT: '热（建议优先跟进）',
  WARM: '温（保持节奏）',
  COOL: '凉（需要激活）',
  COLD: '冷（低优先级）',
};

// ---------------------------------------------------------------------------
// 分页默认值
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 归一化分页参数，防止超大 pageSize 拖垮数据库 */
export function normalizePagination(query: PaginationQuery): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const requested = Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
