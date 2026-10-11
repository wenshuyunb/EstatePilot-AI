/**
 * 客户需求领域模型 —— 微信复制 → AI 需求 → 贝壳 → 推荐闭环的核心契约。
 *
 * 设计要点（对应需求文档 §7~§12）：
 *
 * 1. **三级预算模型**是这一层最关键的设计。
 *    客户的需求是一句一句透露的，绝不能互相覆盖：
 *      "预算500万"            → budgetTarget = 500
 *      "550也可以"             → budgetTarget 仍 500，budgetNormalMax = 550
 *      "特别好的600也能考虑"    → budgetStretchMax = 600
 *    如果只存一个 budgetMax，最后一句会把前面全部信息冲掉。
 *
 * 2. **区分「硬条件」与「软偏好」**。
 *    硬条件（budgetStrictMax、bedroomsStrict、明确区域）由确定性代码过滤，AI 无权放宽；
 *    软偏好（房龄、地铁、小区环境）进入打分，权重可配置。
 *    这样做的原因：AI 觉得某套房"很好"就推荐一套超预算的房子，是产品不可接受的错误。
 *
 * 3. **覆盖词识别**。
 *    "现在只要三房""改成两房""不要了""最多520"这类表达具有**覆盖语义**，
 *    必须标记为 override，让历史值被替换而不是累加。
 */

import type { JsonSchema } from './ai.js';

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/** 维度优先级 */
export enum PreferencePriority {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  /** 客户未提及 */
  UNKNOWN = 'UNKNOWN',
}

export const PREFERENCE_PRIORITY_LABELS: Record<PreferencePriority, string> = {
  [PreferencePriority.HIGH]: '很在意',
  [PreferencePriority.MEDIUM]: '一般',
  [PreferencePriority.LOW]: '不太在意',
  [PreferencePriority.UNKNOWN]: '未提及',
};

/** 房龄偏好 */
export enum BuildingAgePreference {
  /** 越新越好 */
  NEWER = 'NEWER',
  /** 5 年内 */
  WITHIN_5 = 'WITHIN_5',
  /** 10 年内 */
  WITHIN_10 = 'WITHIN_10',
  /** 20 年内 */
  WITHIN_20 = 'WITHIN_20',
  /** 无所谓 */
  ANY = 'ANY',
}

export const BUILDING_AGE_LABELS: Record<BuildingAgePreference, string> = {
  [BuildingAgePreference.NEWER]: '偏新',
  [BuildingAgePreference.WITHIN_5]: '5 年内',
  [BuildingAgePreference.WITHIN_10]: '10 年内',
  [BuildingAgePreference.WITHIN_20]: '20 年内',
  [BuildingAgePreference.ANY]: '不限',
};

/** 装修偏好 */
export enum DecorationPreferenceLevel {
  ROUGH = 'ROUGH',
  SIMPLE = 'SIMPLE',
  FINE = 'FINE',
  LUXURY = 'LUXURY',
  ANY = 'ANY',
}

/** 装修偏好（需求抽取场景下的标签，与 customer.ts 的录入偏好区分开） */
export const REQUIREMENT_DECORATION_LABELS: Record<DecorationPreferenceLevel, string> = {
  [DecorationPreferenceLevel.ROUGH]: '毛坯',
  [DecorationPreferenceLevel.SIMPLE]: '简装',
  [DecorationPreferenceLevel.FINE]: '精装',
  [DecorationPreferenceLevel.LUXURY]: '豪装',
  [DecorationPreferenceLevel.ANY]: '不限',
};

/** 楼层偏好 */
export enum RequirementFloorPreference {
  LOW = 'LOW',
  MIDDLE = 'MIDDLE',
  HIGH = 'HIGH',
  /** 中高楼层 */
  MIDDLE_HIGH = 'MIDDLE_HIGH',
  ANY = 'ANY',
}

export const REQUIREMENT_FLOOR_LABELS: Record<RequirementFloorPreference, string> = {
  [RequirementFloorPreference.LOW]: '低楼层',
  [RequirementFloorPreference.MIDDLE]: '中间楼层',
  [RequirementFloorPreference.HIGH]: '高楼层',
  [RequirementFloorPreference.MIDDLE_HIGH]: '中高楼层',
  [RequirementFloorPreference.ANY]: '不限',
};

