/**
 * 销售机会引擎与通知中心类型定义。
 *
 * Opportunity Engine 的价值：不让经纪人自己翻数据，而是系统主动告诉他
 * 「现在最该做什么、为什么、怎么做」。
 */

/** 机会类型 —— 与需求文档 §20 完全对齐 */
export enum OpportunityType {
  /** 出现高匹配新房源 */
  NEW_MATCH = 'NEW_MATCH',
  /** 客户关注房源降价 */
  PRICE_DROP = 'PRICE_DROP',
  /** 客户重新访问 */
  CUSTOMER_REVISIT = 'CUSTOMER_REVISIT',
  /** 客户活跃度骤升 */
  CUSTOMER_HIGH_ACTIVITY = 'CUSTOMER_HIGH_ACTIVITY',
  /** 沉睡客户重新活跃 */
  CUSTOMER_DORMANT_REACTIVATED = 'CUSTOMER_DORMANT_REACTIVATED',
  /** 客户需求发生变化 */
  PREFERENCE_CHANGED = 'PREFERENCE_CHANGED',
  /** 新房源挂牌 */
  LISTING_NEW = 'LISTING_NEW',
  /** 房源重新挂牌 */
  LISTING_RELIVE = 'LISTING_RELIVE',
  /** 带看后需跟进 */
  VIEWING_FOLLOWUP = 'VIEWING_FOLLOWUP',
  /** 谈判阶段需跟进 */
  NEGOTIATION_FOLLOWUP = 'NEGOTIATION_FOLLOWUP',
  /** 跟进超期 */
  FOLLOWUP_OVERDUE = 'FOLLOWUP_OVERDUE',
}

export const OPPORTUNITY_TYPE_LABELS: Record<OpportunityType, string> = {
  [OpportunityType.NEW_MATCH]: '新出现高匹配房源',
  [OpportunityType.PRICE_DROP]: '关注房源降价',
  [OpportunityType.CUSTOMER_REVISIT]: '客户重复查看',
  [OpportunityType.CUSTOMER_HIGH_ACTIVITY]: '客户活跃度飙升',
  [OpportunityType.CUSTOMER_DORMANT_REACTIVATED]: '沉睡客户重新活跃',
  [OpportunityType.PREFERENCE_CHANGED]: '客户需求变化',
  [OpportunityType.LISTING_NEW]: '新房源上架',
  [OpportunityType.LISTING_RELIVE]: '房源重新挂牌',
  [OpportunityType.VIEWING_FOLLOWUP]: '带看后跟进',
  [OpportunityType.NEGOTIATION_FOLLOWUP]: '谈判推进',
  [OpportunityType.FOLLOWUP_OVERDUE]: '跟进已超期',
};

/** 机会优先级 */
export enum OpportunityPriority {
  /** 必须马上处理（如大幅降价 + 高匹配） */
  URGENT = 'URGENT',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export const OPPORTUNITY_PRIORITY_LABELS: Record<OpportunityPriority, string> = {
  [OpportunityPriority.URGENT]: '紧急',
  [OpportunityPriority.HIGH]: '高',
  [OpportunityPriority.MEDIUM]: '中',
  [OpportunityPriority.LOW]: '低',
};

/** 优先级排序权重 */
export const OPPORTUNITY_PRIORITY_RANK: Record<OpportunityPriority, number> = {
  [OpportunityPriority.URGENT]: 4,
  [OpportunityPriority.HIGH]: 3,
  [OpportunityPriority.MEDIUM]: 2,
  [OpportunityPriority.LOW]: 1,
};

/** 机会处理状态 */
export enum OpportunityStatus {
  /** 新发现，待处理 */
  OPEN = 'OPEN',
  /** 经纪人已查看 */
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  /** 已据此联系客户 */
  ACTIONED = 'ACTIONED',
  /** 已忽略 */
  DISMISSED = 'DISMISSED',
  /** 已过期（时效性机会，如降价后长期未跟进） */
  EXPIRED = 'EXPIRED',
}

export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  [OpportunityStatus.OPEN]: '待处理',
  [OpportunityStatus.ACKNOWLEDGED]: '已查看',
  [OpportunityStatus.ACTIONED]: '已跟进',
  [OpportunityStatus.DISMISSED]: '已忽略',
  [OpportunityStatus.EXPIRED]: '已过期',
};

