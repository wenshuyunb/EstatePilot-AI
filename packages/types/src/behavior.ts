/**
 * 客户行为采集系统类型定义。
 *
 * 合规红线（必须遵守）：
 * - 只采集客户「明确访问本平台」或「经授权」产生的数据。
 * - 严禁采集通讯录、相册、第三方 App 浏览历史、浏览器历史。
 * - 严禁偷偷读取手机数据。所有行为采集必须在客户可见的隐私说明下进行。
 * - 不保存明文 IP，只保存加盐哈希（ipHash）。
 */

/** 行为事件类型 —— 与需求文档 §9 完全对齐 */
export enum BehaviorEventType {
  // ---- 页面级 ----
  /** 打开客户专属页面 */
  PAGE_VIEW = 'PAGE_VIEW',
  /** 查看房源详情 */
  PROPERTY_VIEW = 'PROPERTY_VIEW',
  /** 重复访问同一套房源 */
  PROPERTY_REVISIT = 'PROPERTY_REVISIT',
  /** 快速退出（停留极短，负向信号） */
  PROPERTY_SKIP = 'PROPERTY_SKIP',

  // ---- 房源内容深度 ----
  /** 查看图片 */
  IMAGE_VIEW = 'IMAGE_VIEW',
  /** 看完整个图集 */
  IMAGE_GALLERY_COMPLETE = 'IMAGE_GALLERY_COMPLETE',
  /** 查看户型图 */
  FLOOR_PLAN_VIEW = 'FLOOR_PLAN_VIEW',
  /** 查看地图 */
  MAP_VIEW = 'MAP_VIEW',
  /** 查看小区信息 */
  COMMUNITY_VIEW = 'COMMUNITY_VIEW',
  /** 查看价格历史 */
  PRICE_HISTORY_VIEW = 'PRICE_HISTORY_VIEW',
  /** 查看学区信息 */
  SCHOOL_VIEW = 'SCHOOL_VIEW',
  /** 查看地铁信息 */
  SUBWAY_VIEW = 'SUBWAY_VIEW',
  /** 查看通勤信息 */
  COMMUTE_VIEW = 'COMMUTE_VIEW',

  // ---- 意向动作 ----
  /** 收藏房源 */
  PROPERTY_FAVORITE = 'PROPERTY_FAVORITE',
  /** 取消收藏 */
  PROPERTY_UNFAVORITE = 'PROPERTY_UNFAVORITE',
  /** 加入对比 */
  PROPERTY_COMPARE = 'PROPERTY_COMPARE',
  /** 分享房源 */
  PROPERTY_SHARE = 'PROPERTY_SHARE',
  /** 联系经纪人 */
  CONTACT_AGENT = 'CONTACT_AGENT',
  /** 预约带看 */
  BOOK_VIEWING = 'BOOK_VIEWING',

  // ---- 搜索与筛选 ----
  /** 搜索 */
  SEARCH = 'SEARCH',
  /** 修改筛选条件 */
  FILTER_CHANGE = 'FILTER_CHANGE',
}

export const BEHAVIOR_EVENT_TYPE_LABELS: Record<BehaviorEventType, string> = {
  [BehaviorEventType.PAGE_VIEW]: '打开专属页面',
  [BehaviorEventType.PROPERTY_VIEW]: '查看房源',
  [BehaviorEventType.PROPERTY_REVISIT]: '重复查看房源',
  [BehaviorEventType.PROPERTY_SKIP]: '快速划过房源',
  [BehaviorEventType.IMAGE_VIEW]: '查看图片',
  [BehaviorEventType.IMAGE_GALLERY_COMPLETE]: '看完整个图集',
  [BehaviorEventType.FLOOR_PLAN_VIEW]: '查看户型图',
  [BehaviorEventType.MAP_VIEW]: '查看地图',
  [BehaviorEventType.COMMUNITY_VIEW]: '查看小区',
  [BehaviorEventType.PRICE_HISTORY_VIEW]: '查看价格历史',
  [BehaviorEventType.SCHOOL_VIEW]: '查看学区',
  [BehaviorEventType.SUBWAY_VIEW]: '查看地铁',
  [BehaviorEventType.COMMUTE_VIEW]: '查看通勤',
  [BehaviorEventType.PROPERTY_FAVORITE]: '收藏房源',
  [BehaviorEventType.PROPERTY_UNFAVORITE]: '取消收藏',
  [BehaviorEventType.PROPERTY_COMPARE]: '加入对比',
  [BehaviorEventType.PROPERTY_SHARE]: '分享房源',
  [BehaviorEventType.CONTACT_AGENT]: '联系经纪人',
  [BehaviorEventType.BOOK_VIEWING]: '预约带看',
  [BehaviorEventType.SEARCH]: '搜索',
  [BehaviorEventType.FILTER_CHANGE]: '修改筛选',
};

/**
 * 默认行为评分权重 —— 种子数据初值。
 * 这些值会写入 behavior_scoring_rules 表，管理员可随时修改，
 * 代码中禁止硬编码使用（必须从数据库读取）。
 */
