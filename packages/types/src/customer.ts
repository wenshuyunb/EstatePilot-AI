/**
 * 客户领域模型：客户档案、显性需求（Explicit Profile）、行为画像（Behavioral Profile）。
 *
 * 设计要点：
 * - ExplicitProfile  = 客户自己说的需求（销售录入）
 * - BehavioralProfile = AI 根据真实行为推断的需求（系统计算）
 * 系统必须同时维护两套，并在界面上明确区分「客户说的」与「AI 观察到的」。
 */

/** 客户生命周期状态 */
export enum CustomerStatus {
  /** 新客户，尚未跟进 */
  NEW = 'NEW',
  /** 跟进中 */
  FOLLOWING = 'FOLLOWING',
  /** 高意向 */
  HIGH_INTENT = 'HIGH_INTENT',
  /** 已进入带看阶段 */
  VIEWING = 'VIEWING',
  /** 谈判中 */
  NEGOTIATING = 'NEGOTIATING',
  /** 已成交 */
  DEAL = 'DEAL',
  /** 已流失 */
  LOST = 'LOST',
  /** 沉睡（长期无互动，可被重新激活） */
  DORMANT = 'DORMANT',
}

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  [CustomerStatus.NEW]: '新客户',
  [CustomerStatus.FOLLOWING]: '跟进中',
  [CustomerStatus.HIGH_INTENT]: '高意向',
  [CustomerStatus.VIEWING]: '带看中',
  [CustomerStatus.NEGOTIATING]: '谈判中',
  [CustomerStatus.DEAL]: '已成交',
  [CustomerStatus.LOST]: '已流失',
  [CustomerStatus.DORMANT]: '沉睡客户',
};

/**
 * 合法状态流转。Service 层必须校验，禁止任意跳转。
 * 例：NEW 可以直接变 LOST；但 DEAL 不能再退回 NEW。
 */
export const CUSTOMER_STATUS_TRANSITIONS: Record<CustomerStatus, readonly CustomerStatus[]> = {
  [CustomerStatus.NEW]: [
    CustomerStatus.FOLLOWING,
    CustomerStatus.HIGH_INTENT,
    CustomerStatus.DORMANT,
    CustomerStatus.LOST,
  ],
  [CustomerStatus.FOLLOWING]: [
    CustomerStatus.HIGH_INTENT,
    CustomerStatus.VIEWING,
    CustomerStatus.DORMANT,
    CustomerStatus.LOST,
  ],
  [CustomerStatus.HIGH_INTENT]: [
    CustomerStatus.VIEWING,
    CustomerStatus.NEGOTIATING,
    CustomerStatus.FOLLOWING,
    CustomerStatus.DORMANT,
    CustomerStatus.LOST,
  ],
  [CustomerStatus.VIEWING]: [
    CustomerStatus.NEGOTIATING,
    CustomerStatus.HIGH_INTENT,
    CustomerStatus.DORMANT,
    CustomerStatus.LOST,
  ],
  [CustomerStatus.NEGOTIATING]: [
    CustomerStatus.DEAL,
    CustomerStatus.VIEWING,
    CustomerStatus.HIGH_INTENT,
    CustomerStatus.LOST,
  ],
  [CustomerStatus.DEAL]: [],
  [CustomerStatus.LOST]: [CustomerStatus.FOLLOWING, CustomerStatus.NEW],
  [CustomerStatus.DORMANT]: [
    CustomerStatus.FOLLOWING,
    CustomerStatus.HIGH_INTENT,
    CustomerStatus.LOST,
  ],
};