/** 决策参与者 */
export enum DecisionMaker {
  SELF = 'SELF',
  SPOUSE = 'SPOUSE',
  PARENTS = 'PARENTS',
  CHILD = 'CHILD',
  OTHER = 'OTHER',
}

export const DECISION_MAKER_LABELS: Record<DecisionMaker, string> = {
  [DecisionMaker.SELF]: '本人',
  [DecisionMaker.SPOUSE]: '配偶',
  [DecisionMaker.PARENTS]: '父母',
  [DecisionMaker.CHILD]: '子女',
  [DecisionMaker.OTHER]: '其他家人',
};

/** 需求变更类型 */
export enum RequirementChangeType {
  /** 首次提出（原来没有） */
  ADDED = 'ADDED',
  /** 在原有基础上放宽/收紧范围（如预算上限提高） */
  UPDATED = 'UPDATED',
  /** 客户明确改口，覆盖旧值（如"现在只要三房"） */
  OVERRIDDEN = 'OVERRIDDEN',
  /** 客户明确放弃某项要求（如"学区无所谓了"） */
  REMOVED = 'REMOVED',
}

export const REQUIREMENT_CHANGE_LABELS: Record<RequirementChangeType, string> = {
  [RequirementChangeType.ADDED]: '新增',
  [RequirementChangeType.UPDATED]: '调整',
  [RequirementChangeType.OVERRIDDEN]: '改口',
  [RequirementChangeType.REMOVED]: '取消',
};

// ---------------------------------------------------------------------------
// 消息导入
// ---------------------------------------------------------------------------
//
// 产品边界：本项目使用**普通个人微信**，没有聊天 API。
// 这里定义的只是「经纪人主动粘贴进系统的文本」的分类，与微信接口无关。
// ---------------------------------------------------------------------------

/** 消息来源渠道 */
export enum MessageImportSource {
  /** 经纪人从普通微信手动复制粘贴（当前唯一实现的渠道） */
  WECHAT_MANUAL_PASTE = 'WECHAT_MANUAL_PASTE',
  /** 电话沟通后人工整理的文字 */
  PHONE_NOTE = 'PHONE_NOTE',
  /** 短信 */
  SMS = 'SMS',
  /** 邮件 */
  EMAIL = 'EMAIL',
  /** 其他 */
  OTHER = 'OTHER',
}

export const MESSAGE_SOURCE_LABELS: Record<MessageImportSource, string> = {
  [MessageImportSource.WECHAT_MANUAL_PASTE]: '微信粘贴',
  [MessageImportSource.PHONE_NOTE]: '电话记录',
  [MessageImportSource.SMS]: '短信',
  [MessageImportSource.EMAIL]: '邮件',
  [MessageImportSource.OTHER]: '其他',
};

/** 消息内容类型 */
export enum MessageImportType {
  /** 客户主动发来的需求表达 */
  CUSTOMER_MESSAGE = 'CUSTOMER_MESSAGE',
  /** 客户对已推荐房源的反馈 */
  PROPERTY_FEEDBACK = 'PROPERTY_FEEDBACK',
  /** 经纪人自己的记录 */
  AGENT_NOTE = 'AGENT_NOTE',
}

export const MESSAGE_TYPE_LABELS: Record<MessageImportType, string> = {
  [MessageImportType.CUSTOMER_MESSAGE]: '客户需求',
  [MessageImportType.PROPERTY_FEEDBACK]: '房源反馈',
  [MessageImportType.AGENT_NOTE]: '经纪人记录',
};

