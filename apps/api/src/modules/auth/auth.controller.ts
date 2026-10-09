/**
 * 认证控制器。
 *
 * 接口设计说明：
 * - 登录与刷新用 @Public()（此时还没有 token）。
 * - refresh token 通过 httpOnly Cookie 或请求体传递。
 *   这里采用**请求体**方式：前端把 refresh token 存在安全的地方，
 *   便于移动端与桌面端统一处理，也避免 CORS + Cookie 的复杂性。
 *   生产环境若同域部署，可以改成 httpOnly Cookie（更防 XSS）。
 * - 所有接口都返回统一的响应结构，由全局拦截器包装。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { ApiErrorCode } from '@estatepilot/types';
import { AuthService, type LoginResult, type RefreshResult } from './auth.service.js';
import { ZodBody } from '../../common/pipes/zod-validation.pipe.js';
import {
  ClientIp,
  CurrentUser,
  Public,
  UserAgent,
  type RequestUser,
} from '../../common/decorators/auth.decorators.js';
import { BusinessError } from '../../common/filters/all-exceptions.filter.js';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';
import { hashIp } from '@estatepilot/utils';

/** 登录请求 */
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('请输入有效的邮箱地址'),
  password: z.string().min(1, '请输入密码').max(128),
});

/** 刷新令牌请求 */
const refreshSchema = z.object({
  refreshToken: z.string().min(10, '缺少刷新令牌'),
});

/** 登出请求 */
const logoutSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

type LoginInput = z.infer<typeof loginSchema>;
type RefreshInput = z.infer<typeof refreshSchema>;
type LogoutInput = z.infer<typeof logoutSchema>;

@Controller('auth')
export class AuthController {
  // AuthService 是类，NestJS 能从类型元数据解析；AppConfig 是 Symbol 令牌，必须显式 @Inject
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 登录。
   * POST /api/v1/auth/login
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(ZodBody(loginSchema)) body: LoginInput,
    @UserAgent() userAgent: string,
    @ClientIp() clientIp: string,
  ): Promise<LoginResult> {
    // IP 只存加盐哈希，不存明文 —— 合规要求
    const ipHash = clientIp ? await hashIp(clientIp, this.config.auth.ipHashSalt) : undefined;

    return this.auth.login({
      email: body.email,
      password: body.password,
      userAgent: userAgent || undefined,
      ipHash,
    });
  }

  /**
   * 刷新令牌（轮换 + 重放检测）。
   * POST /api/v1/auth/refresh
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(ZodBody(refreshSchema)) body: RefreshInput,
    @UserAgent() userAgent: string,
    @ClientIp() clientIp: string,
  ): Promise<RefreshResult> {
    const ipHash = clientIp ? await hashIp(clientIp, this.config.auth.ipHashSalt) : undefined;
    return this.auth.refresh(body.refreshToken, {
      userAgent: userAgent || undefined,
      ipHash,
    });
  }

  /**
   * 登出：吊销该会话（或该用户全部）的 refresh token。
   * POST /api/v1/auth/logout
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body(ZodBody(logoutSchema)) body: LogoutInput,
    @CurrentUser() user: RequestUser,
  ): Promise<{ success: true; revoked: number }> {
    const result = await this.auth.logout(body.refreshToken, user.id);
    return { success: true, revoked: result.revoked };
  }

  /**
   * 取当前登录用户信息。
   * GET /api/v1/auth/me
   */
  @Get('me')
  async me(@CurrentUser() user: RequestUser): Promise<{
    user: unknown;
    organization: unknown;
    permissions: { canManageUsers: boolean; canViewAllStores: boolean; canConfigure: boolean };
  }> {
    const current = await this.auth.getCurrentUser(user.id, user.organizationId);
    if (!current) {
      throw new BusinessError(
        ApiErrorCode.UNAUTHORIZED,
        '登录状态已失效，请重新登录',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 权限快照，前端据此隐藏无权操作的入口（服务端仍会二次校验）
    const organization = await this.auth.getOrganization(user.organizationId);

    return {
      user: current,
      organization,
      permissions: {
        canManageUsers: ['OWNER', 'STORE_MANAGER', 'SUPER_ADMIN'].includes(current.role),
        canViewAllStores: ['OWNER', 'SUPER_ADMIN'].includes(current.role),
        canConfigure: ['OWNER', 'SUPER_ADMIN'].includes(current.role),
      },
    };
  }
}
