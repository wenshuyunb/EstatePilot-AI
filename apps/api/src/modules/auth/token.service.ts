/**
 * JWT 令牌服务。
 *
 * 为什么手写 JWT 而不用 @nestjs/jwt：
 * 本项目的 token 需要携带租户信息（org / store / role）并支持 refresh token 轮换
 * 与重放检测，签名算法固定为 HS256。手写实现只有 RS256 之类非对称算法才真正复杂，
 * HS256 的签验就是 HMAC-SHA256 + base64url，代码量很小且完全可测 ——
 * 这样也避免了额外依赖带来的供应链面。
 *
 * 安全设计：
 * 1. access token 与 refresh token 用**不同的密钥**签名，且 token 内标明 typ，
 *    即使密钥泄露其一也不能互换使用。
 * 2. refresh token 只存 SHA-256 哈希到数据库，明文只返回给客户端一次。
 * 3. 轮换 + 重放检测：每次刷新都作废旧 token 并签发新的；
 *    若检测到已作废的 token 被再次使用，立即吊销**整个家族**（该次登录的所有 token），
 *    因为这意味着 token 已泄露给第三方。
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { JwtPayload, UserRole } from '@estatepilot/types';
import type { AppConfig } from '../../config/configuration.js';

export class TokenError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'TokenError';
  }
}

/** 签发 access token 的输入 */
export interface SignAccessTokenInput {
  userId: string;
  organizationId: string;
  storeId: string | null;
  role: UserRole;
}

/** 签发 refresh token 的输入 */
export interface SignRefreshTokenInput {
  userId: string;
  organizationId: string;
  storeId: string | null;
  role: UserRole;
  /** 登录会话家族 ID，同一会话的所有 refresh token 共享 */
  familyId: string;
  /** 轮换代数 */
  generation: number;
}

export interface SignedToken {
  token: string;
  /** 过期时间（秒级时间戳） */
  expiresAt: number;
  /** token 的 SHA-256 哈希，用于入库 */
  tokenHash: string;
}

/** base64url 编码 */
function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码 */
function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, 'base64');
}