/** 解析状态。失败也保留原文，绝不丢数据。 */
export enum MessageParseStatus {
  PENDING = 'PENDING',
  PARSING = 'PARSING',
  SUCCESS = 'SUCCESS',
  /** 部分字段解析成功 */
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

export const MESSAGE_PARSE_STATUS_LABELS: Record<MessageParseStatus, string> = {
  [MessageParseStatus.PENDING]: '待解析',
  [MessageParseStatus.PARSING]: '解析中',
  [MessageParseStatus.SUCCESS]: '已解析',
  [MessageParseStatus.PARTIAL]: '部分解析',
  [MessageParseStatus.FAILED]: '解析失败',
};

// ---------------------------------------------------------------------------
// AI 抽取输出（对应 WECHAT_REQUIREMENT_EXTRACTION 的 responseSchema）
// ---------------------------------------------------------------------------

/** 户型要求 */
export interface ExtractedBedrooms {
  /** 期望卧室数 */
  preferred: number | null;
  /** 客户说"只要三房""必须三房"时为 true */
  strict: boolean;
  /**
   * 客户是否在**放宽**户型范围，而不是指定具体户型。
   *
   * ============================================================================
   * 为什么需要这个字段（真实 bug 驱动）
   * ============================================================================
   * 踩过的坑：客户说「厦门湖里区三房，400万左右」，
   * 系统却搜出了 2 房房源 —— 因为合并逻辑把"三房"当成了
   * "在原有 2 房基础上追加 3 房"，最终 bedrooms = [2, 3]，
   * 检索式变成"2居室"，答案完全跑偏。
   *
   * 根因：系统无法区分这两句话
   *   · 「三房」        → 客户**要** 3 房（应当**替换**旧值）
   *   · 「两房也可以」   → 客户**放宽**到 2 房（应当**追加**）
   *
   * 加本字段后：
   *   · additive = true  → 追加（"也可以""都行""也能接受"）
   *   · additive = false → 替换（默认；客户明确说了想要的户型）
   */
  additive: boolean;
}

/** 预算要求 */
export interface ExtractedBudget {
  /** 理想预算（客户最舒服的价位），单位元 */
  target: number | null;
  /** 常规上限（"600以内也可以"），单位元 */
  normalMax: number | null;
  /** 极限上限（"特别好的600也能考虑"），单位元 */
  stretchMax: number | null;
  /** 下限，单位元 */
  min: number | null;
  /** 客户说"超过不看""最多520"时为 true —— 超此价必须硬过滤 */
  strictMax: boolean;
}

/** 房龄要求 */
export interface ExtractedBuildingAge {
  preference: BuildingAgePreference;
  /** "别太老的小区""不要老小区" */
  avoidOld: boolean;
  /** 明确的最早建成年份 */
  builtAfterYear: number | null;
}

/**
 * AI 从一条微信消息中抽取的结构化需求。
 * 这是「新证据」，不是「完整画像」—— 合并工作由 RequirementMergeService 负责。
 */
export interface RequirementExtraction {
  /** 城市。客户未提及时为 null，**不允许 AI 猜** */
  city: string | null;
  /** 区域，如 ["浦东新区"] */
  districts: string[];
  /** 板块，如 ["张江"] */
  subDistricts: string[];
  /** 具体小区 */
  communities: string[];

  bedrooms: ExtractedBedrooms;
  budget: ExtractedBudget;
  buildingAge: ExtractedBuildingAge;

  areaMin: number | null;
  areaMax: number | null;

  /** 各维度优先级 */
  communityQuality: PreferencePriority;
  subway: PreferencePriority;
  school: PreferencePriority;
  decoration: PreferencePriority;
  orientation: PreferencePriority;
  floor: PreferencePriority;

  floorPreference: RequirementFloorPreference;
  decorationPreference: DecorationPreferenceLevel;
  /** 客户明确要求"必须精装"（比 decorationPreference 更强） */
  requireFineDecoration: boolean;

  /** 明确不要一楼 */
  avoidFirstFloor: boolean;
  /** 明确不要顶楼 */
  avoidTopFloor: boolean;
  /** 必须电梯 */
  requireElevator: boolean;

  /** 必须学区 */
  schoolRequired: boolean;
  /** 学区无所谓 */
  schoolNotNeeded: boolean;
  /** 学区补充说明，如"最好是一梯队" */
  schoolNote: string | null;

  /** 可接受的最远地铁步行距离（米） */
  subwayDistanceMax: number | null;
  /** 通勤地点（如"我在张江上班"） */
  commuteLocations: string[];
  /** 重视开车便利 */
  carConvenience: boolean;

  /** 购房目的 */
  purchasePurpose: string | null;
  /** 付款方式 */
  paymentMethod: string | null;
  /** 购房时间预期 */
  purchaseTimeline: string | null;

  decisionMakers: DecisionMaker[];
  /** 家庭成员的特殊关注点，如 ["老婆比较在意小区环境"] */
  familyConcerns: string[];

  /** 无法归类的补充要求 */
  otherRequirements: string[];

  /**
   * 本次消息中具有**覆盖语义**的字段名。
   * 例如客户说"现在只考虑三房"，则 bedrooms 进入此列表，
   * 合并时用新值替换旧值而不是累加。
   */
  overrideFields: string[];

