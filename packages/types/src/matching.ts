/**
 * 智能匹配系统类型定义。
 *
 * 三阶段匹配架构（禁止退化为单条 SQL WHERE）：
 *   阶段 1  Hard Filter        —— 硬性条件筛除（区域/预算/户型/面积/状态/产权）
 *   阶段 2  Preference Score   —— 显性需求 + 行为画像加权打分
 *   阶段 3  AI Reranking       —— 对 Top N 做语义重排与理由生成
 */

/** 匹配阶段标识，用于可解释性与调试 */
export enum MatchStage {
  HARD_FILTER = 'HARD_FILTER',
  PREFERENCE_SCORE = 'PREFERENCE_SCORE',
  VECTOR_SIMILARITY = 'VECTOR_SIMILARITY',
  AI_RERANK = 'AI_RERANK',
}

export const MATCH_STAGE_LABELS: Record<MatchStage, string> = {
  [MatchStage.HARD_FILTER]: '硬性条件筛选',
  [MatchStage.PREFERENCE_SCORE]: '偏好打分',
  [MatchStage.VECTOR_SIMILARITY]: '语义相似度',
  [MatchStage.AI_RERANK]: 'AI 重排',
};

/** 匹配等级，按分数区间划分 */
export enum MatchLevel {
  /** 90～100 极高匹配 */
  PERFECT = 'PERFECT',
  /** 80～89 高度匹配 */
  HIGH = 'HIGH',
  /** 65～79 较为匹配 */
  MEDIUM = 'MEDIUM',
  /** 50～64 一般 */
  LOW = 'LOW',
  /** < 50 弱匹配 */
  WEAK = 'WEAK',
}

export const MATCH_LEVEL_LABELS: Record<MatchLevel, string> = {
  [MatchLevel.PERFECT]: '极高匹配',
  [MatchLevel.HIGH]: '高度匹配',
  [MatchLevel.MEDIUM]: '较为匹配',
  [MatchLevel.LOW]: '一般匹配',
  [MatchLevel.WEAK]: '弱匹配',
};

/** 按 0～100 分计算匹配等级 */
export function toMatchLevel(score: number): MatchLevel {
  if (score >= 90) return MatchLevel.PERFECT;
  if (score >= 80) return MatchLevel.HIGH;
  if (score >= 65) return MatchLevel.MEDIUM;
  if (score >= 50) return MatchLevel.LOW;
  return MatchLevel.WEAK;
}

/** 各评分维度权重。可在后台配置，默认值见 DEFAULT_MATCH_WEIGHTS */
export interface MatchWeights {
  /** 区域匹配 */
  district: number;
  /** 小区匹配 */
  community: number;
  /** 预算匹配 */
  budget: number;
  /** 面积匹配 */
  area: number;
  /** 户型匹配 */
  bedrooms: number;
  /** 装修匹配 */
  decoration: number;
  /** 房龄/建成年份匹配 */
  buildYear: number;
  /** 楼层匹配 */
  floor: number;
  /** 地铁距离匹配 */
  subway: number;
  /** 学区匹配 */
  school: number;
  /** 通勤匹配 */
  commute: number;
  /** 朝向匹配 */
  orientation: number;
  /** 行为画像匹配（最重要，权重最高） */
  behavioral: number;
}

/**
 * 默认权重。总和在打分时归一化，因此不必等于 100。
 * 行为画像权重最高 —— 这是产品「理解客户」的核心体现。
 */
export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  district: 14,
  community: 8,
  budget: 20,
  area: 10,
  bedrooms: 10,
  decoration: 5,
  buildYear: 5,
  floor: 3,
  subway: 7,
  school: 6,
  commute: 4,
  orientation: 2,
  behavioral: 18,
};

/** 单条可解释理由 */
export interface MatchReason {
  /** 维度键，如 "bedrooms" */
  key: string;
  /** 展示文案，如「三房」 */
  label: string;
  /** 命中的具体值，如 "3" */
  value: string;
  /** 该维度得分 0～1 */
  score: number;
  /** 该维度权重 */
  weight: number;
  /** 该理由对总分的贡献（加权后），便于前端按贡献排序 */
  contribution: number;
  /** 来源：显性需求 / 行为画像 / 房源客观属性 */
  source: 'EXPLICIT' | 'BEHAVIORAL' | 'PROPERTY';
  /** 是否为必须满足的硬性条件 */
  isHardRequirement: boolean;
}

