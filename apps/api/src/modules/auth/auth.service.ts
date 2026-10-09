/**
 * 认证服务。
 *
 * 覆盖完整的安全要点：
 * - 登录失败计数 + 账号临时锁定（防暴力破解）
 * - 登录时不区分「用户不存在」与「密码错误」，避免账号枚举
 * - Refresh Token 轮换 + 重放检测（检测到重放立即吊销整个会话家族）
 * - 密码升级（哈希参数过时自动重新哈希）
 * - 所有登录事件写审计日志
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  UserRole,
  UserStatus,
  type AuthUser,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';
import { PasswordService } from './password.service.js';
import { TokenError, TokenService } from './token.service.js';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';

/** 登录失败上限，超过则锁定 */
const MAX_FAILED_ATTEMPTS = 5;
/** 锁定时长（分钟） */
const LOCK_DURATION_MINUTES = 15;

export class AuthError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 401) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = 'AuthError';
  }
}

/** 用户表在 Prisma 中的形状（仅列出本服务用到的字段） */
interface UserRow {
  id: string;
  organizationId: string;
  storeId: string | null;
  email: string;
  phone: string | null;
  name: string;
  avatarUrl: string | null;
  passwordHash: string;
  role: string;
  status: string;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

export interface LoginInput {
  email: string;
  password: string;
  /** 客户端信息，用于审计与 token 绑定 */
  userAgent?: string;
  ipHash?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  /** access token 过期秒数 */
  expiresIn: number;
  user: AuthUser;
  organization: {
    id: string;
    name: string;
    shortName: string | null;
  };
  /** 是否使用了降级哈希算法（仅开发提示） */
  passwordRehashed?: boolean;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly tenant: TenantService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 登录。
   *
   * 注意：登录时还不知道 organizationId（用户可能属于任意租户），
   * 因此这里必须用 forSystem() 跨租户查询 —— 这是少数几个正当场景之一。
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const prisma = this.tenant.forSystem();

    // 跨租户按邮箱查用户。邮箱在同一组织内唯一，跨组织可能重复，
    // 因此取第一条并优先选 ACTIVE 状态。
    const user = (await prisma.user.findFirst({
      where: { email },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        storeId: true,
        email: true,
        phone: true,
        name: true,
        avatarUrl: true,
        passwordHash: true,
        role: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
      },
    })) as UserRow | null;

    // 账号不存在：走一遍假的密码校验，让响应时间与密码错误一致，
    // 避免通过响应时间差枚举出哪些邮箱已注册。
    if (!user) {
      await this.passwords.verify(input.password, '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2g');
      this.logger.warn(`登录失败（账号不存在）：${email}`);
      throw new AuthError('INVALID_CREDENTIALS', '邮箱或密码不正确');
    }