  /** 抽取置信度 0～1 */
  confidence: number;
  /** 缺失但影响搜索的关键字段，如 ["city"] */
  missingCriticalFields: string[];
  /** 一句话摘要 */
  summary: string;

  /**
   * 城市的来源。
   *
   * 为什么要区分：
   *   - explicit：客户明说"上海浦东" → 可信
   *   - inferred：客户只说"浦东"，系统按"浦东唯一属于上海"这一**确定映射**补全
   *     → 可信但不是客户亲口说的，界面必须标注"城市按浦东推断为上海"，
   *       让经纪人有机会纠正
   *   - none：无法确定 → 必须让用户补，绝不能猜
   *
   * 这与"AI 猜城市"有本质区别：AI 猜测基于常识推断（可能错），
   * 而这里是确定的地理归属关系（浦东不可能在其他城市）。
   */
  citySource?: 'explicit' | 'inferred' | 'none';
  /** 推断城市时所依据的地名，如 "浦东" */
  cityInferredFrom?: string | null;
}

/** RequirementExtraction 的 JSON Schema（传给模型的约束） */
export const REQUIREMENT_EXTRACTION_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'city',
    'districts',
    'subDistricts',
    'communities',
    'bedrooms',
    'budget',
    'buildingAge',
    'areaMin',
    'areaMax',
    'communityQuality',
    'subway',
    'school',
    'decoration',
    'orientation',
    'floor',
    'floorPreference',
    'decorationPreference',
    'requireFineDecoration',
    'avoidFirstFloor',
    'avoidTopFloor',
    'requireElevator',
    'schoolRequired',
    'schoolNotNeeded',
    'schoolNote',
    'subwayDistanceMax',
    'commuteLocations',
    'carConvenience',
    'purchasePurpose',
    'paymentMethod',
    'purchaseTimeline',
    'decisionMakers',
    'familyConcerns',
    'otherRequirements',
    'overrideFields',
    'confidence',
    'missingCriticalFields',
    'summary',
  ],
  additionalProperties: false,
  properties: {
    city: {
      type: ['string', 'null'],
      description: '城市名。客户未提及时必须为 null，绝对不允许猜测或使用默认值',
    },
    districts: { type: 'array', items: { type: 'string' }, description: '行政区，如 浦东新区、徐汇区' },
    subDistricts: { type: 'array', items: { type: 'string' }, description: '板块/商圈，如 张江、金桥' },
    communities: { type: 'array', items: { type: 'string' }, description: '具体小区名' },

    bedrooms: {
      type: 'object',
      required: ['preferred', 'strict'],
      additionalProperties: false,
      properties: {
        preferred: { type: ['integer', 'null'], description: '期望卧室数' },
        strict: { type: 'boolean', description: '客户是否表达为硬性要求（"只要三房""必须三房"）' },
      },
    },
    budget: {
      type: 'object',
      required: ['target', 'normalMax', 'stretchMax', 'min', 'strictMax'],
      additionalProperties: false,
      properties: {
        target: { type: ['integer', 'null'], description: '理想预算（元）。"550左右""预算550"填这里' },
        normalMax: {
          type: ['integer', 'null'],
          description: '常规上限（元）。"600以内也可以""600封顶"填这里',
        },
        stretchMax: {
          type: ['integer', 'null'],
          description: '极限上限（元）。仅当客户表达"特别好也可以考虑"这类让步语气时填写',
        },
        min: { type: ['integer', 'null'], description: '预算下限（元）' },
        strictMax: {
          type: 'boolean',
          description: '客户是否明确表示超过某价位就不看（"最多520""超过不看"）',
        },
      },
    },
    buildingAge: {
      type: 'object',
      required: ['preference', 'avoidOld', 'builtAfterYear'],
      additionalProperties: false,
      properties: {
        preference: {
          type: 'string',
          enum: ['NEWER', 'WITHIN_5', 'WITHIN_10', 'WITHIN_20', 'ANY'],
          description: '房龄偏好',
        },
        avoidOld: { type: 'boolean', description: '是否明确排除老小区（"别太老""不要老小区"）' },
        builtAfterYear: { type: ['integer', 'null'], description: '明确的最早建成年份' },
      },
    },

    areaMin: { type: ['integer', 'null'], description: '最小面积（㎡）' },
    areaMax: { type: ['integer', 'null'], description: '最大面积（㎡）' },

    communityQuality: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
    subway: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
    school: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
    decoration: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
    orientation: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
    floor: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },

    floorPreference: {
      type: 'string',
      enum: ['LOW', 'MIDDLE', 'HIGH', 'MIDDLE_HIGH', 'ANY'],
      description: '楼层偏好',
    },
    decorationPreference: {
      type: 'string',
      enum: ['ROUGH', 'SIMPLE', 'FINE', 'LUXURY', 'ANY'],
      description: '装修要求',
    },
    requireFineDecoration: {
      type: 'boolean',
      description: '客户是否明确要求"必须精装"（比 decorationPreference 更强的约束）',
    },

    avoidFirstFloor: { type: 'boolean' },
    avoidTopFloor: { type: 'boolean' },
    requireElevator: { type: 'boolean' },

    schoolRequired: { type: 'boolean', description: '客户明确要求学区' },
    schoolNotNeeded: { type: 'boolean', description: '客户明确表示学区无所谓' },
    schoolNote: { type: ['string', 'null'], description: '学区补充说明' },

    subwayDistanceMax: { type: ['integer', 'null'], description: '可接受最远地铁步行距离（米）' },
    commuteLocations: { type: 'array', items: { type: 'string' }, description: '通勤地点' },
    carConvenience: { type: 'boolean', description: '是否重视开车便利' },

    purchasePurpose: { type: ['string', 'null'], description: '购房目的：自住/改善/投资/学区' },
    paymentMethod: { type: ['string', 'null'], description: '付款方式：全款/商贷/公积金' },
    purchaseTimeline: { type: ['string', 'null'], description: '购房时间预期' },

    decisionMakers: {
      type: 'array',
      items: { type: 'string', enum: ['SELF', 'SPOUSE', 'PARENTS', 'CHILD', 'OTHER'] },
    },
    familyConcerns: {
      type: 'array',
      items: { type: 'string' },
      description: '家庭成员的特殊关注点，用客户原话表述',
    },
    otherRequirements: { type: 'array', items: { type: 'string' } },

    overrideFields: {
      type: 'array',
      items: { type: 'string' },
      description:
        '本次消息中带有覆盖语义的字段名（客户使用"现在""改成""不要了""只考虑""最多""必须"等词时）。' +
        '字段名使用本 Schema 的键名，如 bedrooms、budget、schoolRequired',
    },

    confidence: { type: 'number', minimum: 0, maximum: 1 },
    missingCriticalFields: {
      type: 'array',
      items: { type: 'string' },
      description: '影响搜索但客户尚未告知的关键字段，如 city、districts',
    },
    summary: { type: 'string', description: '一句话概括客户本次表达的需求' },
  },
};