/** 判断状态流转是否合法 */
export function canTransitionCustomerStatus(from: CustomerStatus, to: CustomerStatus): boolean {
  if (from === to) return true;
  return CUSTOMER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 意向等级（销售的人工判断，与 AI 计算的 intentScore 区分开） */
export enum IntentLevel {
  A = 'A',
  B = 'B',
  C = 'C',
  D = 'D',
}

export const INTENT_LEVEL_LABELS: Record<IntentLevel, string> = {
  [IntentLevel.A]: 'A 类 · 强烈意向',
  [IntentLevel.B]: 'B 类 · 明确意向',
  [IntentLevel.C]: 'C 类 · 一般意向',
  [IntentLevel.D]: 'D 类 · 观望',
};

/** 客户来源渠道 */
export enum CustomerSource {
  PORTAL = 'PORTAL',
  /** 线上平台（贝壳/安居客等）来的线索 */
  ONLINE_PLATFORM = 'ONLINE_PLATFORM',
  WALK_IN = 'WALK_IN',
  REFERRAL = 'REFERRAL',
  PHONE_IN = 'PHONE_IN',
  WECHAT = 'WECHAT',
  OLD_CUSTOMER = 'OLD_CUSTOMER',
  COMMUNITY_EVENT = 'COMMUNITY_EVENT',
  ADVERTISEMENT = 'ADVERTISEMENT',
  OTHER = 'OTHER',
}

export const CUSTOMER_SOURCE_LABELS: Record<CustomerSource, string> = {
  [CustomerSource.PORTAL]: '门店到访',
  [CustomerSource.ONLINE_PLATFORM]: '线上平台',
  [CustomerSource.WALK_IN]: '自然到店',
  [CustomerSource.REFERRAL]: '老客户转介',
  [CustomerSource.PHONE_IN]: '电话咨询',
  [CustomerSource.WECHAT]: '微信咨询',
  [CustomerSource.OLD_CUSTOMER]: '老客户复购',
  [CustomerSource.COMMUNITY_EVENT]: '社区活动',
  [CustomerSource.ADVERTISEMENT]: '广告投放',
  [CustomerSource.OTHER]: '其他',
};

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  UNKNOWN = 'UNKNOWN',
}

export const GENDER_LABELS: Record<Gender, string> = {
  [Gender.MALE]: '男',
  [Gender.FEMALE]: '女',
  [Gender.UNKNOWN]: '未知',
};

/** 购房目的 */
export enum PurchasePurpose {
  SELF_LIVE = 'SELF_LIVE',
  IMPROVE = 'IMPROVE',
  /** 学区 */
  SCHOOL = 'SCHOOL',
  INVESTMENT = 'INVESTMENT',
  /** 婚房 */
  MARRIAGE = 'MARRIAGE',
  ELDERLY_CARE = 'ELDERLY_CARE',
  OTHER = 'OTHER',
}

export const PURCHASE_PURPOSE_LABELS: Record<PurchasePurpose, string> = {
  [PurchasePurpose.SELF_LIVE]: '刚需自住',
  [PurchasePurpose.IMPROVE]: '改善置换',
  [PurchasePurpose.SCHOOL]: '学区房',
  [PurchasePurpose.INVESTMENT]: '投资',
  [PurchasePurpose.MARRIAGE]: '婚房',
  [PurchasePurpose.ELDERLY_CARE]: '养老',
  [PurchasePurpose.OTHER]: '其他',
};

/** 付款方式 */
export enum PaymentMethod {
  FULL = 'FULL',
  MORTGAGE = 'MORTGAGE',
  /** 组合贷 */
  COMBINED = 'COMBINED',
  /** 公积金 */
  HOUSING_FUND = 'HOUSING_FUND',
  UNKNOWN = 'UNKNOWN',
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.FULL]: '全款',
  [PaymentMethod.MORTGAGE]: '商业贷款',
  [PaymentMethod.COMBINED]: '组合贷款',
  [PaymentMethod.HOUSING_FUND]: '公积金贷款',
  [PaymentMethod.UNKNOWN]: '未确定',
};

/** 贷款审批状态 —— 直接影响成交概率 */
export enum LoanStatus {
  NOT_STARTED = 'NOT_STARTED',
  PREPARING = 'PREPARING',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  NOT_NEEDED = 'NOT_NEEDED',
}

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  [LoanStatus.NOT_STARTED]: '未开始',
  [LoanStatus.PREPARING]: '准备材料',
  [LoanStatus.SUBMITTED]: '已提交',
  [LoanStatus.APPROVED]: '已批贷',
  [LoanStatus.REJECTED]: '被拒',
  [LoanStatus.NOT_NEEDED]: '无需贷款',
};

