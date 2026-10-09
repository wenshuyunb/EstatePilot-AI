/**
 * 认证与授权相关的装饰器。
 *
 * 设计目标：让「一个接口需要什么权限」在方法签名上一眼可见，
 * 而不是藏在守卫实现里需要翻代码才能确认。
 */

import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { UserRole } from '@estatepilot/types';
import { getContext } from '../context/request-context.js';

/** 标记接口为公开（跳过认证） */
export const IS_PUBLIC_KEY = 'estatepilot:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** 标记接口所需的最低角色 */
export const REQUIRED_ROLES_KEY = 'estatepilot:requiredRoles';

/**
 * 限定可访问的角色（满足其一即可）。
 * 例：@Roles(UserRole.OWNER, UserRole.STORE_MANAGER)
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLES_KEY, roles);

/** 标记接口需要的最低角色等级（更宽松的写法） */
export const MIN_ROLE_RANK_KEY = 'estatepilot:minRoleRank';
export const MinRoleRank = (rank: number): MethodDecorator & ClassDecorator =>
  SetMetadata(MIN_ROLE_RANK_KEY, rank);

/** 标记接口允许平台超管访问 */
export const SUPER_ADMIN_ONLY_KEY = 'estatepilot:superAdminOnly';
export const SuperAdminOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SUPER_ADMIN_ONLY_KEY, true);

/**
 * 标记接口允许在无租户上下文时访问。
 * 仅用于健康检查、登录等极少数场景。
 */
export const ALLOW_NO_TENANT_KEY = 'estatepilot:allowNoTenant';
export const AllowNoTenant = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_NO_TENANT_KEY, true);

/**
 * 注入当前登录用户。
 *
 * 用法：
 *   @CurrentUser() user: RequestUser          // 取整个对象
 *   @CurrentUser('id') userId: string         // 取单个字段
 */
export interface RequestUser {
  id: string;
  organizationId: string;
  storeId: string | null;
  role: UserRole;
  isSuperAdmin: boolean;
}

export const CurrentUser = createParamDecorator(
  (field: keyof RequestUser | undefined, _ctx: ExecutionContext): unknown => {
    const context = getContext();
    if (!context?.userId || !context.organizationId) {
      return undefined;
    }

    const user: RequestUser = {
      id: context.userId,
      organizationId: context.organizationId,
      storeId: context.storeId ?? null,
      role: context.role ?? UserRole.AGENT,
      isSuperAdmin: context.isSuperAdmin ?? false,
    };

    return field ? user[field] : user;
  },
);

/**
 * 注入租户上下文（供需要显式拿 organizationId 的场景使用）。
 */
export const TenantContextParam = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): { organizationId: string; storeId: string | null } | undefined => {
    const context = getContext();
    if (!context?.organizationId) return undefined;
    return { organizationId: context.organizationId, storeId: context.storeId ?? null };
  },
);

/** 注入 traceId，用于把错误响应与后端日志对上 */
export const TraceId = createParamDecorator((_data: unknown, _ctx: ExecutionContext): string => {
  return getContext()?.traceId ?? '-';
});

/** 注入客户端 IP（原始值，仅用于哈希，不写日志） */
export const ClientIp = createParamDecorator((_data: unknown, _ctx: ExecutionContext): string => {
  return getContext()?.clientIp ?? '';
});

/** 注入 User-Agent */
export const UserAgent = createParamDecorator((_data: unknown, _ctx: ExecutionContext): string => {
  return getContext()?.userAgent ?? '';
});