// ---------------------------------------------------------------------------
// 合并（merge）
// ---------------------------------------------------------------------------

/** 需求合并结果：合并后的完整画像 + 变化明细 */
export interface RequirementMergeResult {
  /** 合并后的完整画像 */
  merged: MergedRequirementProfile;
  /** 本次变化明细（用于界面展示"AI 识别到以下变化"） */
  changes: RequirementChange[];
  /** 是否存在覆盖型变化 */
  hasOverride: boolean;
  /** 是否需要人工确认（置信度偏低或变化幅度过大） */
  needsConfirmation: boolean;
}

/**
 * 合并后的完整需求画像。
 * 字段命名与数据库 customer_requirement_profiles 保持一致。
 */
export interface MergedRequirementProfile {
  city: string | null;
  districts: string[];
  subDistricts: string[];
  communities: string[];

  budgetTarget: number | null;
  budgetNormalMax: number | null;
  budgetStretchMax: number | null;
  budgetStrictMax: boolean;
  budgetMin: number | null;

  bedrooms: number[];
  bedroomsStrict: boolean;
  livingRooms: number | null;

  areaMin: number | null;
  areaMax: number | null;

  buildingAgePreference: BuildingAgePreference | null;
  avoidOldCommunity: boolean;

  communityQualityPriority: PreferencePriority | null;
  subwayPriority: PreferencePriority | null;
  schoolPriority: PreferencePriority | null;
  decorationPriority: PreferencePriority | null;
  floorPreference: RequirementFloorPreference | null;
  orientationPreference: PreferencePriority | null;