/** 解析时长字符串（15m / 30d / 3600s / 7200）为秒 */
export function parseDurationToSeconds(input: string): number {
  const trimmed = input.trim();
  const match = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(trimmed);
  if (!match?.[1]) {
    throw new TokenError('INVALID_DURATION', `无效的时长格式：${input}（示例：15m、30d、3600s）`);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
  return value * (multipliers[unit] ?? 1);
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(private readonly config: AppConfig) {
    this.accessSecret = config.auth.jwtSecret;
    this.refreshSecret = config.auth.jwtRefreshSecret;
    this.accessTtlSeconds = parseDurationToSeconds(config.auth.accessTtl);
    this.refreshTtlSeconds = parseDurationToSeconds(config.auth.refreshTtl);

    // 双密钥必须不同，否则 refresh 可当 access 用；配置层已校验，这里再兜一次
    if (this.accessSecret === this.refreshSecret) {
      throw new TokenError('CONFIG_ERROR', 'JWT_SECRET 与 JWT_REFRESH_SECRET 不能相同');
    }
  }

  /** access token 有效期（秒） */
  get accessTtl(): number {
    return this.accessTtlSeconds;
  }

  /** refresh token 有效期（秒） */
  get refreshTtl(): number {
    return this.refreshTtlSeconds;
  }

  /** 计算 token 的 SHA-256 哈希（hex），用于入库 */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 生成新的会话家族 ID */
  newFamilyId(): string {
    return randomBytes(16).toString('hex');
  }

  /** 签发 access token */
  signAccessToken(input: SignAccessTokenInput): SignedToken {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.accessTtlSeconds;

    const payload: JwtPayload = {
      sub: input.userId,
      org: input.organizationId,
      store: input.storeId,
      role: input.role,
      typ: 'access',
      iat: now,
      exp: expiresAt,
    };

    const token = this.encode(payload, this.accessSecret);
    return { token, expiresAt, tokenHash: this.hashToken(token) };
  }

  /** 签发 refresh token */
  signRefreshToken(input: SignRefreshTokenInput): SignedToken {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.refreshTtlSeconds;

    const payload: JwtPayload = {
      sub: input.userId,
      org: input.organizationId,
      store: input.storeId,
      role: input.role,
      typ: 'refresh',
      gen: input.generation,
      iat: now,
      exp: expiresAt,
    };

    // refresh token 额外带上家族 ID，便于重放时整族吊销
    const token = this.encode({ ...payload, fam: input.familyId } as JwtPayload & { fam: string }, this.refreshSecret);
    return { token, expiresAt, tokenHash: this.hashToken(token) };
  }

  /**
   * 校验并解析 access token。
   * @throws TokenError 当签名无效、已过期或类型不符时
   */
  verifyAccessToken(token: string): JwtPayload {
    return this.verify(token, this.accessSecret, 'access');
  }

  /**
   * 校验并解析 refresh token。
   * @throws TokenError
   */
  verifyRefreshToken(token: string): JwtPayload & { fam: string } {
    const payload = this.verify(token, this.refreshSecret, 'refresh');
    if (typeof (payload as { fam?: unknown }).fam !== 'string') {
      throw new TokenError('INVALID_TOKEN', 'refresh token 缺少会话标识');
    }
    return payload as JwtPayload & { fam: string };
  }

  /** 编码 JWT。JSON.stringify 会忽略 TypeScript 的类型签名，这里只需可序列化对象 */
  private encode(payload: object, secret: string): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = base64UrlEncode(createHmac('sha256', secret).update(signingInput).digest());
    return `${signingInput}.${signature}`;
  }

  /** 解码并校验 JWT */
  private verify(token: string, secret: string, expectedType: 'access' | 'refresh'): JwtPayload {
    if (!token || typeof token !== 'string') {
      throw new TokenError('INVALID_TOKEN', 'token 为空');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new TokenError('INVALID_TOKEN', 'token 格式不正确');
    }

    const [encodedHeader, encodedPayload, providedSignature] = parts as [string, string, string];

    // 1. 校验头部算法，防止 alg=none 攻击
    let header: { alg?: string; typ?: string };
    try {
      header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as {
        alg?: string;
        typ?: string;
      };
    } catch {
      throw new TokenError('INVALID_TOKEN', 'token 头部无法解析');
    }

    if (header.alg !== 'HS256') {
      throw new TokenError('INVALID_TOKEN', `不支持的签名算法：${String(header.alg)}`);
    }

    // 2. 校验签名（常量时间比较）
    const expectedSignature = base64UrlEncode(
      createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest(),
    );
    const provided = Buffer.from(providedSignature, 'utf8');
    const expected = Buffer.from(expectedSignature, 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new TokenError('INVALID_SIGNATURE', 'token 签名校验失败');
    }

    // 3. 解析载荷
    let payload: JwtPayload;
    try {
      payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as JwtPayload;
    } catch {
      throw new TokenError('INVALID_TOKEN', 'token 载荷无法解析');
    }

    // 4. 校验类型，防止 refresh 被当 access 使用
    if (payload.typ !== expectedType) {
      throw new TokenError(
        'WRONG_TOKEN_TYPE',
        `token 类型不匹配：期望 ${expectedType}，实际 ${String(payload.typ)}`,
      );
    }

    // 5. 校验必需字段
    if (!payload.sub || !payload.org || !payload.role) {
      throw new TokenError('INVALID_TOKEN', 'token 缺少必需字段');
    }

    // 6. 校验过期时间，并留 5 秒时钟偏移容忍
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number') {
      throw new TokenError('INVALID_TOKEN', 'token 缺少过期时间');
    }
    if (payload.exp + 5 < now) {
      throw new TokenError('TOKEN_EXPIRED', 'token 已过期');
    }

    return payload;
  }
}
