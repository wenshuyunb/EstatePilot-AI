/**
 * 应用配置。
 *
 * 设计原则：**启动即失败**。
 * 缺少关键配置（如 JWT_SECRET）时直接让进程退出，而不是等到第一个请求进来才报错 ——
 * 生产环境里"带病启动"比"启动失败"危险得多。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { AiProviderKind } from '@estatepilot/types';

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/api/src/config → 仓库根目录 */
const repoRoot = path.resolve(here, '..', '..', '..', '..');

// 统一从仓库根目录的 .env 读取（monorepo 单一配置源）
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(repoRoot, 'apps/api/.env'), override: true, quiet: true });

/** 逗号分隔字符串 → 字符串数组 */
const commaSeparated = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.string()));

/** 布尔字符串。用 .optional() + transform 代替 .default()，
 *  这样在 Zod 4 下类型推断最稳定，且未设置时得到 undefined 后再由调用处补默认值。 */
const booleanString = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value === '') return undefined;
    return value === 'true' || value === '1';
  });

/** 配置 Schema */
const envSchema = z.object({
  // ---- 运行环境 ----
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  API_BASE_URL: z.string().url().default('http://localhost:3001'),

  // ---- 数据库 ----
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),

  // ---- Redis ----
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // ---- 认证 ----
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少需要 32 个字符（生产环境请用 openssl rand -base64 48 生成）'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET 至少需要 32 个字符，且必须与 JWT_SECRET 不同'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  IP_HASH_SALT: z.string().min(8, 'IP_HASH_SALT 至少需要 8 个字符'),

  // ---- CORS ----
  CORS_ORIGINS: commaSeparated.default(['http://localhost:3000']),

  // ---- 限流 ----
  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  BEHAVIOR_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  // ---- AI ----
  AI_PROVIDER: z.enum(['mock', 'deepseek', 'openai', 'anthropic']).default('mock'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),

  // ---- 房源 Provider ----
  PROPERTY_PROVIDER: z.enum(['MOCK', 'BEIKE', 'ANJUKE', 'INTERNAL']).default('MOCK'),
  PROPERTY_SYNC_ENABLED: booleanString,
  PROPERTY_SYNC_CRON: z.string().default('0 */6 * * *'),
  BEIKE_APP_ID: z.string().optional(),
  BEIKE_APP_KEY: z.string().optional(),
  BEIKE_APP_SECRET: z.string().optional(),
  BEIKE_BASE_URL: z.string().url().default('https://open.beike.com'),
  BEIKE_CITY_CODE: z.string().default('310000'),
  BEIKE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

  // ---- 队列 ----
  QUEUE_ENABLED: booleanString,
  QUEUE_PREFIX: z.string().default('estatepilot'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),

  // ---- 日志 ----
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanString,
  LOG_DIR: z.string().default('./logs'),
});

export type EnvConfig = z.infer<typeof envSchema>;

/** 校验后的配置对象 */
let cachedConfig: EnvConfig | null = null;

/**
 * 读取并校验环境变量。
 * 校验失败时打印**所有**错误再退出，避免"改一个报一个"的反复。
 */
export function loadConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ✗ ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    // 使用 console 而非 Logger：此时日志系统还没初始化
    console.error(
      `\n[配置校验失败] 以下环境变量不合法，进程将退出：\n${issues}\n\n` +
        `请检查 ${path.join(repoRoot, '.env')}（可从 .env.example 复制）。\n`,
    );
    process.exit(1);
  }

  // 额外业务校验：生产环境不允许用默认的弱密钥
  if (parsed.data.NODE_ENV === 'production') {
    const weakMarkers = ['CHANGE_ME', 'dev_only', 'test_secret', 'secret123'];
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'IP_HASH_SALT'] as const) {
      const value = parsed.data[key];
      if (weakMarkers.some((marker) => value.includes(marker))) {
        console.error(
          `\n[配置校验失败] 生产环境的 ${key} 仍包含开发占位符，进程将退出。\n` +
            `请用 openssl rand -base64 48 生成强随机值。\n`,
        );
        process.exit(1);
      }
    }
  }

  // JWT 与 refresh 密钥必须不同，否则 refresh token 可以被当 access token 用
  if (parsed.data.JWT_SECRET === parsed.data.JWT_REFRESH_SECRET) {
    console.error('\n[配置校验失败] JWT_SECRET 与 JWT_REFRESH_SECRET 不能相同，进程将退出。\n');
    process.exit(1);
  }

  cachedConfig = parsed.data;
  return cachedConfig;
}