  avoidFirstFloor: boolean;
  avoidTopFloor: boolean;
  requireElevator: boolean;

  decorationPreference: DecorationPreferenceLevel | null;
  requireFineDecoration: boolean;

  schoolRequired: boolean;
  schoolNotNeeded: boolean;
  schoolNote: string | null;

  subwayDistanceMax: number | null;
  commuteLocations: string[];
  carConvenience: boolean;

  purchasePurpose: string | null;
  paymentMethod: string | null;
  purchaseTimeline: string | null;

  decisionMakers: DecisionMaker[];
  familyConcerns: string[];

  otherRequirements: string[];

  confidence: number;
  sourceMessageCount: number;
}

/** 单条需求变化 */
export interface RequirementChange {
  /** 字段名（MergedRequirementProfile 的键） */
  field: string;
  /** 中文标签，用于界面展示 */
  label: string;
  changeType: RequirementChangeType;
  /** 变化前的展示值 */
  previousDisplay: string;
  /** 变化后的展示值 */
  newDisplay: string;
  /** 是否由客户明确改口引起 */
  isOverride: boolean;
}

// ---------------------------------------------------------------------------
// 搜索条件与打分
// ---------------------------------------------------------------------------

/** 结构化搜索条件 */
export interface PropertySearchQuery {
  city: string;
  districts: string[];
  subDistricts: string[];
  communities: string[];
  bedrooms: number[];
  /** 硬性预算上限（元），超过必须过滤 */
  budgetMax: number | null;
  budgetMin: number | null;
  areaMin: number | null;
  areaMax: number | null;
  /** 建成年份下限 */
  builtAfterYear: number | null;
  requireElevator: boolean;
  avoidFirstFloor: boolean;
  avoidTopFloor: boolean;
  /** 是否只看在售 */
  onlyActive: boolean;
  /** 交给贝壳的自然语言查询 */
  naturalQuery: string;
  /** 生成该查询时使用的说明（供界面显示检索依据） */
  rationale: string;
}

/** 单个维度的打分明细 */
export interface ScoreDimension {
  /** 维度键，如 budget */
  key: string;
  /** 中文名 */
  label: string;
  /** 实际得分 */
  score: number;
  /** 该维度满分 */
  maxScore: number;
  /** 打分说明，用于界面展示 */
  detail: string;
}

/**
 * 一套房源的匹配打分结果（闭环专用）。
 *
 * 与 matching.ts 的 PropertyMatchResult 的区别：
 *   那个是**持久化的历史匹配记录**（对应 customer_property_matches 表）；
 *   这个是**一次推荐流程内的打分对象**，额外携带推荐去重信息与价格变化信号。
 */
export interface ScoredPropertyMatch {
  /** 房源 ID（数据库） */
  propertyId: string;
  /** 贝壳房源 ID */
  externalId: string;
  /** 匹配总分 0～100 */
  matchScore: number;
  /** 各维度明细 */
  breakdown: ScoreDimension[];
  /** 命中/未命中的要点，如 ["✓ 张江", "✓ 三房", "• 比理想预算高 18万"] */
  highlights: string[];
  /** 风险与注意事项 */
  cautions: string[];
  /** 推荐理由（由 AI 或规则生成） */
  explanation: string | null;
  /** 是否曾被推荐过 */
  previouslyRecommended: boolean;
  /** 是否因为价格下降而重新进入推荐 */
  priceDropReentry: boolean;
  /** 价格变化金额（元），负数表示降价 */
  priceChange: number;
}

/** 打分权重配置 */
export interface MatchingScoringWeights {
  budget: number;
  district: number;
  bedrooms: number;
  area: number;
  buildingAge: number;
  subway: number;
  community: number;
  decoration: number;
  history: number;
}

/** 默认权重（需求 §19 指定，合计 100） */
export const DEFAULT_MATCHING_WEIGHTS: MatchingScoringWeights = {
  budget: 25,
  district: 15,
  bedrooms: 15,
  area: 10,
  buildingAge: 10,
  subway: 10,
  community: 5,
  decoration: 5,
  history: 5,
};

/** 维度中文名 */
export const SCORE_DIMENSION_LABELS: Record<keyof MatchingScoringWeights, string> = {
  budget: '预算',
  district: '区域',
  bedrooms: '户型',
  area: '面积',
  buildingAge: '房龄',
  subway: '交通',
  community: '小区',
  decoration: '装修',
  history: '历史偏好',
};

