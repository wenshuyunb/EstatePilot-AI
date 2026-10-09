/**
 * 应用日志。
 *
 * 关键要求：
 * 1. 结构化输出（生产环境 JSON，开发环境可读），便于日志系统采集。
 * 2. **自动脱敏**：任何写进日志的对象都会经过 filterSensitive，
 *    密码、token、密钥、完整手机号绝不出现在日志里。这是合规要求，不是可选项。
 * 3. 每个请求带 traceId，便于把一次请求的所有日志串起来。
 */

import { Injectable, type LoggerService as NestLoggerService } from '@nestjs/common';

/** 需要脱敏的字段名（小写比较） */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'newpassword',
  'oldpassword',
  'confirmpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'api_key',
  'appsecret',
  'app_secret',
  'secret',
  'jwtsecret',
  'privatekey',
  'ipHashSalt'.toLowerCase(),
  'salt',
  'code',
  'verificationcode',
  'captcha',
  'sessionid',
  'creditcard',
  'idcard',
  'bankcard',
]);

/** 需要部分脱敏的字段（保留首尾，中间打码） */
const PARTIAL_MASK_KEYS = new Set(['phone', 'mobile', 'email', 'wechat', 'contactphone']);

const REDACTED = '[已脱敏]';

/** 手机号脱敏：13812345678 → 138****5678 */
function maskPhoneValue(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)}****${digits.slice(7)}`;
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return REDACTED;
}

/** 邮箱脱敏 */
function maskEmailValue(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return REDACTED;
  const local = value.slice(0, at);
  return `${local.slice(0, 2)}***${value.slice(at)}`;
}

/**
 * 递归过滤敏感字段。
 *
 * 注意：这里做的是**深拷贝 + 脱敏**，不修改原对象 ——
 * 否则会污染业务数据，那是更严重的问题。
 */
export function filterSensitive(input: unknown, depth = 0): unknown {
  if (depth > 8) return '[层级过深]';
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    // 字符串本身不按 key 判断，长度截断避免日志爆炸
    return input.length > 2000 ? `${input.slice(0, 2000)}…[已截断]` : input;
  }

  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return input;
  }

  if (input instanceof Date) return input.toISOString();
  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack?.split('\n').slice(0, 5) };
  }

  if (Array.isArray(input)) {
    // 数组只保留前若干项，避免超大行为事件列表把日志写爆
    const limited = input.slice(0, 50);
    const mapped = limited.map((item) => filterSensitive(item, depth + 1));
    return input.length > 50 ? [...mapped, `…还有 ${input.length - 50} 项`] : mapped;
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lower)) {
        out[key] = REDACTED;
        continue;
      }
      if (PARTIAL_MASK_KEYS.has(lower) && typeof value === 'string') {
        out[key] = lower === 'email' ? maskEmailValue(value) : maskPhoneValue(value);
        continue;
      }
      out[key] = filterSensitive(value, depth + 1);
    }
    return out;
  }

  return String(input);
}

/** 日志级别数值，用于过滤 */
const LEVEL_RANK: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LoggerOptions {
  /** 最低输出级别 */
  level: string;
  /** 是否输出人类可读格式（开发环境） */
  pretty: boolean;
  /** 服务名，出现在每条日志中 */
  service?: string;
}

/** 解析 traceId 的请求上下文 */
export interface LogContext {
  traceId?: string;
  userId?: string;
  organizationId?: string;
  [key: string]: unknown;
}

@Injectable()
export class AppLogger implements NestLoggerService {
  private readonly minRank: number;
  private readonly pretty: boolean;
  private readonly service: string;

  constructor(options: LoggerOptions) {
    this.minRank = LEVEL_RANK[options.level] ?? LEVEL_RANK.info!;
    this.pretty = options.pretty;
    this.service = options.service ?? 'estatepilot-api';
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  /** 带上下文的结构化日志，业务代码首选这个 */
  info(message: string, context?: LogContext): void {
    this.write('info', message, undefined, undefined, context);
  }

  /**
   * 子日志器，自动带上固定上下文（如 traceId、organizationId）。
   * 用组合实现而不是修改原型，避免共享状态被污染。
   */
  child(context: LogContext): AppLogger {
    const parent = this;
    const childLogger = Object.create(AppLogger.prototype) as AppLogger;
    Object.defineProperties(childLogger, {
      minRank: { value: parent.minRank, enumerable: false },
      pretty: { value: parent.pretty, enumerable: false },
      service: { value: parent.service, enumerable: false },
      baseContext: { value: context, enumerable: false },
      write: {
        enumerable: false,
        value: (
          level: string,
          message: unknown,
          ctx?: string,
          stack?: string,
          extra?: LogContext,
        ) => {
          parent.write(level, message, ctx, stack, { ...context, ...extra });
        },
      },
    });
    return childLogger;
  }

  /** 核心写入方法 */
  write(
    level: string,
    message: unknown,
    context?: string,
    stack?: string,
    extra?: LogContext,
  ): void {
    const rank = LEVEL_RANK[level] ?? LEVEL_RANK.info!;
    if (rank < this.minRank) return;

    const timestamp = new Date().toISOString();
    const safeMessage = filterSensitive(message);
    const safeExtra = extra ? (filterSensitive(extra) as LogContext) : undefined;

    if (this.pretty) {
      const levelTag = level.toUpperCase().padEnd(5);
      const contextTag = context ? ` [${context}]` : '';
      const traceTag = safeExtra?.traceId ? ` (${String(safeExtra.traceId).slice(0, 8)})` : '';
      const body = typeof safeMessage === 'string' ? safeMessage : JSON.stringify(safeMessage);
      const extraText =
        safeExtra && Object.keys(safeExtra).length > 0
          ? `\n  ${JSON.stringify(safeExtra, null, 0)}`
          : '';
      // eslint-disable-next-line no-console
      console.log(`${timestamp} ${levelTag}${contextTag}${traceTag} ${body}${extraText}`);
      if (stack) console.log(stack);
      return;
    }

    // 生产环境：单行 JSON，便于日志采集系统解析
    const record: Record<string, unknown> = {
      timestamp,
      level,
      service: this.service,
      message: safeMessage,
    };
    if (context) record.context = context;
    if (safeExtra) Object.assign(record, safeExtra);
    if (stack) record.stack = stack.split('\n').slice(0, 10);

    const line = JSON.stringify(record);
    if (rank >= LEVEL_RANK.error!) {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}
