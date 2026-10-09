/**
 * 租户服务 —— 业务代码访问数据库的唯一入口。
 *
 * 为什么要有这一层（而不是让各 Service 直接注入 PrismaClient）：
 * 如果每个 Service 都能拿到裸 PrismaClient，就一定会有人忘记加 organizationId 过滤，
 * 而这类 bug 在测试环境永远发现不了，上线后会变成真实的串库事故。
 *
 * 这里的约定是：**默认只能拿到已绑定租户的作用域**。
 * 需要跨租户时必须显式调用 forSystem()，一眼就能在代码审查中看出来。
 */

import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  createPrismaClient,
  createTenantScope,
  type PrismaClient,
  type TenantScope,
} from '@estatepilot/database';
import { getContext, patchContext } from '../../common/context/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';

/** 跨租户访问被拒绝 */
export class TenantContextMissingError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';

  constructor(operation: string) {
    super(
      `执行「${operation}」时没有租户上下文。` +
        `请确认请求经过了认证守卫；后台任务请使用 runAsTask 建立上下文，` +
        `或显式调用 tenant.forSystem() 并说明理由。`,
    );
    this.name = 'TenantContextMissingError';
  }
}

@Injectable()
export class TenantService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantService.name);
  private client: PrismaClient | null = null;

  // 必须用 @Inject(APP_CONFIG)：APP_CONFIG 是 Symbol 令牌，
  // 而 `import type { AppConfig }` 会在运行时被擦除，
  // NestJS 无法从类型元数据推断出这个令牌（compilerOptions 里也没有 emitDecoratorMetadata 之外的线索）。
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('正在初始化数据库连接池…');
    this.client = createPrismaClient({
      connectionString: this.config.database.url,
      applicationName: `estatepilot-api-${this.config.env}`,
      logQueries: this.config.isDevelopment && this.config.log.level === 'debug',
      maxConnections: 10,
    });

    // 启动即验证连接，避免"服务起来了但数据库连不上"
    try {
      await this.client.$queryRaw`SELECT 1`;
      this.logger.log('数据库连接正常');
    } catch (error) {
      this.logger.error(
        `数据库连接失败：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.$disconnect();
      this.logger.log('数据库连接已关闭');
    }
  }

  /** 底层客户端，仅供基础设施代码（如健康检查、迁移状态）使用 */
  get raw(): PrismaClient {
    if (!this.client) throw new Error('PrismaClient 尚未初始化');
    return this.client;
  }

  /**
   * 取当前请求的租户作用域。
   * 这是业务 Service 应该使用的方法。
   */
  scope(operation = '数据库操作'): TenantScope {
    const context = getContext();
    if (!context?.organizationId) {
      throw new TenantContextMissingError(operation);
    }
    return createTenantScope(this.raw, {
      organizationId: context.organizationId,
      userId: context.userId ?? null,
      storeId: context.storeId ?? null,
      isSuperAdmin: context.isSuperAdmin ?? false,
    });
  }

  /**
   * 显式指定租户的作用域。
   * 用于需要操作「另一个租户」的场景（如超管后台、跨租户统计），
   * 调用处必须写明理由。
   */
  scopeFor(organizationId: string, options: { userId?: string; storeId?: string | null } = {}): TenantScope {
    return createTenantScope(this.raw, {
      organizationId,
      userId: options.userId ?? null,
      storeId: options.storeId ?? null,
    });
  }

  /**
   * 系统级访问（跨租户）。
   *
   * ⚠️ 允许的场景仅限：
   *   - 登录时按邮箱查找用户（此时还不知道 organizationId）
   *   - 平台超管后台的跨租户查询与统计
   *   - 队列任务的全局扫描与调度
   *   - 健康检查
   * 其他情况请使用 scope()。调用处必须写注释说明原因。
   */
  forSystem(): PrismaClient {
    return this.raw;
  }

  /** 健康检查：返回数据库连通性 */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      await this.raw.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 统计当前租户的数据量，用于配额检查与后台展示。
   * 用 groupBy 一次查完，避免多次往返。
   */
  async usageSnapshot(organizationId: string): Promise<{
    customers: number;
    properties: number;
    users: number;
    stores: number;
  }> {
    const scope = this.scopeFor(organizationId);
    const [customers, properties, users, stores] = await Promise.all([
      scope.count('Customer', { deletedAt: null }),
      scope.count('Property', {}),
      scope.count('User', { status: 'ACTIVE' }),
      scope.count('Store', { isActive: true }),
    ]);
    return { customers, properties, users, stores };
  }

  /** 把租户信息补写回请求上下文（登录成功后调用） */
  attachToContext(organizationId: string, userId: string, storeId: string | null): void {
    patchContext({ organizationId, userId, storeId });
  }
}