// ---------------------------------------------------------------------------
// 客户反馈（对应 PROPERTY_FEEDBACK_EXTRACTION）
// ---------------------------------------------------------------------------

/** 客户对单套房源的反馈倾向 */
export enum PropertyFeedbackSentiment {
  POSITIVE = 'POSITIVE',
  NEUTRAL = 'NEUTRAL',
  NEGATIVE = 'NEGATIVE',
  /** 客户表达了意见但无法判断倾向 */
  UNKNOWN = 'UNKNOWN',
}

export const FEEDBACK_SENTIMENT_LABELS: Record<PropertyFeedbackSentiment, string> = {
  [PropertyFeedbackSentiment.POSITIVE]: '感兴趣',
  [PropertyFeedbackSentiment.NEUTRAL]: '中性',
  [PropertyFeedbackSentiment.NEGATIVE]: '不考虑',
  [PropertyFeedbackSentiment.UNKNOWN]: '未明确',
};

/** AI 从客户回复中抽取的反馈 */
export interface PropertyFeedbackExtraction {
  /** 对每套房源的反馈 */
  items: Array<{
    /** 客户口中的序号：1 表示"第一套" */
    mentionedIndex: number | null;
    /** 客户提到的房源特征（用于在没有序号时匹配） */
    mentionedCommunity: string | null;
    sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'UNKNOWN';
    /** 兴趣等级 0～5 */
    interestLevel: number | null;
    /** 客户原话摘录 */
    rawQuote: string | null;
    reasons: string[];
    reactions: Array<{
      type:
        | 'PRICE'
        | 'LOCATION'
        | 'LAYOUT'
        | 'COMMUNITY'
        | 'FLOOR'
        | 'ORIENTATION'
        | 'DECORATION'
        | 'SCHOOL'
        | 'SUBWAY'
        | 'AGE'
        | 'OTHER';
      reaction: string;
    }>;
  }>;
  /** 从反馈中识别出的新偏好或偏好变化 */
  preferenceUpdates: Array<{
    field: string;
    /** 新的优先级或数值 */
    newValue: string;
    reason: string;
  }>;
  /** 是否包含对某套房的明确否定（用于排除相似房源） */
  hasRejection: boolean;
  confidence: number;
  summary: string;
}