/** 机会的支撑证据（可解释性） */
export interface OpportunityEvidence {
  /** 证据类型 */
  kind: 'BEHAVIOR' | 'PRICE' | 'MATCH' | 'DRIFT' | 'VIEWING' | 'COMMUNICATION' | 'TIME';
  /** 展示文案 */
  statement: string;
  /** 数值（可选） */
  value?: number;
  /** 单位（可选） */
  unit?: string;
  /** 发生时间 */
  occurredAt?: string;
}

/**
 * 销售机会。
 * 每条机会必须回答三个问题：为什么是现在、为什么是这个客户、下一步做什么。
 */
export interface Opportunity {
  id: string;
  organizationId: string;
  storeId: string | null;
  customerId: string | null;
  propertyId: string | null;
  assignedAgentId: string | null;
  type: OpportunityType;
  priority: OpportunityPriority;
  status: OpportunityStatus;
  /** 机会标题，如「王先生关注的 XX 花园降价 30 万」 */
  title: string;
  /** 「为什么」—— 完整原因说明 */
  reason: string;
  /** 「怎么做」—— 给经纪人的具体建议 */
  suggestion: string;
  /** 机会价值分 0～100，用于排序 */
  valueScore: number;
  /** 预期成交贡献（元），可为空 */
  expectedValue: number | null;
  /** 支撑证据列表 */
  evidence: OpportunityEvidence[];
  /** 关联的匹配分（若有） */
  matchScore: number | null;
  /** 建议联系时间，如「今天上午 10 点前」 */
  suggestedContactBy: string | null;
  /** 去重指纹，避免同一事件反复产生机会 */
  dedupeKey: string;
  /** 过期时间 */
  expiresAt: string | null;
  /** 处理时间 */
  handledAt: string | null;
  handledByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 机会引擎扫描结果统计 */
export interface OpportunityDetectionResult {
  /** 扫描的客户数 */
  customersScanned: number;
  /** 扫描的房源数 */
  propertiesScanned: number;
  /** 新发现机会数 */
  created: number;
  /** 被去重跳过的数量 */
  dedupedSkipped: number;
  /** 标记过期的数量 */
  expired: number;
  /** 按类型统计 */
  byType: Array<{ type: OpportunityType; count: number }>;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 通知中心
// ---------------------------------------------------------------------------

/** 通知类型 */
export enum NotificationType {
  PRICE_DROP = 'PRICE_DROP',
  NEW_MATCH = 'NEW_MATCH',
  CUSTOMER_ACTIVE = 'CUSTOMER_ACTIVE',
  CUSTOMER_REVISIT = 'CUSTOMER_REVISIT',
  FOLLOWUP_DUE = 'FOLLOWUP_DUE',
  VIEWING_REMINDER = 'VIEWING_REMINDER',
  PREFERENCE_CHANGE = 'PREFERENCE_CHANGE',
  HIGH_INTENT = 'HIGH_INTENT',
}

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  [NotificationType.PRICE_DROP]: '房源降价',
  [NotificationType.NEW_MATCH]: '新房源匹配',
  [NotificationType.CUSTOMER_ACTIVE]: '客户活跃',
  [NotificationType.CUSTOMER_REVISIT]: '客户重复查看',
  [NotificationType.FOLLOWUP_DUE]: '跟进到期',
  [NotificationType.VIEWING_REMINDER]: '带看提醒',
  [NotificationType.PREFERENCE_CHANGE]: '需求变化',
  [NotificationType.HIGH_INTENT]: '高意向客户',
};

/** 通知优先级 */
export enum NotificationPriority {
  URGENT = 'URGENT',
  HIGH = 'HIGH',
  NORMAL = 'NORMAL',
  LOW = 'LOW',
}

export const NOTIFICATION_PRIORITY_LABELS: Record<NotificationPriority, string> = {
  [NotificationPriority.URGENT]: '紧急',
  [NotificationPriority.HIGH]: '重要',
  [NotificationPriority.NORMAL]: '普通',
  [NotificationPriority.LOW]: '低',
};

export const NOTIFICATION_PRIORITY_RANK: Record<NotificationPriority, number> = {
  [NotificationPriority.URGENT]: 4,
  [NotificationPriority.HIGH]: 3,
  [NotificationPriority.NORMAL]: 2,
  [NotificationPriority.LOW]: 1,
};

/** 通知 */
export interface Notification {
  id: string;
  organizationId: string;
  userId: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  body: string;
  /** 点击后跳转的前端路由 */
  link: string | null;
  /** 关联实体，便于前端高亮 */
  customerId: string | null;
  propertyId: string | null;
  opportunityId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

/** 未读统计 */
export interface NotificationUnreadCount {
  total: number;
  byPriority: Array<{ priority: NotificationPriority; count: number }>;
}