    // 账号锁定检查
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const remainingMinutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      this.logger.warn(`登录被拒（账号锁定中）：${email}，剩余 ${remainingMinutes} 分钟`);
      throw new AuthError(
        'ACCOUNT_LOCKED',
        `账号因多次登录失败已被临时锁定，请 ${remainingMinutes} 分钟后重试`,
        423,
      );
    }

    // 账号状态检查
    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.DEACTIVATED) {
      this.logger.warn(`登录被拒（账号已停用）：${email}`);
      throw new AuthError('ACCOUNT_DISABLED', '账号已被停用，请联系管理员', 403);
    }

    // 密码校验
    const passwordValid = await this.passwords.verify(input.password, user.passwordHash);

    if (!passwordValid) {
      await this.recordFailedAttempt(user, email, input);
      throw new AuthError('INVALID_CREDENTIALS', '邮箱或密码不正确');
    }

    // 密码正确：清理失败计数
    // 若哈希参数已过时，顺带升级
    let passwordRehashed = false;
    const updateData: Record<string, unknown> = {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: input.ipHash ?? null,
    };

    if (this.passwords.needsRehash(user.passwordHash)) {
      try {
        const rehashed = await this.passwords.hash(input.password);
        updateData.passwordHash = rehashed.hash;
        updateData.passwordChangedAt = new Date();
        passwordRehashed = true;
      } catch (error) {
        // 升级失败不应阻断登录
        this.logger.warn(
          `密码哈希升级失败（不影响本次登录）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await prisma.user.update({ where: { id: user.id }, data: updateData });

    // 签发令牌
    const familyId = this.tokens.newFamilyId();
    const access = this.tokens.signAccessToken({
      userId: user.id,
      organizationId: user.organizationId,
      storeId: user.storeId,
      role: user.role as UserRole,
    });
    const refresh = this.tokens.signRefreshToken({
      userId: user.id,
      organizationId: user.organizationId,
      storeId: user.storeId,
      role: user.role as UserRole,
      familyId,
      generation: 0,
    });

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.tokenHash,
        familyId,
        generation: 0,
        userAgent: input.userAgent ?? null,
        ipHash: input.ipHash ?? null,
        expiresAt: new Date(refresh.expiresAt * 1000),
      },
    });

    // 取组织信息
    const organization = await prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { id: true, name: true, shortName: true },
    });

    await this.writeAuditLog(user, AuditAction.LOGIN, input, '登录成功');

    this.logger.log(`登录成功：${email}（组织 ${user.organizationId}）`);

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: this.tokens.accessTtl,
      user: {
        id: user.id,
        organizationId: user.organizationId,
        storeId: user.storeId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
        role: user.role as UserRole,
        status: user.status as UserStatus,
      },
      organization: {
        id: organization?.id ?? user.organizationId,
        name: organization?.name ?? '',
        shortName: organization?.shortName ?? null,
      },
      passwordRehashed,
    };
  }

  /**
   * 刷新令牌。
   *
   * 轮换与重放检测逻辑：
   * 1. 校验 refresh token 签名与类型。
   * 2. 在数据库中查找该 token 的哈希记录。
   * 3. 若记录不存在 → token 可能是伪造的，也可能是历史遗留，直接拒绝。
   * 4. 若记录已被使用（usedAt 非空）或已撤销 → **重放攻击**，
   *    立即吊销整个家族（该次登录签发的所有 refresh token），
   *    因为合法客户端不会重复使用已轮换的 token。
   * 5. 正常情况：标记旧 token 已用，签发新 token（generation + 1）。
   */
  async refresh(refreshToken: string, meta: { userAgent?: string; ipHash?: string }): Promise<RefreshResult> {
    let payload: ReturnType<TokenService['verifyRefreshToken']>;
    try {
      payload = this.tokens.verifyRefreshToken(refreshToken);
    } catch (error) {
      if (error instanceof TokenError) {
        throw new AuthError(error.code, error.message, error.code === 'TOKEN_EXPIRED' ? 401 : 401);
      }
      throw new AuthError('INVALID_TOKEN', '刷新令牌无效');
    }

    const prisma = this.tenant.forSystem();
    const tokenHash = this.tokens.hashToken(refreshToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        generation: true,
        usedAt: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (!stored) {
      this.logger.warn(`刷新失败：数据库中不存在该令牌哈希（可能是伪造或已被清理）`);
      throw new AuthError('INVALID_TOKEN', '刷新令牌无效');
    }

    // ---- 重放检测 ----
    if (stored.usedAt || stored.revokedAt) {
      this.logger.error(
        `检测到 refresh token 重放！会话家族 ${stored.familyId} 将被整体吊销。` +
          `用户 ${stored.userId}，已用=${Boolean(stored.usedAt)}，已撤销=${Boolean(stored.revokedAt)}`,
      );

      await prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'REPLAY_DETECTED' },
      });

      await this.writeAuditLogRaw(
        stored.userId,
        AuditAction.LOGIN_FAILED,
        '检测到刷新令牌重放，已吊销该会话全部令牌',
      );

      throw new AuthError(
        'REFRESH_TOKEN_REUSED',
        '检测到令牌被重复使用，出于安全考虑该登录会话已失效，请重新登录',
        401,
      );
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new AuthError('TOKEN_EXPIRED', '刷新令牌已过期，请重新登录');
    }

    // 取用户最新状态（可能已被停用或改了角色）
    const user = (await prisma.user.findUnique({
      where: { id: stored.userId },
      select: {
        id: true,
        organizationId: true,
        storeId: true,
        role: true,
        status: true,
      },
    })) as
      | { id: string; organizationId: string; storeId: string | null; role: string; status: string }
      | null;

    if (!user) {
      throw new AuthError('USER_NOT_FOUND', '用户不存在', 401);
    }
    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.DEACTIVATED) {
      throw new AuthError('ACCOUNT_DISABLED', '账号已被停用', 403);
    }

    // ---- 正常轮换 ----
    const nextGeneration = stored.generation + 1;
    const access = this.tokens.signAccessToken({
      userId: user.id,
      organizationId: user.organizationId,
      storeId: user.storeId,
      role: user.role as UserRole,
    });
    const nextRefresh = this.tokens.signRefreshToken({
      userId: user.id,
      organizationId: user.organizationId,
      storeId: user.storeId,
      role: user.role as UserRole,
      familyId: stored.familyId,
      generation: nextGeneration,
    });

    // 用事务保证「作废旧 token」与「写入新 token」同时成功，
    // 否则中间失败会让用户既没有旧 token 也没有新 token。
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: nextRefresh.tokenHash,
          familyId: stored.familyId,
          generation: nextGeneration,
          userAgent: meta.userAgent ?? null,
          ipHash: meta.ipHash ?? null,
          expiresAt: new Date(nextRefresh.expiresAt * 1000),
        },
      }),
    ]);

    return {
      accessToken: access.token,
      refreshToken: nextRefresh.token,
      expiresIn: this.tokens.accessTtl,
    };
  }

  /** 登出：吊销该次会话的全部 refresh token */
  async logout(refreshToken: string | undefined, userId: string | null): Promise<{ revoked: number }> {
    const prisma = this.tenant.forSystem();

    if (refreshToken) {
      try {
        const payload = this.tokens.verifyRefreshToken(refreshToken);
        const result = await prisma.refreshToken.updateMany({
          where: { familyId: payload.fam, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'USER_LOGOUT' },
        });
        if (userId) {
          await this.writeAuditLogRaw(userId, AuditAction.LOGOUT, '用户登出');
        }
        return { revoked: result.count };
      } catch {
        // token 无效也视为登出成功（幂等），但吊销全部会话
      }
    }

    if (userId) {
      const result = await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'USER_LOGOUT_ALL' },
      });
      await this.writeAuditLogRaw(userId, AuditAction.LOGOUT, '用户登出（吊销全部会话）');
      return { revoked: result.count };
    }

    return { revoked: 0 };
  }

  /** 取当前用户完整信息（用于 /auth/me） */
  async getCurrentUser(userId: string, organizationId: string): Promise<AuthUser | null> {
    // 已登录用户，走租户作用域（安全）
    const scope = this.tenant.scopeFor(organizationId);
    const user = await scope.findFirst<{
      id: string;
      organizationId: string;
      storeId: string | null;
      name: string;
      email: string;
      phone: string | null;
      avatarUrl: string | null;
      role: string;
      status: string;
    }>('User', {
      where: { id: userId },
      select: {
        id: true,
        organizationId: true,
        storeId: true,
        name: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        status: true,
      },
    });

    if (!user) return null;
    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.DEACTIVATED) return null;

    return {
      id: user.id,
      organizationId: user.organizationId,
      storeId: user.storeId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      role: user.role as UserRole,
      status: user.status as UserStatus,
    };
  }

  /** 取当前用户所属组织信息 */
  async getOrganization(organizationId: string): Promise<{
    id: string;
    name: string;
    shortName: string | null;
    city: string | null;
    brandName: string | null;
  } | null> {
    // 说明：Organization 是租户的根实体，它自身没有 organizationId 字段，
    // 因此不在 TenantScope 白名单里。这里用 forSystem() 按主键精确查询，
    // 主键来自已验证的 JWT，不存在越权读取其他组织信息的风险。
    return this.tenant.forSystem().organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, shortName: true, city: true, brandName: true },
    });
  }

  /** 记录一次登录失败，达到阈值则锁定账号 */
  private async recordFailedAttempt(user: UserRow, email: string, input: LoginInput): Promise<void> {
    const prisma = this.tenant.forSystem();
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: shouldLock
          ? new Date(Date.now() + LOCK_DURATION_MINUTES * 60_000)
          : user.lockedUntil,
      },
    });

    if (shouldLock) {
      this.logger.warn(
        `账号因连续 ${attempts} 次登录失败被锁定 ${LOCK_DURATION_MINUTES} 分钟：${email}`,
      );
    } else {
      this.logger.warn(`登录失败（密码错误，第 ${attempts} 次）：${email}`);
    }

    await this.writeAuditLogRaw(user.id, AuditAction.LOGIN_FAILED, `登录失败，第 ${attempts} 次`, {
      organizationId: user.organizationId,
      ip: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
    });
  }

  /** 写审计日志（已登录用户） */
  private async writeAuditLog(
    user: UserRow,
    action: AuditAction,
    input: LoginInput,
    message: string,
  ): Promise<void> {
    await this.writeAuditLogRaw(user.id, action, message, {
      organizationId: user.organizationId,
      ip: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
    });
  }

  /**
   * 写审计日志底层方法。
   * 审计日志失败绝不能阻断主流程，因此这里吞掉异常并只记 warn。
   */
  private async writeAuditLogRaw(
    userId: string | null,
    action: AuditAction,
    message: string,
    extra: { organizationId?: string; ip?: string | null; userAgent?: string | null } = {},
  ): Promise<void> {
    try {
      const organizationId =
        extra.organizationId ??
        (await this.resolveOrganizationId(userId));

      if (!organizationId) return;

      await this.tenant.forSystem().auditLog.create({
        data: {
          organizationId,
          userId,
          action,
          entity: 'User',
          entityId: userId,
          message,
          ip: extra.ip ?? null,
          userAgent: extra.userAgent ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `写审计日志失败（不影响主流程）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 根据用户 ID 反查组织 ID（审计日志需要） */
  private async resolveOrganizationId(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await this.tenant.forSystem().user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    return user?.organizationId ?? null;
  }
}
