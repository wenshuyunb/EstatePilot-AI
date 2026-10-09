/**
 * 组织 / 用户 / 权限相关领域枚举与类型。
 * 这是全系统单一事实来源：后端 DTO、数据库枚举、前端展示都从这里取。
 */

/** 系统角色，权限由高到低 */
export enum UserRole {
  /** 平台超级管理员（跨租户，仅内部运营使用） */
  SUPER_ADMIN = 'SUPER_ADMIN',
  /** 中介公司负责人（租户最高权限） */
  OWNER = 'OWNER',
  /** 门店店长 */
  STORE_MANAGER = 'STORE_MANAGER',
  /** 经纪人 */
  AGENT = 'AGENT',
  /** 只读观察者（如财务、助理） */
  VIEWER = 'VIEWER',
}

/** 角色显示名 */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.SUPER_ADMIN]: '平台超管',
  [UserRole.OWNER]: '公司负责人',
  [UserRole.STORE_MANAGER]: '门店店长',
  [UserRole.AGENT]: '经纪人',
  [UserRole.VIEWER]: '只读成员',
};

/** 角色权限等级，数值越大权限越高；用于「至少需要某角色」的守卫判断 */
export const USER_ROLE_RANK: Record<UserRole, number> = {
  [UserRole.VIEWER]: 10,
  [UserRole.AGENT]: 20,
  [UserRole.STORE_MANAGER]: 30,
  [UserRole.OWNER]: 40,
  [UserRole.SUPER_ADMIN]: 100,
};

/** 可自助注册的角色（平台超管只能由种子脚本或平台侧创建） */
export const SELF_ASSIGNABLE_ROLES: readonly UserRole[] = [
  UserRole.OWNER,
  UserRole.STORE_MANAGER,
  UserRole.AGENT,
  UserRole.VIEWER,
];

export enum UserStatus {
  /** 已邀请，尚未激活 */
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  /** 已离职 */
  DEACTIVATED = 'DEACTIVATED',
}

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  [UserStatus.INVITED]: '待激活',
  [UserStatus.ACTIVE]: '正常',
  [UserStatus.SUSPENDED]: '已停用',
  [UserStatus.DEACTIVATED]: '已离职',
};

/** 套餐等级。商业化预留：Free / Pro / Store / Enterprise */
export enum PlanTier {
  FREE = 'FREE',
  PRO = 'PRO',
  STORE = 'STORE',
  ENTERPRISE = 'ENTERPRISE',
}

export const PLAN_TIER_LABELS: Record<PlanTier, string> = {
  [PlanTier.FREE]: '免费版',
  [PlanTier.PRO]: '专业版',
  [PlanTier.STORE]: '门店版',
  [PlanTier.ENTERPRISE]: '企业版',
};

export enum SubscriptionStatus {
  TRIALING = 'TRIALING',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  [SubscriptionStatus.TRIALING]: '试用中',
  [SubscriptionStatus.ACTIVE]: '生效中',
  [SubscriptionStatus.PAST_DUE]: '已逾期',
  [SubscriptionStatus.CANCELLED]: '已取消',
  [SubscriptionStatus.EXPIRED]: '已过期',
};

/** 套餐配额。超限时由 QuotaService 拦截 */
export interface PlanQuota {
  tier: PlanTier;
  /** 可开通的账号席位上限 */
  seatLimit: number;
  /** 可管理的客户数上限 */
  customerLimit: number;
  /** 每月 AI 调用次数上限 */
  aiUsageLimit: number;
  /** 可创建的门店数上限 */
  storeLimit: number;
  /** 是否支持贝壳等外部 Provider 接入 */
  externalProviderEnabled: boolean;
  /** 单价（分/月），用于后台展示 */
  priceCentsPerMonth: number;
}

export const PLAN_QUOTAS: Record<PlanTier, PlanQuota> = {
  [PlanTier.FREE]: {
    tier: PlanTier.FREE,
    seatLimit: 3,
    customerLimit: 200,
    aiUsageLimit: 200,
    storeLimit: 1,
    externalProviderEnabled: false,
    priceCentsPerMonth: 0,
  },
  [PlanTier.PRO]: {
    tier: PlanTier.PRO,
    seatLimit: 10,
    customerLimit: 2000,
    aiUsageLimit: 5000,
    storeLimit: 2,
    externalProviderEnabled: false,
    priceCentsPerMonth: 49900,
  },
  [PlanTier.STORE]: {
    tier: PlanTier.STORE,
    seatLimit: 50,
    customerLimit: 20000,
    aiUsageLimit: 20000,
    storeLimit: 10,
    externalProviderEnabled: true,
    priceCentsPerMonth: 199900,
  },
  [PlanTier.ENTERPRISE]: {
    tier: PlanTier.ENTERPRISE,
    seatLimit: 100000,
    customerLimit: 1000000,
    aiUsageLimit: 200000,
    storeLimit: 10000,
    externalProviderEnabled: true,
    priceCentsPerMonth: 0,
  },
};

/** 审计日志动作 */
export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  LOGIN_FAILED = 'LOGIN_FAILED',
  EXPORT = 'EXPORT',
  IMPORT = 'IMPORT',
  VIEW_SENSITIVE = 'VIEW_SENSITIVE',
  PERMISSION_CHANGE = 'PERMISSION_CHANGE',
  CONFIG_CHANGE = 'CONFIG_CHANGE',
  REVOKE_CONSENT = 'REVOKE_CONSENT',
  DELETE_PERSONAL_DATA = 'DELETE_PERSONAL_DATA',
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  [AuditAction.CREATE]: '新建',
  [AuditAction.UPDATE]: '修改',
  [AuditAction.DELETE]: '删除',
  [AuditAction.LOGIN]: '登录',
  [AuditAction.LOGOUT]: '登出',
  [AuditAction.LOGIN_FAILED]: '登录失败',
  [AuditAction.EXPORT]: '导出数据',
  [AuditAction.IMPORT]: '导入数据',
  [AuditAction.VIEW_SENSITIVE]: '查看敏感信息',
  [AuditAction.PERMISSION_CHANGE]: '变更权限',
  [AuditAction.CONFIG_CHANGE]: '变更配置',
  [AuditAction.REVOKE_CONSENT]: '撤回授权',
  [AuditAction.DELETE_PERSONAL_DATA]: '删除个人数据',
};

/** 登录后返回给前端的当前用户上下文（不含任何敏感字段） */
export interface AuthUser {
  id: string;
  organizationId: string;
  storeId: string | null;
  name: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
}

/** JWT access token 载荷 */
export interface JwtPayload {
  /** 用户 ID */
  sub: string;
  /** 组织 ID —— 所有数据查询都必须带上它 */
  org: string;
  /** 门店 ID，可为空（OWNER 可能不属于具体门店） */
  store: string | null;
  role: UserRole;
  /** token 类型，防止 refresh token 被当作 access token 使用 */
  typ: 'access' | 'refresh';
  /** refresh token 的轮换代数，用于检测重放 */
  gen?: number;
  iat?: number;
  exp?: number;
}