/** 购房时间计划 */
export enum PurchaseTimeline {
  URGENT = 'URGENT',
  ONE_MONTH = 'ONE_MONTH',
  THREE_MONTHS = 'THREE_MONTHS',
  HALF_YEAR = 'HALF_YEAR',
  ONE_YEAR = 'ONE_YEAR',
  UNDECIDED = 'UNDECIDED',
}

export const PURCHASE_TIMELINE_LABELS: Record<PurchaseTimeline, string> = {
  [PurchaseTimeline.URGENT]: '一周内',
  [PurchaseTimeline.ONE_MONTH]: '1 个月内',
  [PurchaseTimeline.THREE_MONTHS]: '3 个月内',
  [PurchaseTimeline.HALF_YEAR]: '半年内',
  [PurchaseTimeline.ONE_YEAR]: '一年内',
  [PurchaseTimeline.UNDECIDED]: '未确定',
};

/** 楼层偏好 */
export enum FloorPreference {
  LOW = 'LOW',
  MIDDLE = 'MIDDLE',
  HIGH = 'HIGH',
  TOP = 'TOP',
  ANY = 'ANY',
}

export const FLOOR_PREFERENCE_LABELS: Record<FloorPreference, string> = {
  [FloorPreference.LOW]: '低楼层',
  [FloorPreference.MIDDLE]: '中楼层',
  [FloorPreference.HIGH]: '高楼层',
  [FloorPreference.TOP]: '顶楼',
  [FloorPreference.ANY]: '不限',
};

/** 装修偏好 */
export enum DecorationPreference {
  ROUGH = 'ROUGH',
  SIMPLE = 'SIMPLE',
  FINE = 'FINE',
  LUXURY = 'LUXURY',
  ANY = 'ANY',
}

export const DECORATION_PREFERENCE_LABELS: Record<DecorationPreference, string> = {
  [DecorationPreference.ROUGH]: '毛坯',
  [DecorationPreference.SIMPLE]: '简装',
  [DecorationPreference.FINE]: '精装',
  [DecorationPreference.LUXURY]: '豪装',
  [DecorationPreference.ANY]: '不限',
};

/** 房龄偏好 */
export enum PropertyAgePreference {
  WITHIN_5 = 'WITHIN_5',
  WITHIN_10 = 'WITHIN_10',
  WITHIN_20 = 'WITHIN_20',
  ANY = 'ANY',
}

export const PROPERTY_AGE_PREFERENCE_LABELS: Record<PropertyAgePreference, string> = {
  [PropertyAgePreference.WITHIN_5]: '5 年内',
  [PropertyAgePreference.WITHIN_10]: '10 年内',
  [PropertyAgePreference.WITHIN_20]: '20 年内',
  [PropertyAgePreference.ANY]: '不限',
};

/** 通勤地点（上班/上学地址，用于通勤时间计算） */
export interface CommuteLocation {
  /** 地点名称，如「张江高科地铁站」 */
  label: string;
  longitude?: number;
  latitude?: number;
  /** 客户能接受的最长通勤分钟数 */
  maxMinutes?: number;
}

/**
 * 显性需求画像 —— 客户自己说的。
 * 与 Property 的字段一一对应，便于硬筛。
 */
export interface ExplicitProfile {
  budgetMin: number | null;
  budgetMax: number | null;
  preferredCity: string | null;
  preferredDistricts: string[];
  preferredCommunities: string[];
  bedrooms: number[];
  livingRooms: number | null;
  areaMin: number | null;
  areaMax: number | null;
  propertyAgePreference: PropertyAgePreference | null;
  floorPreference: FloorPreference | null;
  decorationPreference: DecorationPreference | null;
  /** 学区要求描述，如「对口明珠小学」 */
  schoolPreference: string | null;
  /** 地铁要求：可接受的最远步行米数 */
  subwayDistanceMax: number | null;
  commuteLocations: CommuteLocation[];
  purchasePurpose: PurchasePurpose | null;
  paymentMethod: PaymentMethod | null;
  /** 首付预算 */
  downPaymentBudget: number | null;
  loanRequirement: string | null;
  purchaseTimeline: PurchaseTimeline | null;
}

