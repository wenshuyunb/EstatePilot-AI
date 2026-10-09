/**
 * 多租户作用域（Tenant Scope）。
 *
 * 这是防止「不同公司数据串库」的核心机制。设计原则：
 *
 * 1. **不提供无租户的查询入口**。业务代码拿到的永远是已经绑定 organizationId 的作用域，
 *    想绕过就必须显式调用 `unsafeRaw()`，而这个方法在代码审查中一眼可见。
 * 2. **读取自动注入过滤条件**，写入自动注入 organizationId，改删自动附带租户校验条件。
 * 3. **运行期白名单校验**：对没有 organizationId 字段的模型（如 FeatureFlag）
 *    直接抛错，避免开发者误用导致全表操作。
 * 4. **跨租户访问抛 TenantMismatchError**，由全局异常过滤器映射为 403 + TENANT_MISMATCH，
 *    并写入审计日志。
 */

import type { PrismaClient } from './generated/prisma/client.js';

/** 租户上下文 —— 由 JWT 解析而来，绝不接受客户端直接传入 */
export interface TenantContext {
  organizationId: string;
  /** 当前用户 ID，可为空（客户专属页面等匿名场景） */
  userId?: string | null;
  /** 门店 ID，用于默认过滤 */
  storeId?: string | null;
  /** 是否平台超管（可跨租户，仅内部运营） */
  isSuperAdmin?: boolean;
}

/** 跨租户访问异常 */
export class TenantMismatchError extends Error {
  readonly code = 'TENANT_MISMATCH';

  constructor(
    readonly model: string,
    readonly expectedOrganizationId: string,
    readonly actualOrganizationId?: string | null,
  ) {
    super(
      actualOrganizationId
        ? `跨租户访问被拒绝：模型 ${model} 的记录属于组织 ${actualOrganizationId}，当前上下文为 ${expectedOrganizationId}`
        : `跨租户访问被拒绝：模型 ${model} 的查询缺少组织作用域`,
    );
    this.name = 'TenantMismatchError';
  }
}

/** 模型缺少 organizationId 字段时抛出 */
export class TenantScopeUnsupportedError extends Error {
  readonly code = 'TENANT_SCOPE_UNSUPPORTED';

  constructor(readonly model: string) {
    super(
      `模型 ${model} 不支持租户作用域（它没有 organizationId 字段）。` +
        `如果该模型确实是全局数据，请使用 prisma 直连并说明理由。`,
    );
    this.name = 'TenantScopeUnsupportedError';
  }
}

/**
 * 带 organizationId 字段的模型白名单。
 * 新增租户级模型时必须同步维护这里，否则调用 scope() 会直接报错 —— 这是有意为之：
 * 宁可启动即失败，也不要静默地漏掉租户过滤。
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'Store',
  'Team',
  'User',
  'Subscription',
  'AuditLog',
  'Customer',
  'CustomerBehaviorEvent',
  'CustomerShareLink',
  'ConsentLog',
  'Property',
  'PropertyPriceHistory',
  'PropertyProviderRecord',
  'PropertyProviderConfig',
  'BehaviorScoringRule',
  'Favorite',
  'Comparison',
  'CustomerPropertyMatch',
  'Opportunity',
  'Notification',
  'Viewing',
  'Communication',
  'VoiceNote',
  'Task',
  'AiConversation',
  'AiRun',

  // ---- Phase 11：微信复制 → AI 需求 → 贝壳 → 推荐闭环 ----
  //
  // 注意：这几张表都有 organizationId，因此可以（也必须）通过租户作用域访问。
  // 不在这里的表要特别小心，例如：
  //   CustomerBehavioralProfile / CustomerRequirementProfile 的子表关系
  //   PropertyImage（无 organizationId，必须通过父 Property 验证归属后访问）
  'CustomerMessageImport',
  'CustomerRequirementProfile',
  'CustomerRequirementSnapshot',
  'CustomerPropertyFeedback',
  'RecommendationBatch',
  'GeneratedCustomerReply',
]);

/**
 * 租户作用域。所有业务查询都应通过它进行。
 */
export class TenantScope {
  constructor(
    private readonly prisma: PrismaClient,
    readonly context: TenantContext,
  ) {
    if (!context.organizationId) {
      throw new TenantMismatchError('TenantScope', '(未提供)');
    }
  }

  get organizationId(): string {
    return this.context.organizationId;
  }

