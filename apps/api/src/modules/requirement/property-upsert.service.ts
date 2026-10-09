/**
 * 房源统一入库服务。
 *
 * 职责：把 Provider 返回的 NormalizedProperty 落入本地库，并保证**绝不重复创建**。
 *
 * 去重键（需求 §16）：
 *   (organizationId, externalProvider, externalId)
 *   例如：BEIKE + 107112596630 在整个系统里只能有一条记录。
 *
 * 为什么去重是必须的：
 *   客户每次发消息都会触发一次房源搜索。如果每次都 insert，
 *   同一套房子会在库里出现几十条，导致：
 *     1. 客户 360 页面看到重复房源
 *     2. 行为追踪无法归因（客户点了"同一套"的三个副本）
 *     3. 推荐去重失效（系统以为是三套不同的房子）
 *     4. 数据库迅速膨胀
 *
 * 价格变化处理：
 *   同一个 externalId 价格变了 → 更新记录 + **写入 property_price_history**。
 *   这两件事必须在同一事务内完成，否则会出现"价格变了但历史没记"的情况，
 *   而价格历史是"降价机会"检测与推荐去重的依据（需求 §37）。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ListingStatus,
  type NormalizedProperty,
  type PropertyProviderKind,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';

/**
 * 可信度写入参数（Phase 12）。
 *
 * 为什么单独抽成类型：它需要在 upsertMany → createOne/updateOne → toDatabaseFields
 * 之间透传，内联类型会导致四处重复定义。
 */
export interface ReliabilityInput {
  /** 数据可信度 0~100 */
  score: number;
  /** 核验状态 */
  status: string;
  /**
   * 该来源能否核验在售状态。
   *
   * false 时**不写** lastVerifiedAt —— 因为从未核验过。
   * 写一个假的时间会让界面误以为"刚确认过"，那是欺骗用户。
   */
  canVerify: boolean;
}

/** 入库结果 */
export interface UpsertResult {
  /** 新建的房源数 */
  created: number;
  /** 更新的房源数 */
  updated: number;
  /** 价格发生变化的房源数 */
  priceChanged: number;
  /** 跳过的房源（字段不完整等） */
  skipped: number;
  /** 价格变化的明细（用于"降价机会"检测） */
  priceChanges: Array<{
    propertyId: string;
    externalId: string;
    community: string;
    previousPrice: number;
    newPrice: number;
    changeAmount: number;
    changeRatio: number;
  }>;
  /** externalId → 数据库 ID 的映射（后续打分与推荐需要） */
  idMap: Map<string, string>;
}

