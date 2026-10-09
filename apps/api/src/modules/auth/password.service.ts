/**
 * 密码哈希服务。
 *
 * 使用 argon2id —— 当前 OWASP 推荐的密码哈希算法。
 * 参数选择依据（2026 年硬件水平，目标单次哈希 50～100ms）：
 *   memoryCost 19456 KiB (19 MiB) —— OWASP 最低推荐值
 *   timeCost 2
 *   parallelism 1
 *
 * argon2 是原生模块（pnpm-workspace.yaml 中已放行构建）。
 * 若原生模块在目标环境不可用，会自动降级到 Node 内置的 scrypt，
 * 降级时会在哈希串中标明算法，登录校验按算法分派 —— 保证服务不中断。
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import argon2 from 'argon2';

const scryptAsync = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** scrypt 参数（降级方案） */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** 哈希串前缀，用于标识算法 */
const ARGON2_PREFIX = 'argon2id';
const SCRYPT_PREFIX = 'scrypt';

export interface PasswordHashResult {
  hash: string;
  algorithm: 'argon2id' | 'scrypt';
}

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private argon2Available = true;

  /** 密码策略：至少 8 位，且不能是常见弱口令 */
  static readonly MIN_LENGTH = 8;
  static readonly MAX_LENGTH = 128;

  private static readonly WEAK_PASSWORDS = new Set([
    '12345678',
    '123456789',
    '1234567890',
    'password',
    'password1',
    'qwertyui',
    'abc12345',
    'admin123',
    'iloveyou',
    '88888888',
    '11111111',
    '00000000',
  ]);

  /**
   * 校验密码强度。
   * 返回错误信息数组，空数组表示通过。
   */
  validateStrength(password: string): string[] {
    const errors: string[] = [];

    if (password.length < PasswordService.MIN_LENGTH) {
      errors.push(`密码至少需要 ${PasswordService.MIN_LENGTH} 位`);
    }
    if (password.length > PasswordService.MAX_LENGTH) {
      errors.push(`密码不能超过 ${PasswordService.MAX_LENGTH} 位`);
    }
    if (PasswordService.WEAK_PASSWORDS.has(password.toLowerCase())) {
      errors.push('密码过于常见，请更换');
    }
    // 至少包含两类字符（字母 / 数字 / 符号）
    const categories = [/[a-zA-Z]/, /\d/, /[^a-zA-Z\d]/].filter((pattern) => pattern.test(password));
    if (categories.length < 2) {
      errors.push('密码需要同时包含字母与数字（或符号）');
    }
    if (/^(.)\1+$/.test(password)) {
      errors.push('密码不能是单一字符的重复');
    }

    return errors;
  }

  /** 生成密码哈希 */
  async hash(password: string): Promise<PasswordHashResult> {
    if (this.argon2Available) {
      try {
        const hash = await argon2.hash(password, ARGON2_OPTIONS);
        return { hash, algorithm: 'argon2id' };
      } catch (error) {
        this.argon2Available = false;
        this.logger.warn(
          `argon2 不可用，降级到 scrypt：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt, 64, SCRYPT_PARAMS);
    const { N, r, p } = SCRYPT_PARAMS;
    return {
      hash: `${SCRYPT_PREFIX}$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`,
      algorithm: 'scrypt',
    };
  }

  /**
   * 校验密码。
   * 使用 timingSafeEqual 做常量时间比较，避免时序攻击。
   */
  async verify(password: string, storedHash: string): Promise<boolean> {
    if (!storedHash) return false;

    try {
      if (storedHash.startsWith(`$${ARGON2_PREFIX}$`) || storedHash.startsWith('$argon2')) {
        return await argon2.verify(storedHash, password);
      }

      if (storedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
        const parts = storedHash.split('$');
        // scrypt$N$r$p$salt$hash
        if (parts.length !== 6) return false;
        const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
        const N = Number(nStr);
        const r = Number(rStr);
        const p = Number(pStr);
        if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

        const salt = Buffer.from(saltB64 as string, 'base64');
        const expected = Buffer.from(hashB64 as string, 'base64');
        const derived = await scryptAsync(password, salt, expected.length, {
          N,
          r,
          p,
          maxmem: 128 * N * r * 2,
        });

        if (derived.length !== expected.length) return false;
        return timingSafeEqual(derived, expected);
      }

      // 未知算法：拒绝而不是静默通过
      this.logger.error('遇到未知的密码哈希格式，拒绝校验');
      return false;
    } catch (error) {
      this.logger.error(
        `密码校验异常：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** 判断哈希是否需要升级（如参数已过时） */
  needsRehash(storedHash: string): boolean {
    if (storedHash.startsWith(`${SCRYPT_PREFIX}$`)) return true;
    if (storedHash.startsWith('$argon2id$')) {
      // 检查参数是否低于当前标准
      const memoryMatch = /\$m=(\d+),/.exec(storedHash);
      const timeMatch = /\$t=(\d+),/.exec(storedHash);
      const memory = memoryMatch?.[1] ? Number(memoryMatch[1]) : 0;
      const time = timeMatch?.[1] ? Number(timeMatch[1]) : 0;
      return memory < ARGON2_OPTIONS.memoryCost || time < ARGON2_OPTIONS.timeCost;
    }
    return true;
  }

  /** 生成随机密码（用于种子数据与管理员重置密码） */
  generateRandomPassword(length = 16): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const bytes = randomBytes(length);
    let out = '';
    for (const byte of bytes) {
      out += alphabet[byte % alphabet.length];
    }
    return out;
  }
}