/** 单个偏好维度的得分 */
export interface PreferenceScoreItem {
  /** 维度标识，如 "district" / "decoration" */
  key: string;
  /** 具体取值，如 "张江" / "FINE" */
  value: string;
  /** 归一化得分 0～1 */
  score: number;
  /** 产生该得分的证据条数 */
  evidenceCount: number;
}

/** 区间型偏好（价格、面积） */
export interface RangePreference {
  min: number;
  max: number;
  /** 置信度 0～1 */
  confidence: number;
  /** 样本量 */
  sampleSize: number;
}

/**
 * 行为画像 —— AI 观察到的真实需求。
 * 计算逻辑见 Phase 4；结构即为对外 API 返回结构。
 */
export interface BehavioralProfile {
  /** 实际可接受总价区间（通常高于客户自报预算） */
  budget: RangePreference | null;
  /** 实际可接受面积区间 */
  area: RangePreference | null;
  /** 实际可接受单价区间 */
  unitPrice: RangePreference | null;
  /** 区域偏好排序 */
  districtPreference: PreferenceScoreItem[];
  /** 小区偏好排序 */
  communityPreference: PreferenceScoreItem[];
  /** 户型偏好（如 {"3":0.72}） */
  bedroomPreference: PreferenceScoreItem[];
  /** 装修偏好 */
  decorationPreference: PreferenceScoreItem[];
  /** 房龄偏好（按年代段） */
  buildYearPreference: PreferenceScoreItem[];
  /** 楼层偏好 */
  floorPreference: PreferenceScoreItem[];
  /** 朝向偏好 */
  orientationPreference: PreferenceScoreItem[];
  /** 地铁距离偏好 */
  subwayPreference: PreferenceScoreItem[];
  /** 学区关注度 */
  schoolPreference: PreferenceScoreItem[];
  /** 通勤关注度 */
  commutePreference: PreferenceScoreItem[];
  /** 物业关注度 */
  propertyManagementPreference: PreferenceScoreItem[];
  /** 整体置信度 0～1 */
  confidence: number;
  /** 参与计算的样本量（行为事件数） */
  sampleSize: number;
  /** 统计窗口起始 */
  windowStart: string;
  /** 统计窗口结束 */
  windowEnd: string;
  /** AI 生成的自然语言小结 */
  reasoningSummary: string | null;
}

/** 需求漂移维度对比项 */
export interface DriftDimension {
  /** 维度标识 */
  key: string;
  /** 维度显示名 */
  label: string;
  /** 基线窗口（如过去 30 天）的取值/分布 */
  baseline: PreferenceScoreItem[];
  /** 近期窗口（如最近 7 天）的取值/分布 */
  recent: PreferenceScoreItem[];
  /** 漂移强度 0～1，越大变化越明显 */
  driftScore: number;
  /** 人类可读的漂移描述 */
  description: string;
}

/** 需求变化检测结果 */
export interface PreferenceDriftResult {
  customerId: string;
  /** 是否检测到明显变化 */
  hasDrift: boolean;
  /** 基线窗口天数 */
  baselineDays: number;
  /** 近期窗口天数 */
  recentDays: number;
  /** 预算漂移 */
  budgetShift: {
    from: RangePreference | null;
    to: RangePreference | null;
    /** 变化幅度（元） */
    deltaMin: number;
    deltaMax: number;
  } | null;
  /** 各维度漂移明细 */
  dimensions: DriftDimension[];
  /** 给销售的明确建议，如「减少发送金桥老小区，优先推荐张江 2015 年以后三房」 */
  recommendation: string;
  /** 置信度 0～1 */
  confidence: number;
  detectedAt: string;
}