/** PROPERTY_FEEDBACK_EXTRACTION 的 JSON Schema */
export const PROPERTY_FEEDBACK_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['items', 'preferenceUpdates', 'hasRejection', 'confidence', 'summary'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'mentionedIndex',
          'mentionedCommunity',
          'sentiment',
          'interestLevel',
          'rawQuote',
          'reasons',
          'reactions',
        ],
        additionalProperties: false,
        properties: {
          mentionedIndex: {
            type: ['integer', 'null'],
            description: '客户说"第一套"时为 1，"第二套"时为 2；没有明确指向时为 null',
          },
          mentionedCommunity: {
            type: ['string', 'null'],
            description: '客户提到的具体小区名，用于在没有序号时定位房源',
          },
          sentiment: { type: 'string', enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'UNKNOWN'] },
          interestLevel: { type: ['integer', 'null'], minimum: 0, maximum: 5 },
          rawQuote: { type: ['string', 'null'], description: '客户原话摘录，必须是消息中真实出现的文字' },
          reasons: { type: 'array', items: { type: 'string' } },
          reactions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type', 'reaction'],
              additionalProperties: false,
              properties: {
                type: {
                  type: 'string',
                  enum: [
                    'PRICE',
                    'LOCATION',
                    'LAYOUT',
                    'COMMUNITY',
                    'FLOOR',
                    'ORIENTATION',
                    'DECORATION',
                    'SCHOOL',
                    'SUBWAY',
                    'AGE',
                    'OTHER',
                  ],
                },
                reaction: { type: 'string', description: '客户的具体反应，如"觉得贵了"' },
              },
            },
          },
        },
      },
    },
    preferenceUpdates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['field', 'newValue', 'reason'],
        additionalProperties: false,
        properties: {
          field: {
            type: 'string',
            description: '受影响的字段名，如 subway、districts、budgetStrictMax',
          },
          newValue: { type: 'string', description: '新的取值或优先级' },
          reason: { type: 'string', description: '推断依据，引用客户原话' },
        },
      },
    },
    hasRejection: { type: 'boolean', description: '是否存在明确的否定反馈' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// 微信回复
// ---------------------------------------------------------------------------

/** 微信回复风格 */
export enum WeChatReplyStyle {
  /** 自然专业（默认） */
  NATURAL_PROFESSIONAL = 'NATURAL_PROFESSIONAL',
  /** 简短 */
  CONCISE = 'CONCISE',
  /** 详细 */
  DETAILED = 'DETAILED',
}

/**
 * 推荐批次状态。
 *
 * 语义必须严格（需求 §33、§34）：
 *   COPIED 只表示经纪人把文案复制到了剪贴板，**绝不代表客户已收到**。
 *   我们用的是普通个人微信，没有发送 API，系统无法知道是否真的发出去了。
 *   因此只有 SENT_CONFIRMED（人工确认）才能视为已触达客户。
 */
export enum RecommendationStatus {
  /** 已生成文案，尚未复制 */
  GENERATED = 'GENERATED',
  /** 经纪人点了「复制」 */
  COPIED = 'COPIED',
  /** 经纪人人工确认「我已发送」 */
  SENT_CONFIRMED = 'SENT_CONFIRMED',
  /** 经纪人放弃本批次 */
  DISCARDED = 'DISCARDED',
}

export const RECOMMENDATION_STATUS_LABELS: Record<RecommendationStatus, string> = {
  [RecommendationStatus.GENERATED]: '待发送',
  [RecommendationStatus.COPIED]: '已复制',
  [RecommendationStatus.SENT_CONFIRMED]: '已发送',
  [RecommendationStatus.DISCARDED]: '已放弃',
};

export const WECHAT_REPLY_STYLE_LABELS: Record<WeChatReplyStyle, string> = {
  [WeChatReplyStyle.NATURAL_PROFESSIONAL]: '自然专业',
  [WeChatReplyStyle.CONCISE]: '简短推荐',
  [WeChatReplyStyle.DETAILED]: '详细推荐',
};

/** 生成好的微信回复 */
export interface WeChatReply {
  /** 可直接粘贴到微信的正文 */
  content: string;
  style: WeChatReplyStyle;
  /** 涉及的房源 ID */
  propertyIds: string[];
  /** 是否由 AI 生成（false 表示规则模板降级） */
  aiGenerated: boolean;
  /** 字数 */
  length: number;
}

// ---------------------------------------------------------------------------
// 编排流程的进度步骤
// ---------------------------------------------------------------------------

/** 流程步骤标识 —— 前端据此显示真实进度，禁止假 loading */
export enum AssistantStep {
  SAVING_MESSAGE = 'SAVING_MESSAGE',
  EXTRACTING_REQUIREMENT = 'EXTRACTING_REQUIREMENT',
  MERGING_PROFILE = 'MERGING_PROFILE',
  SEARCHING_BEIJE = 'SEARCHING_BEIKE',
  HARD_FILTERING = 'HARD_FILTERING',
  SCORING = 'SCORING',
  ENRICHING_DETAIL = 'ENRICHING_DETAIL',
  GENERATING_REPLY = 'GENERATING_REPLY',
  DONE = 'DONE',
}

export const ASSISTANT_STEP_LABELS: Record<AssistantStep, string> = {
  [AssistantStep.SAVING_MESSAGE]: '正在保存客户消息',
  [AssistantStep.EXTRACTING_REQUIREMENT]: '正在理解客户需求',
  [AssistantStep.MERGING_PROFILE]: '正在更新客户画像',
  [AssistantStep.SEARCHING_BEIJE]: '正在查询贝壳真实房源',
  [AssistantStep.HARD_FILTERING]: '正在按硬性条件筛选',
  [AssistantStep.SCORING]: '正在计算匹配度',
  [AssistantStep.ENRICHING_DETAIL]: '正在获取房源详情',
  [AssistantStep.GENERATING_REPLY]: '正在生成微信推荐',
  [AssistantStep.DONE]: '已完成',
};

/** 单个步骤的执行结果 */
export interface AssistantStepStatus {
  step: AssistantStep;
  label: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'SKIPPED' | 'FAILED';
  /** 结果描述，如"召回 47 套" */
  detail: string | null;
  durationMs: number | null;
}