/** AI 行为依据 —— 用数据说话，而非空泛描述 */
export interface BehaviorEvidence {
  /** 结论文案，如「客户最近 14 天 68% 的浏览为 100～110㎡」 */
  statement: string;
  /** 支撑数据 */
  metric: {
    /** 指标名 */
    name: string;
    /** 数值 */
    value: number;
    /** 单位 */
    unit?: string;
    /** 样本量 */
    sampleSize: number;
  };
}

/** 单条房源的匹配结果 */
export interface PropertyMatchResult {
  propertyId: string;
  /** 房源摘要，避免前端二次请求（列表场景） */
  propertySummary: {
    title: string;
    community: string;
    district: string;
    totalPrice: number;
    area: number;
    bedrooms: number;
    decoration: DecorationLike | null;
    buildYear: number | null;
    subwayDistance: number | null;
    coverImage: string | null;
  };
  /** 总分 0～100 */
  score: number;
  level: MatchLevel;
  /** 各维度得分明细 */
  reasons: MatchReason[];
  /** 命中的加分项（面向销售的简版清单） */
  highlights: string[];
  /** 不符合项（如超出预算 3%） */
  concerns: string[];
  /** AI 行为依据 */
  behaviorEvidence: BehaviorEvidence[];
  /** 一句话推荐理由（AI 生成，若 AI 不可用则为规则拼接） */
  recommendation: string;
  /** 使用的匹配阶段（默认全部启用时含 AI_RERANK） */
  stagesApplied: MatchStage[];
  /** 硬性条件是否通过 */
  passedHardFilter: boolean;
  /** 硬性条件未通过时的原因 */
  hardFilterFailures: string[];
  generatedAt: string;
}

/** 避免与 property.ts 循环引用，这里用宽松类型 */
type DecorationLike = string;

/** 单个客户的匹配结果集（Customer → Property） */
export interface CustomerMatchResponse {
  customerId: string;
  /** 参与硬筛的候选池大小 */
  candidatePoolSize: number;
  /** 进入打分的数量 */
  scoredCount: number;
  /** 进入 AI 重排的数量 */
  rerankedCount: number;
  /** 最终结果，按分数降序 */
  matches: PropertyMatchResult[];
  /** 本次匹配使用的权重 */
  weights: MatchWeights;
  /** 是否使用的是行为画像（true 表示客户有足够行为数据） */
  usedBehavioralProfile: boolean;
  /** 行为画像置信度 */
  behavioralConfidence: number;
  /** AI 是否可用；不可用时结果仍完整，仅缺少 AI 生成的推荐语 */
  aiAvailable: boolean;
  generatedAt: string;
  durationMs: number;
}

/** 反向匹配的单条结果（Property → Customer） */
export interface CustomerMatchCandidate {
  customerId: string;
  customerName: string;
  /** 脱敏手机号，如 138****8888 */
  phoneMasked: string;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  score: number;
  level: MatchLevel;
  highlights: string[];
  concerns: string[];
  /** 该客户是否正是当前经纪人负责，用于排序置顶 */
  isOwnCustomer: boolean;
  /** 客户当前状态与意向分 */
  status: string;
  intentScore: number | null;
}

/** 单套房源的反向匹配结果集（Property → Customer） */
export interface PropertyMatchResponse {
  propertyId: string;
  /** 参与扫描的客户池大小 */
  candidatePoolSize: number;
  matches: CustomerMatchCandidate[];
  generatedAt: string;
  durationMs: number;
}

/** 匹配任务触发原因，用于日志与调试 */
export enum MatchTrigger {
  /** 客户资料变更 */
  CUSTOMER_UPDATED = 'CUSTOMER_UPDATED',
  /** 客户行为更新导致画像变化 */
  BEHAVIOR_UPDATED = 'BEHAVIOR_UPDATED',
  /** 新客户创建 */
  CUSTOMER_CREATED = 'CUSTOMER_CREATED',
  /** 房源新增 */
  PROPERTY_CREATED = 'PROPERTY_CREATED',
  /** 房源价格变化 */
  PRICE_CHANGED = 'PRICE_CHANGED',
  /** 房源状态变化 */
  STATUS_CHANGED = 'STATUS_CHANGED',
  /** 手动触发 */
  MANUAL = 'MANUAL',
  /** 定时全量重算 */
  SCHEDULED = 'SCHEDULED',
}
