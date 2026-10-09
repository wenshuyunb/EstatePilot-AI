/**
 * 认证与授权守卫。
 *
 * AuthGuard 负责把 Authorization: Bearer <token> 解析成请求上下文里的用户与租户信息。
 * 这是整个多租户隔离体系的入口 —— 只有经过它，后续代码才能拿到 organizationId。
 *
 * RolesGuard 负责角色校验，支持三种约束方式（可组合，全部通过才放行）：
 *   @Roles(...)        限定具体角色
 *   @MinRoleRank(n)    限定最低角色等级
 *   @SuperAdminOnly()  仅平台超管
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiErrorCode, UserRole, USER_ROLE_RANK } from '@estatepilot/types';
import {
  ALLOW_NO_TENANT_KEY,
  IS_PUBLIC_KEY,
  MIN_ROLE_RANK_KEY,
  REQUIRED_ROLES_KEY,
  SUPER_ADMIN_ONLY_KEY,
} from '../decorators/auth.decorators.js';
import { getContext, patchContext } from '../context/request-context.js';
import { TokenError, TokenService } from '../../modules/auth/token.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controller = context.getClass();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller]);
    if (isPublic) return true;

    const allowNoTenant = this.reflector.getAllAndOverride<boolean>(ALLOW_NO_TENANT_KEY, [
      handler,
      controller,
    ]);

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const token = this.extractToken(request.headers.authorization);
    if (!token) {
      if (allowNoTenant) return true;
      throw new UnauthorizedException({
        code: ApiErrorCode.UNAUTHORIZED,
        message: '缺少认证令牌，请先登录',
      });
    }

    try {
      const payload = this.tokens.verifyAccessToken(token);

      // 把用户与租户信息写入请求上下文 —— 后续所有数据访问都依赖它
      patchContext({
        userId: payload.sub,
        organizationId: payload.org,
        storeId: payload.store,
        role: payload.role as UserRole,
        isSuperAdmin: payload.role === UserRole.SUPER_ADMIN,
      });

      return true;
    } catch (error) {
      if (error instanceof TokenError) {
        throw new UnauthorizedException({
          code:
            error.code === 'TOKEN_EXPIRED' ? ApiErrorCode.TOKEN_EXPIRED : ApiErrorCode.UNAUTHORIZED,
          message:
            error.code === 'TOKEN_EXPIRED' ? '登录已过期，请刷新令牌' : '认证令牌无效，请重新登录',
        });
      }

      this.logger.error(`认证守卫异常：${error instanceof Error ? error.message : String(error)}`);
      throw new UnauthorizedException({
        code: ApiErrorCode.UNAUTHORIZED,
        message: '认证失败',
      });
    }
  }

  /** 从 Authorization 头提取 Bearer token */
  private extractToken(header: string | string[] | undefined): string | null {
    if (!header) return null;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match?.[1]?.trim() ?? null;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controller = context.getClass();

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      REQUIRED_ROLES_KEY,
      [handler, controller],
    );
    const minRoleRank = this.reflector.getAllAndOverride<number | undefined>(MIN_ROLE_RANK_KEY, [
      handler,
      controller,
    ]);
    const superAdminOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      SUPER_ADMIN_ONLY_KEY,
      [handler, controller],
    );

    // 没有任何角色约束，只要通过认证即可
    if (!requiredRoles && minRoleRank === undefined && !superAdminOnly) return true;

    const role = getContext()?.role;

    if (!role) {
      throw new UnauthorizedException({
        code: ApiErrorCode.UNAUTHORIZED,
        message: '未获取到用户角色信息',
      });
    }

    // 平台超管放行（但数据访问仍受租户上下文约束，见 TenantService）
    if (role === UserRole.SUPER_ADMIN) return true;

    if (superAdminOnly) {
      this.logger.warn(`角色 ${role} 尝试访问仅限平台超管的接口`);
      throw new ForbiddenException({
        code: ApiErrorCode.FORBIDDEN,
        message: '该操作仅限平台管理员',
      });
    }

    if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(role)) {
      this.logger.warn(`角色 ${role} 尝试访问需要 ${requiredRoles.join('/')} 的接口`);
      throw new ForbiddenException({
        code: ApiErrorCode.FORBIDDEN,
        message: `权限不足：该操作需要 ${requiredRoles.join(' / ')} 角色`,
      });
    }

    if (minRoleRank !== undefined && USER_ROLE_RANK[role] < minRoleRank) {
      this.logger.warn(
        `角色 ${role}（等级 ${USER_ROLE_RANK[role]}）低于要求的等级 ${minRoleRank}`,
      );
      throw new ForbiddenException({
        code: ApiErrorCode.FORBIDDEN,
        message: '权限不足：当前角色等级不够',
      });
    }

    return true;
  }
}