/** 供 NestJS 依赖注入使用的配置令牌 */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** 把校验后的配置整理成结构化对象，便于各模块按需取用 */
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  isDevelopment: boolean;
  api: {
    port: number;
    baseUrl: string;
    appBaseUrl: string;
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  auth: {
    jwtSecret: string;
    jwtRefreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
    ipHashSalt: string;
  };
  cors: {
    origins: string[];
  };
  rateLimit: {
    ttlSeconds: number;
    max: number;
    behaviorMax: number;
  };
  ai: {
    provider: AiProviderKind;
    timeoutMs: number;
    maxRetries: number;
    /**
     * 已解析好的端点信息。
     *
     * 为什么在构建期就解析：
     *   消费方（AiService、向量化、后台诊断页）如果各自去 switch 厂商，
     *   会形成多处重复判断，新增厂商时容易漏改。
     *   在这里解析一次，后面统一取用。
     */
    apiKey: string | undefined;
    baseUrl: string;
    model: string;
  };
  property: {
    provider: 'MOCK' | 'BEIKE' | 'ANJUKE' | 'INTERNAL';
    syncEnabled: boolean;
    syncCron: string;
  };
  beike: {
    appId?: string;
    appKey?: string;
    appSecret?: string;
    baseUrl: string;
    cityCode: string;
    rateLimitPerMinute: number;
  };
  queue: {
    enabled: boolean;
    prefix: string;
    concurrency: number;
  };
  log: {
    level: string;
    pretty: boolean;
    dir: string;
  };
}

/** 由环境变量构造结构化配置 */
export function buildAppConfig(env: EnvConfig): AppConfig {
  const aiProvider = env.AI_PROVIDER as AiProviderKind;

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    api: {
      port: env.API_PORT,
      baseUrl: env.API_BASE_URL,
      appBaseUrl: env.APP_BASE_URL,
    },
    database: { url: env.DATABASE_URL },
    redis: { url: env.REDIS_URL },
    auth: {
      jwtSecret: env.JWT_SECRET,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtl: env.JWT_REFRESH_TTL,
      ipHashSalt: env.IP_HASH_SALT,
    },
    cors: { origins: env.CORS_ORIGINS },
    rateLimit: {
      ttlSeconds: env.RATE_LIMIT_TTL_SECONDS,
      max: env.RATE_LIMIT_MAX,
      behaviorMax: env.BEHAVIOR_RATE_LIMIT_MAX,
    },
    ai: {
      provider: aiProvider,
      timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      maxRetries: env.AI_MAX_RETRIES,
      // 构建期解析一次，避免消费方各自 switch 厂商
      apiKey: resolveAiApiKey(env, aiProvider),
      ...resolveAiEndpoint(env, aiProvider),
    },
    property: {
      provider: env.PROPERTY_PROVIDER,
      // 未显式设置时开发环境默认开启同步，方便看到数据流动
      syncEnabled: env.PROPERTY_SYNC_ENABLED ?? env.NODE_ENV !== 'test',
      syncCron: env.PROPERTY_SYNC_CRON,
    },
    beike: {
      appId: env.BEIKE_APP_ID,
      appKey: env.BEIKE_APP_KEY,
      appSecret: env.BEIKE_APP_SECRET,
      baseUrl: env.BEIKE_BASE_URL,
      cityCode: env.BEIKE_CITY_CODE,
      rateLimitPerMinute: env.BEIKE_RATE_LIMIT_PER_MINUTE,
    },
    queue: {
      enabled: env.QUEUE_ENABLED ?? true,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.QUEUE_CONCURRENCY,
    },
    log: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY ?? env.NODE_ENV !== 'production',
      dir: env.LOG_DIR,
    },
  };
}

/** 取指定 AI 厂商的密钥 */
export function resolveAiApiKey(env: EnvConfig, provider: AiProviderKind): string | undefined {
  switch (provider) {
    case AiProviderKind.DEEPSEEK:
      return env.DEEPSEEK_API_KEY;
    case AiProviderKind.OPENAI:
      return env.OPENAI_API_KEY;
    case AiProviderKind.ANTHROPIC:
      return env.ANTHROPIC_API_KEY;
    case AiProviderKind.MOCK:
    default:
      return undefined;
  }
}

/** 取指定 AI 厂商的 baseUrl 与 model */
export function resolveAiEndpoint(
  env: EnvConfig,
  provider: AiProviderKind,
): { baseUrl: string; model: string } {
  switch (provider) {
    case AiProviderKind.DEEPSEEK:
      return { baseUrl: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL };
    case AiProviderKind.OPENAI:
      return { baseUrl: env.OPENAI_BASE_URL, model: env.OPENAI_MODEL };
    case AiProviderKind.ANTHROPIC:
      return { baseUrl: env.ANTHROPIC_BASE_URL, model: env.ANTHROPIC_MODEL };
    default:
      return { baseUrl: '', model: 'estatepilot-mock-v1' };
  }
}