export const DEFAULT_BEHAVIOR_SCORES: Record<BehaviorEventType, number> = {
  [BehaviorEventType.PROPERTY_VIEW]: 1,
  [BehaviorEventType.PROPERTY_REVISIT]: 6,
  [BehaviorEventType.PROPERTY_SKIP]: -3,
  [BehaviorEventType.IMAGE_VIEW]: 1,
  [BehaviorEventType.IMAGE_GALLERY_COMPLETE]: 3,
  [BehaviorEventType.FLOOR_PLAN_VIEW]: 4,
  [BehaviorEventType.MAP_VIEW]: 3,
  [BehaviorEventType.COMMUNITY_VIEW]: 3,
  [BehaviorEventType.PRICE_HISTORY_VIEW]: 5,
  [BehaviorEventType.SCHOOL_VIEW]: 3,
  [BehaviorEventType.SUBWAY_VIEW]: 2,
  [BehaviorEventType.COMMUTE_VIEW]: 3,
  [BehaviorEventType.PROPERTY_FAVORITE]: 10,
  [BehaviorEventType.PROPERTY_UNFAVORITE]: -8,
  [BehaviorEventType.PROPERTY_COMPARE]: 8,
  [BehaviorEventType.PROPERTY_SHARE]: 9,
  [BehaviorEventType.CONTACT_AGENT]: 15,
  [BehaviorEventType.BOOK_VIEWING]: 25,
  [BehaviorEventType.PAGE_VIEW]: 0,
  [BehaviorEventType.SEARCH]: 1,
  [BehaviorEventType.FILTER_CHANGE]: 2,
};

/** 需要满足时长条件才计分的规则键 */
export enum ScoringConditionKind {
  /** 无条件 */
  ALWAYS = 'ALWAYS',
  /** 停留超过 N 秒 */
  DURATION_OVER = 'DURATION_OVER',
  /** 停留低于 N 秒（负向信号，如快速退出） */
  DURATION_UNDER = 'DURATION_UNDER',
  /** 同一房源重复访问达到 N 次 */
  REPEAT_OVER = 'REPEAT_OVER',
  /** 连续跳过同类房源达到 N 次 */
  SKIP_STREAK_OVER = 'SKIP_STREAK_OVER',
}

/** 行为评分规则（数据库表 behavior_scoring_rules 的运行时结构） */
export interface BehaviorScoringRule {
  id: string;
  organizationId: string | null;
  /** 规则名，便于后台展示 */
  name: string;
  eventType: BehaviorEventType;
  /** 得分（可为负） */
  score: number;
  conditionKind: ScoringConditionKind;
  /** 条件阈值，含义随 conditionKind 变化（秒/次数） */
  conditionValue: number | null;
  /** 同一房源/同一天内该规则最多计分次数，null 表示不限 */
  maxPerPropertyPerDay: number | null;
  enabled: boolean;
  /** 优先级，数值小的先算；用于覆盖关系 */
  priority: number;
  description: string | null;
}

/** 设备类型 */
export enum DeviceType {
  DESKTOP = 'DESKTOP',
  MOBILE = 'MOBILE',
  TABLET = 'TABLET',
  UNKNOWN = 'UNKNOWN',
}

/** 行为事件上报载荷（客户端 → 服务端） */
export interface BehaviorEventInput {
  /** 客户专属 token（不含真实客户 ID） */
  token: string;
  eventType: BehaviorEventType;
  /** 会话 ID，由前端生成并保持 */
  sessionId: string;
  /** 关联房源的外部 ID 或内部 ID（视事件而定） */
  propertyId?: string | null;
  /** 扩展信息：图片序号、筛选条件、搜索词、对比列表等 */
  metadata?: Record<string, unknown> | null;
  /** 停留时长（秒），页面/内容级事件必填 */
  duration?: number | null;
  /** 设备类型 */
  device?: DeviceType;
  /** 来源渠道，如 wechat / sms / direct */
  source?: string | null;
}

/** 行为事件（服务端 → 存储，也用于 API 返回） */
export interface BehaviorEventRecord {
  id: string;
  organizationId: string;
  customerId: string;
  sessionId: string;
  eventType: BehaviorEventType;
  propertyId: string | null;
  metadata: Record<string, unknown> | null;
  /** 秒 */
  duration: number | null;
  device: DeviceType;
  source: string | null;
  /** 加盐哈希后的 IP，绝不存明文 */
  ipHash: string | null;
  /** 由行为产生的分数（可为负） */
  score: number;
  createdAt: string;
}

/** 行为上报接口响应 */
export interface BehaviorEventAcceptedResponse {
  accepted: true;
  /** 已接受的事件条数（支持批量） */
  count: number;
  /** 本次上报累计得分，便于前端调试（不返回任何客户信息） */
  scoreDelta: number;
}

/** 客户行为概览（后台展示用） */
export interface CustomerBehaviorSummary {
  customerId: string;
  /** 统计窗口内的行为事件数 */
  totalEvents: number;
  /** 统计窗口内的行为总分 */
  totalScore: number;
  /** 会话数 */
  sessionCount: number;
  /** 浏览过的房源数 */
  viewedPropertyCount: number;
  /** 收藏数 */
  favoriteCount: number;
  /** 对比数 */
  compareCount: number;
  /** 重复访问过的房源数 */
  revisitCount: number;
  /** 总停留时长（秒） */
  totalDurationSeconds: number;
  /** 最后一次活动时间 */
  lastActiveAt: string | null;
  /** 首次活动时间 */
  firstActiveAt: string | null;
  /** 事件类型分布 */
  eventTypeDistribution: Array<{ eventType: BehaviorEventType; count: number }>;
}