@Injectable()
export class PropertyUpsertService {
  private readonly logger = new Logger(PropertyUpsertService.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 批量入库房源。
   *
   * @param provider    房源来源（BEIKE / INTERNAL / ANJUKE …）
   * @param reliability Phase 12 可信度。不传时不写这三个字段 ——
   *                    用默认值覆盖会把"贝壳实时数据"的可信度误降为 50。
   */
  async upsertMany(
    organizationId: string,
    properties: NormalizedProperty[],
    provider: PropertyProviderKind,
    reliability?: ReliabilityInput,
  ): Promise<UpsertResult> {
    const result: UpsertResult = {
      created: 0,
      updated: 0,
      priceChanged: 0,
      skipped: 0,
      priceChanges: [],
      idMap: new Map(),
    };

    if (properties.length === 0) return result;

    const scope = this.tenant.scopeFor(organizationId);

    // ---- 一次性查出已存在的记录（避免逐条 SELECT 的 N+1）----
    const externalIds = properties.map((property) => property.externalId);
    const existing = await scope.findMany<{
      id: string;
      externalId: string;
      totalPrice: bigint | number;
      listingStatus: string;
    }>('Property', {
      where: {
        externalProvider: provider,
        externalId: { in: externalIds },
      },
      select: { id: true, externalId: true, totalPrice: true, listingStatus: true },
    });

    // 注意：数据库的 totalPrice 是 BigInt（房产总价可能超过 2^31）。
    // Prisma 返回 BigInt 对象，与 number 直接运算会抛
    // "Cannot mix BigInt and other types" —— 因此这里统一转成 number。
    // 金额换算成 number 在业务上完全安全（2^53 远大于任何房产价格）。
    const existingMap = new Map(
      existing.map((item) => [
        item.externalId,
        {
          id: item.id,
          totalPrice: this.toNumber(item.totalPrice),
          listingStatus: item.listingStatus,
        },
      ]),
    );

    // ---- 逐条处理 ----
    for (const property of properties) {
      try {
        const current = existingMap.get(property.externalId);

        if (!current) {
          const created = await this.createOne(scope, property, provider, reliability);
          result.created += 1;
          result.idMap.set(property.externalId, created.id);
          continue;
        }

        // 已存在 → 更新
        result.idMap.set(property.externalId, current.id);

        const priceChanged = current.totalPrice !== property.totalPrice;

        await this.updateOne(
          scope,
          current.id,
          property,
          { priceChanged, previousPrice: current.totalPrice },
          reliability,
        );

        result.updated += 1;

        if (priceChanged) {
          result.priceChanged += 1;
          const changeAmount = property.totalPrice - current.totalPrice;
          result.priceChanges.push({
            propertyId: current.id,
            externalId: property.externalId,
            community: property.community,
            previousPrice: current.totalPrice,
            newPrice: property.totalPrice,
            changeAmount,
            changeRatio:
              current.totalPrice > 0
                ? Math.round((changeAmount / current.totalPrice) * 1000) / 1000
                : 0,
          });
        }
      } catch (error) {
        // 单条失败不应中断整批
        result.skipped += 1;
        this.logger.error(
          `房源 ${property.externalId} 入库失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(
      `房源入库完成：新增 ${result.created}，更新 ${result.updated}` +
        `${result.priceChanged > 0 ? `（其中 ${result.priceChanged} 套价格变化）` : ''}` +
        `${result.skipped > 0 ? `，跳过 ${result.skipped}` : ''}`,
    );

    return result;
  }

  /** 创建单套房源 */
  private async createOne(
    scope: ReturnType<TenantService['scopeFor']>,
    property: NormalizedProperty,
    provider: PropertyProviderKind,
    reliability?: ReliabilityInput,
  ): Promise<{ id: string }> {
    const created = await scope.create<{ id: string }>('Property', {
      data: {
        ...this.toDatabaseFields(property, provider, true, reliability),
        // 首次入库时记录初始价格作为历史起点
        listingDate: property.listingDate ? new Date(property.listingDate) : null,
      },
      select: { id: true },
    });

    // 写入图片
    if (property.images.length > 0) {
      await this.createImages(scope, created.id, property);
    }

    // 注意：这里**不**写价格历史。
    //
    // 原因（踩过的坑）：早期实现在首次入库时写一条 oldPrice = newPrice 的记录，
    // 导致无法区分"这条历史是首次入库"还是"这条历史代表一次真实的价格变化"。
    // 现在改为：
    //   首次入库 → 不写历史
    //   价格变化 → 写一条 oldPrice ≠ newPrice 的记录
    // 这样 propertyPriceHistory 里**每一条记录都代表一次真实的价格变动**，
    // 「价格历史」与「降价检测」都可以直接用它，语义干净。
    return created;
  }

  /** 更新已存在的房源 */
  private async updateOne(
    scope: ReturnType<TenantService['scopeFor']>,
    propertyId: string,
    property: NormalizedProperty,
    options: { priceChanged: boolean; previousPrice: number },
    reliability?: ReliabilityInput,
  ): Promise<void> {
    const incoming = this.toDatabaseFields(
      property,
      undefined,
      /* includeProvider */ false,
      reliability,
    );

    // ---- 空值保护（重要）----
    //
    // 不同来源的响应完整度不同：搜索接口与详情接口返回的字段集不一样。
    // 如果直接用"有值的覆盖、没值的也覆盖"，会出现：
    //   上次搜索拿到了 district=浦东新区，
    //   这次某个响应没带区域字段 → district 被写成空字符串，
    //   结果库里的正确数据被抹掉，界面上显示"区域待确认"。
    //
    // 因此这里做一次过滤：**只有新值非空时才写入**。
    // 这不会导致数据陈旧，因为房源的核⼼字段（价格、面积、状态）始终会返回。
    const existing = await scope.findFirst<Record<string, unknown>>('Property', {
      where: { id: propertyId },
    });

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      const isEmpty =
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      // 新值为空 → 保留库里已有的值（若库里也是空则无所谓）
      if (isEmpty) continue;

      data[key] = value;
    }

    // 图片与户型图只在有内容时更新（它们是数组，上面已被 continue 跳过空值）
    if (property.images.length === 0) {
      delete data['floorPlan'];
    }

    // 价格变化时更新 lastPriceChange（用于"最近降价"排序与展示）
    if (options.priceChanged) {
      data['lastPriceChange'] = new Date();
    }

    // 房源重新上架时清除下架时间
    if (property.listingStatus === ListingStatus.ACTIVE) {
      data['delistedAt'] = null;
    } else if (property.listingStatus === ListingStatus.DELISTED) {
      data['delistedAt'] = new Date();
    }

    // 如果这次响应确实带了区域，而库里是空的，这就是一次**数据修复**，值得记录
    if (
      existing &&
      (!existing['district'] || existing['district'] === '') &&
      typeof data['district'] === 'string' &&
      data['district'].length > 0
    ) {
      this.logger.log(
        `修复缺失区域：${property.community} → ${String(data['district'])}` +
          `${data['subDistrict'] ? ` ${String(data['subDistrict'])}` : ''}`,
      );
    }

    await scope.update('Property', { where: { id: propertyId }, data });

    // ---- 价格变化 → 写历史（同一逻辑单元，必须成对出现）----
    if (options.priceChanged) {
      const changeAmount = property.totalPrice - options.previousPrice;

      await scope.create('PropertyPriceHistory', {
        data: {
          propertyId,
          oldPrice: BigInt(options.previousPrice),
          newPrice: BigInt(property.totalPrice),
          change: BigInt(changeAmount),
          changePercent:
            options.previousPrice > 0
              ? Math.round((changeAmount / options.previousPrice) * 100_000) / 1000
              : 0,
          oldUnitPrice: null,
          newUnitPrice: property.unitPrice,
          reason: changeAmount < 0 ? '业主降价' : '业主涨价',
        },
      });

      this.logger.log(
        `价格变化：${property.community} ${this.formatWan(options.previousPrice)} → ` +
          `${this.formatWan(property.totalPrice)}（${changeAmount < 0 ? '降' : '涨'} ` +
          `${this.formatWan(Math.abs(changeAmount))}）`,
      );
    }

    // 图片：只在原本没有图片时补充，避免每次搜索都删了重插。
    //
    // 注意这里用父表 Property 的 _count 而不是 scope.count('PropertyImage')：
    //   property_images 表没有 organizationId，不在租户作用域白名单里，
    //   直接调用会抛 TenantScopeUnsupportedError。
    //   通过父表的关系计数既能拿到数量，也天然继承了租户约束。
    if (property.images.length > 0) {
      const owned = await scope.findFirst<{ id: string; _count: { images: number } }>('Property', {
        where: { id: propertyId },
        select: { id: true, _count: { select: { images: true } } },
      });

      if (owned && owned._count.images === 0) {
        await this.createImages(scope, propertyId, property);
      }
    }
  }

  /**
   * 写入房源图片。
   *
   * 为什么单独处理：`property_images` 表**没有 organizationId 字段**
   * （图片天然属于某个房源，不需要独立租户标识），因此不在 TenantScope 白名单里，
   * 直接调用 scope.createMany('PropertyImage', ...) 会抛 TenantScopeUnsupportedError。
   *
   * 正确做法：先通过**受租户约束的** Property 查询验证归属，
   * 拿到已确认属于当前租户的 propertyId 后，再用裸 Prisma 写入图片。
   * 这样既没有绕过租户隔离，也符合表结构。
   */
  private async createImages(
    scope: ReturnType<TenantService['scopeFor']>,
    propertyId: string,
    property: NormalizedProperty,
  ): Promise<void> {
    // 验证该房源确实属于当前租户（这一步是安全边界，不能省）
    const owned = await scope.findFirst<{ id: string }>('Property', {
      where: { id: propertyId },
      select: { id: true },
    });

    if (!owned) {
      this.logger.warn(`跳过图片写入：房源 ${propertyId} 不属于当前租户`);
      return;
    }

    // 限制图片数量，避免一次搜索写入过多记录
    const images = property.images.slice(0, 30);

    await this.tenant.forSystem().propertyImage.createMany({
      data: images.map((image, index) => ({
        propertyId: owned.id,
        url: image.url,
        category: image.category,
        sortOrder: image.sortOrder ?? index,
        caption: image.caption ?? null,
      })),
    });
  }

  /**
   * NormalizedProperty → 数据库字段。
   *
   * 注意几个转换：
   *   - longitude/latitude 是 Decimal 类型，传 number 会被 Prisma 接受
   *   - 图片与 floorPlan 是关系/数组，由调用方单独处理
   */
  private toDatabaseFields(
    property: NormalizedProperty,
    provider?: PropertyProviderKind,
    includeProvider = true,
    /**
     * Phase 12：可信度信息。
     *
     * 由调用方从 Provider 的能力声明换算后传入。
     * 不传时**不写这三个字段**（保持向后兼容，且避免用默认值覆盖已有可信度 ——
     * 那样会把"贝壳实时数据"的可信度误降为默认值）。
     */
    reliability?: ReliabilityInput,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      externalId: property.externalId,
      rawData: property.rawData as object,
      city: property.city,
      district: property.district,
      subDistrict: property.subDistrict,
      community: property.community,
      communityNormalized: this.normalizeCommunity(property.community),
      title: property.title,
      address: property.address,
      longitude: property.longitude,
      latitude: property.latitude,
      totalPrice: property.totalPrice,
      unitPrice: property.unitPrice,
      bedrooms: property.bedrooms,
      livingRooms: property.livingRooms,
      bathrooms: property.bathrooms,
      area: property.area,
      floor: property.floor,
      totalFloors: property.totalFloors,
      orientation: property.orientation,
      buildYear: property.buildYear,
      propertyType: property.propertyType,
      ownershipType: property.ownershipType,
      decoration: property.decoration,
      elevator: property.elevator,
      subwayDistance: property.subwayDistance,
      tags: property.tags,
      floorPlan: property.floorPlan,
      description: property.description,
      listingStatus: property.listingStatus,
      // 记录同步时间：本地缓存降级检索要靠它计算"数据是几小时前的"，
      // 界面据此提示数据新鲜度。不写这个字段，缓存降级就无法说明数据有多旧。
      lastSyncedAt: new Date(),
      // ---- Phase 12：可信度（在写入时固化，读取时再按新鲜度衰减）----
      ...(reliability
        ? {
            dataReliabilityScore: reliability.score,
            // 只有"可核验"的来源才记录核验时间。
            // 经纪人手动录入（无法核验）不写 —— 因为它从未被核验过，
            // 写一个假的时间会让界面误以为"刚确认过"。
            ...(reliability.canVerify ? { lastVerifiedAt: new Date() } : {}),
            verificationStatus: reliability.status,
          }
        : {}),
    };

    if (includeProvider && provider) {
      fields['externalProvider'] = provider;
    }

    return fields;
  }

  /**
   * 小区名归一化（用于同小区聚合与去重）。
   *
   * ⚠️ 这里**刻意只做基础归一化**（去空白、去括号、小写），
   * 与 `CommunityNormalizerService.normalizeBasic()` 保持一致。
   *
   * 为什么不去行政区前缀：那是跨源归并专用的能力，且**必须**在同城市同行政区内
   * 才安全（否则"浦东花园"和"浦西花园"会都变成"花园"而被错误合并）。
   * 需要在跨源场景使用完整能力时，请调用 `CommunityNormalizerService`。
   */
  private normalizeCommunity(community: string): string {
    return community
      .replace(/[\uFF01-\uFF5E]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0),
      )
      .replace(/\s+/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .toLowerCase()
      .trim();
  }

  /** 万元格式化 */
  private formatWan(amount: number): string {
    const wan = amount / 10_000;
    return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
  }

  /**
   * 查询客户已被推荐过的房源（用于推荐去重，需求 §37）。
   *
   * 返回 externalId → 上次推荐时的价格。
   * 有了价格才能判断"降价重新推荐"的场景。
   */
  async findPreviouslyRecommended(
    organizationId: string,
    customerId: string,
  ): Promise<Map<string, number>> {
    const scope = this.tenant.scopeFor(organizationId);

    // 取该客户所有已生成的推荐批次
    const batches = await scope.findMany<{
      recommendedPropertyIds: string[];
    }>('RecommendationBatch', {
      where: {
        customerId,
        status: { in: ['GENERATED', 'COPIED', 'SENT_CONFIRMED'] },
      },
      select: { recommendedPropertyIds: true },
    });

    const propertyIds = [...new Set(batches.flatMap((batch) => batch.recommendedPropertyIds))];
    if (propertyIds.length === 0) return new Map();

    const properties = await scope.findMany<{
      id: string;
      externalId: string;
      totalPrice: bigint | number;
    }>('Property', {
      where: { id: { in: propertyIds } },
      select: { id: true, externalId: true, totalPrice: true },
    });

    // 统一转 number，避免后续与 number 运算时抛 BigInt 混算错误
    return new Map(
      properties.map((item) => [item.externalId, this.toNumber(item.totalPrice)]),
    );
  }

  /**
   * BigInt → number。
   *
   * 数据库中总价是 BigInt 类型（房产金额可能超过 32 位整数上限）。
   * 但业务运算全部用 number 更自然，而 2^53 远超任何房产价格，转换是安全的。
   */
  private toNumber(value: bigint | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    return Number(value);
  }
}