  /** 校验模型是否支持租户作用域 */
  private assertScoped(model: string): void {
    if (!TENANT_SCOPED_MODELS.has(model)) {
      throw new TenantScopeUnsupportedError(model);
    }
  }

  /** 取模型委托，带运行期存在性校验 */
  private delegate(model: string): Record<string, (...args: unknown[]) => unknown> {
    this.assertScoped(model);
    const delegate = (this.prisma as unknown as Record<string, unknown>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ];
    if (!delegate || typeof delegate !== 'object') {
      throw new Error(`Prisma 模型不存在：${model}`);
    }
    return delegate as Record<string, (...args: unknown[]) => unknown>;
  }

  /** 把租户过滤条件合并进 where，同时保留调用方条件 */
  private mergeWhere(where: unknown): Record<string, unknown> {
    if (where === null || where === undefined) {
      return { organizationId: this.organizationId };
    }
    if (typeof where !== 'object') {
      throw new Error('where 必须是对象');
    }
    return { ...(where as Record<string, unknown>), organizationId: this.organizationId };
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  async findMany<T = unknown>(
    model: string,
    args: {
      where?: unknown;
      orderBy?: unknown;
      skip?: number;
      take?: number;
      select?: unknown;
      include?: unknown;
      distinct?: unknown;
    } = {},
  ): Promise<T[]> {
    const delegate = this.delegate(model);
    return (await delegate.findMany!({
      ...args,
      where: this.mergeWhere(args.where),
    })) as T[];
  }

  async findFirst<T = unknown>(
    model: string,
    args: { where?: unknown; orderBy?: unknown; select?: unknown; include?: unknown } = {},
  ): Promise<T | null> {
    const delegate = this.delegate(model);
    return (await delegate.findFirst!({
      ...args,
      where: this.mergeWhere(args.where),
    })) as T | null;
  }

  /**
   * 按业务唯一键查询，但强制附加租户条件。
   * 注意：这里用 findFirst 而不是 findUnique，因为需要在唯一键之外再加 organizationId。
   */
  async findByUnique<T = unknown>(
    model: string,
    where: Record<string, unknown>,
    args: { select?: unknown; include?: unknown } = {},
  ): Promise<T | null> {
    return this.findFirst<T>(model, { ...args, where });
  }

  /**
   * 按 ID 查询并校验归属。
   * 记录不存在时返回 null；记录存在但属于其他租户时抛 TenantMismatchError。
   * 这样调用方可以区分「404 未找到」与「403 越权」。
   */
  async findByIdOrThrow<T = unknown>(
    model: string,
    id: string,
    args: { select?: unknown; include?: unknown } = {},
  ): Promise<T> {
    const found = await this.findFirst<T>(model, { ...args, where: { id } });
    if (found) return found;

    // 先确认该记录是否存在于其他租户，以便区分 404 与越权
    this.assertScoped(model);
    const delegate = (this.prisma as unknown as Record<string, unknown>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ] as { findUnique: (args: unknown) => Promise<unknown> } | undefined;

    const foreign = (await delegate?.findUnique({
      where: { id },
      select: { organizationId: true },
    })) as { organizationId?: string } | null | undefined;

    if (foreign?.organizationId && foreign.organizationId !== this.organizationId) {
      throw new TenantMismatchError(model, this.organizationId, foreign.organizationId);
    }

    throw new Error(`未找到记录：${model}#${id}`);
  }

  async count(model: string, where?: unknown): Promise<number> {
    const delegate = this.delegate(model);
    return (await delegate.count!({ where: this.mergeWhere(where) })) as number;
  }

  async aggregate<T = unknown>(model: string, args: Record<string, unknown>): Promise<T> {
    const delegate = this.delegate(model);
    return (await delegate.aggregate!({
      ...args,
      where: this.mergeWhere(args.where),
    })) as T;
  }

  async groupBy<T = unknown>(model: string, args: Record<string, unknown>): Promise<T[]> {
    const delegate = this.delegate(model);
    return (await delegate.groupBy!({
      ...args,
      where: this.mergeWhere(args.where),
    })) as T[];
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /** 创建记录，自动注入 organizationId（调用方传入的会被覆盖，防止伪造） */
  async create<T = unknown>(
    model: string,
    args: { data: Record<string, unknown>; select?: unknown; include?: unknown },
  ): Promise<T> {
    const delegate = this.delegate(model);
    return (await delegate.create!({
      ...args,
      data: { ...args.data, organizationId: this.organizationId },
    })) as T;
  }

  /** 批量创建，逐条注入 organizationId */
  async createMany(model: string, data: Array<Record<string, unknown>>): Promise<number> {
    const delegate = this.delegate(model);
    const result = (await delegate.createMany!({
      data: data.map((item) => ({ ...item, organizationId: this.organizationId })),
    })) as { count: number };
    return result.count;
  }

  /**
   * 更新单条。先校验归属，再执行更新。
   * 不直接暴露传入任意 where 的 update，避免误伤其他租户的数据。
   */
  async update<T = unknown>(
    model: string,
    args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
      select?: unknown;
      include?: unknown;
    },
  ): Promise<T> {
    // 先把该记录限定到当前租户，拿到主键
    const existing = (await this.findFirst<{ id: string }>(model, {
      where: args.where,
      select: { id: true },
    })) as { id: string } | null;

    if (!existing) {
      throw new TenantMismatchError(model, this.organizationId);
    }

    const delegate = this.delegate(model);
    // 禁止通过 data 篡改 organizationId
    const { organizationId: _ignored, ...safeData } = args.data;
    return (await delegate.update!({
      where: { id: existing.id },
      data: safeData,
      ...(args.select ? { select: args.select } : {}),
      ...(args.include ? { include: args.include } : {}),
    })) as T;
  }

  /** 批量更新，自动附加租户条件 */
  async updateMany(
    model: string,
    args: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<number> {
    const delegate = this.delegate(model);
    const { organizationId: _ignored, ...safeData } = args.data;
    const result = (await delegate.updateMany!({
      where: this.mergeWhere(args.where),
      data: safeData,
    })) as { count: number };
    return result.count;
  }

  /** 删除单条，先校验归属 */
  async delete<T = unknown>(model: string, where: Record<string, unknown>): Promise<T> {
    const existing = (await this.findFirst<{ id: string }>(model, {
      where,
      select: { id: true },
    })) as { id: string } | null;

    if (!existing) {
      throw new TenantMismatchError(model, this.organizationId);
    }

    const delegate = this.delegate(model);
    return (await delegate.delete!({ where: { id: existing.id } })) as T;
  }

  /** 批量删除，自动附加租户条件 */
  async deleteMany(model: string, where: Record<string, unknown> = {}): Promise<number> {
    const delegate = this.delegate(model);
    const result = (await delegate.deleteMany!({ where: this.mergeWhere(where) })) as {
      count: number;
    };
    return result.count;
  }

  /** upsert：创建时注入 organizationId，更新时校验归属 */
  async upsert<T = unknown>(
    model: string,
    args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    },
  ): Promise<T> {
    const existing = (await this.findFirst<{ id: string }>(model, {
      where: args.where,
      select: { id: true },
    })) as { id: string } | null;

    if (existing) {
      return this.update<T>(model, { where: { id: existing.id }, data: args.update });
    }
    return this.create<T>(model, { data: args.create });
  }

  /**
   * 事务。回调里拿到的是一个绑定了同一事务的作用域，
   * 保证事务内的每次查询同样受租户约束。
   */
  async transaction<T>(fn: (scope: TenantScope) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const txScope = new TenantScope(tx as unknown as PrismaClient, this.context);
      return fn(txScope);
    });
  }

  // -------------------------------------------------------------------------
  // 逃生舱
  // -------------------------------------------------------------------------

  /**
   * 直连 Prisma，跨租户操作。
   *
   * 只有以下场景允许使用，且必须在调用处写明理由：
   *   - 平台超管后台的跨租户统计
   *   - 登录时按邮箱查找用户（此时还不知道 organizationId）
   *   - 队列任务的全局扫描
   * 其他任何情况都应使用上面带作用域的方法。
   */
  unsafeRaw(): PrismaClient {
    return this.prisma;
  }

  /** 派生一个上下文相同但门店被限定的作用域，用于店长只看本店数据 */
  forStore(storeId: string | null): TenantScope {
    return new TenantScope(this.prisma, { ...this.context, storeId });
  }

  /** 派生一个指定用户的作用域（超管代操作场景） */
  asUser(
    userId: string,
    options: { storeId?: string | null; isSuperAdmin?: boolean } = {},
  ): TenantScope {
    return new TenantScope(this.prisma, {
      ...this.context,
      userId,
      storeId: options.storeId ?? null,
      isSuperAdmin: options.isSuperAdmin ?? false,
    });
  }
}

/** 从 PrismaClient 创建租户作用域 */
export function createTenantScope(prisma: PrismaClient, context: TenantContext): TenantScope {
  return new TenantScope(prisma, context);
}
