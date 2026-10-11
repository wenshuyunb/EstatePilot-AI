/**
 * 本地缓存房源检索服务。
 *
 * 存在的原因（真实的可用性问题）：
 *   贝壳的 MCP 服务会整体不可用 —— 实测所有数据查询工具（搜索/小区/榜单/板块/详情）
 *   同时返回 `{"error":"service temporarily unavailable","ok":false}`，
 *   而 CLI 诊断显示"API 可达、Key 有效、发现 18 个工具"。
 *   也就是说：连接正常、凭证正常，但对方数据服务挂了。
 *
 *   这时如果只给用户一个错误提示，产品就完全不可用 —— 而经纪人此刻正在跟客户对话。
 *
 * 解决方案：**降级到本地已入库的真实房源**。
 *   我们此前每次成功调用贝壳时都会把房源落库（去重入库），
 *   这些就是真实的贝壳房源，只是**不是实时的**。
 *
 * 三条必须遵守的原则：
 *   1. **明确标注数据来源与时间**：界面上必须写清"本地缓存 · N 小时前同步"，
 *      绝不能让经纪人误以为是实时数据而向客户承诺"这套还在卖"。
 *   2. **只返回本地确实有的字段**：图片/学区等本地没存的，就显示"暂无数据"，
 *      不做任何补全。
 *   3. **仍然过滤在售状态**：下架的房源不返回（本地状态是上次同步时的状态）。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Decoration,
  ListingStatus,
  Orientation,
  OwnershipType,
  PropertyProviderKind,
  PropertyType,
  type NormalizedProperty,
  type PropertySearchQuery,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';

/** 本地检索结果 */
export interface CachedSearchResult {
  properties: NormalizedProperty[];
  /** 匹配到的总数（未分页前） */
  matched: number;
  /** 这些房源最早/最晚的同步时间，用于提示数据新鲜度 */
  oldestSyncedAt: Date | null;
  newestSyncedAt: Date | null;
  /** 缓存中贝壳房源的总数（用于提示"库存有限"） */
  totalCached: number;
  /** 数据来源说明，直接展示给用户 */
  sourceNote: string;
}

/**
 * 缓存降级检索允许的数据来源（Phase 12 白名单）。
 *
 * **用白名单而不是"排除 MOCK"**，原因：
 *   黑名单是"列举不允许的"，将来新增任何来源都会**默认被允许** ——
 *   包括测试数据、演示数据。白名单是"列举允许的"，
 *   新增来源必须**显式加进来**，否则不会出现在推荐里。
 *
 * 这是需求 §2/§3 的落实：生产推荐流程禁止使用 Demo 数据。
 */
const CACHED_SEARCH_ALLOWED_PROVIDERS = [
  PropertyProviderKind.BEIKE,
  PropertyProviderKind.INTERNAL,
  PropertyProviderKind.ANJUKE,
  // 注意：**不包含 MOCK**。演示数据永不进入推荐链路。
] as const;

@Injectable()
export class CachedPropertySearchService {
  private readonly logger = new Logger(CachedPropertySearchService.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 在本地缓存中检索房源。
   *
   * 过滤逻辑与 `HardFilterService` 保持一致的语义（预算上限、户型、区域、房龄），
   * 但这里直接在 SQL 层做，避免把全表拉进内存。
   */
  async search(
    organizationId: string,
    query: PropertySearchQuery,
    options: { limit?: number } = {},
  ): Promise<CachedSearchResult> {
    const scope = this.tenant.scopeFor(organizationId);
    const limit = options.limit ?? 30;

    // ---- 组装数据库过滤条件 ----
    //
    // ⚠️ Phase 12：只允许**真实来源**，用白名单而非黑名单。
    //
    // 之前这里硬编码 `externalProvider: BEIKE`。改成白名单后有两个好处：
    //   1. 其它真实来源（自有房源、经纪人录入）也能进入缓存降级检索
    //   2. **新来源默认不会混入** —— 用黑名单排除 MOCK 的话，
    //      将来加一个"测试数据"provider 就会被误当成真实数据源
    //
    // 这是需求 §2「生产推荐流程禁止使用 Demo 数据」在**数据层**的落实。
    const where: Record<string, unknown> = {
      externalProvider: { in: CACHED_SEARCH_ALLOWED_PROVIDERS },
      // 只返回状态为在售的（本地状态来自上次同步）
      ...(query.onlyActive ? { listingStatus: ListingStatus.ACTIVE } : {}),

      /**
       * ⚠️ 城市过滤（Phase 14 补上）。
       *
       * 原实现只按行政区/板块过滤，**没按城市**。这会导致一个严重问题：
       * 本地缓存里有 41 套上海房源时，客户搜"厦门"会匹配到这 41 套上海房源，
       * 系统会把上海的房子推荐给想买厦门的客户 —— 这是**跨城市错误推荐**，
       * 比"搜不到"更糟，因为经纪人可能真发给客户。
       *
       * 用 equals 而不是 contains：城市名短且规范（"上海"/"厦门"），
       * 用 contains 会让"海"这类子串误命中。
       */
      ...(query.city ? { city: query.city } : {}),

      // 行政区（用包含匹配，因为本地存的是"浦东新区"这类全称）
      ...(query.districts.length > 0
        ? {
            OR: query.districts.map((district) => ({
              district: { contains: district.replace(/[区县]$/, ''), mode: 'insensitive' },
            })),
          }
        : {}),
    };

    // 板块过滤：本地有 subDistrict 字段
    if (query.subDistricts.length > 0) {
      // 与上面的 OR 条件合并，避免覆盖
      const existingOr = Array.isArray(where['OR']) ? (where['OR'] as unknown[]) : [];
      const subOr = query.subDistricts.map((sub) => ({
        subDistrict: { contains: sub, mode: 'insensitive' },
      }));

      // 用 AND 包装两层 OR：既要命中区域，也要命中板块
      where['AND'] = [
        ...(existingOr.length > 0 ? [{ OR: existingOr }] : []),
        { OR: subOr },
      ];
      delete where['OR'];
    }

    // 户型
    if (query.bedrooms.length > 0) {
      where['bedrooms'] = { in: query.bedrooms };
    }

    // 预算（本地存的是 BigInt，Prisma 支持用 number 比较）
    //
    // ⚠️ 必须同时判 null 与 undefined（实测踩到的崩溃）：
    //   类型声明是 `number | null`，但**运行时可能是 undefined** ——
    //   查询构造器在某些分支下不会写入 budgetMin/budgetMax 字段。
    //   只判 `!== null` 会让 undefined 穿透到 `BigInt(undefined)`，
    //   抛 "Cannot convert undefined to a BigInt"，
    //   整个缓存降级路径直接崩掉 —— 表现为"以前能搜到，现在说没有房源"。
    //
    //   这类"类型说 null、运行时给 undefined"的缝隙在跨模块对象拼装时很常见，
    //   涉及数值转换的地方都要按"可能不存在"处理。
    const budgetMax = query.budgetMax ?? null;
    const budgetMin = query.budgetMin ?? null;

    if (budgetMax !== null) {
      where['totalPrice'] = { lte: BigInt(budgetMax) };
    }
    if (budgetMin !== null) {
      where['totalPrice'] = {
        ...(typeof where['totalPrice'] === 'object' && where['totalPrice'] !== null
          ? (where['totalPrice'] as Record<string, unknown>)
          : {}),
        gte: BigInt(budgetMin),
      };
    }

    // 面积（给 8% 弹性，与硬筛一致）
    const areaMin = query.areaMin ?? null;
    const areaMax = query.areaMax ?? null;

    if (areaMin !== null) {
      where['area'] = { gte: Math.floor(areaMin * 0.92) };
    }
    if (areaMax !== null) {
      where['area'] = {
        ...(typeof where['area'] === 'object' && where['area'] !== null
          ? (where['area'] as Record<string, unknown>)
          : {}),
        lte: Math.ceil(areaMax * 1.08),
      };
    }

    // 房龄（给 1 年弹性，与硬筛一致）
    if (query.builtAfterYear !== null) {
      where['buildYear'] = { gte: query.builtAfterYear - 1 };
    }

    // 电梯
    if (query.requireElevator) {
      where['elevator'] = true;
    }

    // ---- 查询 ----
    const [rows, matched, totalCached] = await Promise.all([
      scope.findMany<Parameters<typeof this.toNormalized>[0]>('Property', {
        where,
        select: {
          id: true,
          externalId: true,
          // 必须取出真实来源，不能硬编码（见下方 toNormalized 的注释）
          externalProvider: true,
          /**
           * ⚠️ 必须取出 rawData —— 它保存着搜索时贝壳返回的完整字段
           * （含周边交通/小区/学区），是"不调贝壳也能构造详情"的来源。
           *
           * 之前这里没取，导致 toNormalized 只能用元数据覆盖它，
           * 而 upsert 又会写回数据库 → **原始字段被逐步抹掉**（真实数据丢失 bug）。
           */
          rawData: true,
          dataReliabilityScore: true,
          lastVerifiedAt: true,
          verificationStatus: true,
          city: true,
          district: true,
          subDistrict: true,
          community: true,
          title: true,
          address: true,
          longitude: true,
          latitude: true,
          totalPrice: true,
          unitPrice: true,
          bedrooms: true,
          livingRooms: true,
          bathrooms: true,
          area: true,
          floor: true,
          totalFloors: true,
          orientation: true,
          buildYear: true,
          propertyType: true,
          ownershipType: true,
          decoration: true,
          elevator: true,
          subwayDistance: true,
          tags: true,
          floorPlan: true,
          description: true,
          listingStatus: true,
          listingDate: true,
          lastPriceChange: true,
          lastSyncedAt: true,
          updatedAt: true,
          images: { select: { url: true, category: true, sortOrder: true, caption: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
      scope.count('Property', where),
      scope.count('Property', {
        // 同样用白名单 —— 库存提示里也不能把演示数据算进来，
        // 否则会给经纪人一个虚高的"库存 2131 套"，误导判断
        externalProvider: { in: CACHED_SEARCH_ALLOWED_PROVIDERS },
        ...(query.onlyActive ? { listingStatus: ListingStatus.ACTIVE } : {}),
      }),
    ]);

    const properties = rows.map((row) => this.toNormalized(row));

    // ---- 数据新鲜度 ----
    let oldestSyncedAt: Date | null = null;
    let newestSyncedAt: Date | null = null;

    for (const row of rows) {
      const synced = row.lastSyncedAt ?? row.updatedAt;
      if (!oldestSyncedAt || synced < oldestSyncedAt) oldestSyncedAt = synced;
      if (!newestSyncedAt || synced > newestSyncedAt) newestSyncedAt = synced;
    }

    const ageHours = newestSyncedAt
      ? Math.floor((Date.now() - newestSyncedAt.getTime()) / 3_600_000)
      : null;

    const sourceNote =
      `本地缓存房源（${totalCached} 套）` +
      (ageHours === null
        ? ''
        : ageHours < 1
          ? ' · 1 小时内同步'
          : ageHours < 24
            ? ` · ${ageHours} 小时前同步`
            : ` · ${Math.floor(ageHours / 24)} 天前同步`);

    this.logger.log(
      `本地缓存检索完成：匹配 ${matched} 套，返回 ${properties.length} 套` +
        `（缓存共 ${totalCached} 套${ageHours !== null ? `，最新同步 ${ageHours} 小时前` : ''}）`,
    );

    return {
      properties,
      matched,
      oldestSyncedAt,
      newestSyncedAt,
      totalCached,
      sourceNote,
    };
  }

  /** 本地是否有可用的真实房源缓存 */
  async hasCache(organizationId: string): Promise<{ available: boolean; count: number }> {
    const scope = this.tenant.scopeFor(organizationId);
    const count = await scope.count('Property', {
      externalProvider: { in: CACHED_SEARCH_ALLOWED_PROVIDERS },
      listingStatus: ListingStatus.ACTIVE,
    });

    return { available: count > 0, count };
  }

  /**
   * 数据库行 → 领域模型。
   *
   * 注意几个必须做的转换：
   *   - totalPrice 是 BigInt
   *   - longitude/latitude 是 Decimal（对象形式）
   *   - images 是关系数组，需要映射成 PropertyImage[]
   */
  private toNormalized(row: {
    id: string;
    externalId: string;
    city: string;
    district: string;
    subDistrict: string | null;
    community: string;
    title: string;
    address: string | null;
    longitude: unknown;
    latitude: unknown;
    totalPrice: bigint | number;
    unitPrice: number;
    bedrooms: number;
    livingRooms: number;
    bathrooms: number;
    area: number;
    floor: number | null;
    totalFloors: number | null;
    orientation: string | null;
    buildYear: number | null;
    propertyType: string;
    ownershipType: string | null;
    decoration: string | null;
    elevator: boolean | null;
    subwayDistance: number | null;
    tags: string[];
    floorPlan: string[];
    description: string | null;
    listingStatus: string;
    listingDate: Date | null;
    lastPriceChange: Date | null;
    lastSyncedAt: Date | null;
    updatedAt: Date;
    /**
     * 房源的真实来源。
     *
     * ⚠️ 这个字段必须从数据库读取，**不能硬编码**。
     * 之前的实现写死了 `BEIKE`，在"缓存里只有贝壳房源"时看不出问题；
     * 但 Phase 12 放开了白名单（允许自有房源、经纪人录入），
     * 硬编码会导致**自有房源被错误标注成贝壳来源** ——
     * 这是数据溯源上的严重错误（界面会显示错误的来源标签）。
     */
    externalProvider: string;
    images: Array<{ url: string; category: string; sortOrder: number; caption: string | null }>;
    /**
     * 原始数据 —— 搜索时保存的贝壳完整字段。
     *
     * ⚠️ 必须保留并参与合并：它是"不调贝壳也能构造详情"的唯一来源。
     *    曾经因为这里没取，导致每次读缓存都把它覆盖成元数据，
     *    原始字段被永久抹掉（真实数据丢失 bug）。
     */
    rawData: unknown;
    dataReliabilityScore: number;
    lastVerifiedAt: Date | null;
    verificationStatus: string;
  }): NormalizedProperty {
    return {
      externalProvider: row.externalProvider as PropertyProviderKind,
      externalId: row.externalId,
      /**
       * ⚠️ 必须**保留原有的 rawData**（踩过的真实数据丢失 bug）。
       *
       * ============================================================================
       * 事故经过
       * ============================================================================
       * 搜索时 `rawData` 保存的是**贝壳返回的完整字段**（`fields`）——
       * 含周边交通/小区/学区等，是"不用再调贝壳就能构造详情"的宝贵来源。
       *
       * 但读缓存时这里把它整个换成了"缓存元数据"（source/cachedAt/分数），
       * 而 upsert 又会把结果写回数据库 ——
       * 于是**每次走缓存都会抹掉一层原始字段**。
       *
       * 实测后果：库里 132 套房源的 rawData 全变成了 6 个元数据字段，
       * 原始房源信息**永久丢失**，只能重新向贝壳请求。
       *
       * 现在改为：**合并**而非替换 —— 元数据与原始字段共存。
       */
      rawData: {
        ...((row.rawData as Record<string, unknown> | null) ?? {}),
        // 缓存读取的元数据（放在保留的原始字段之后，同名时以元数据为准）
        cacheSource: 'LOCAL_CACHE',
        cachedAt: (row.lastSyncedAt ?? row.updatedAt).toISOString(),
        propertyDbId: row.id,
        // 把可信度一并带出，供上层构造推荐卡片时展示
        dataReliabilityScore: row.dataReliabilityScore,
        verificationStatus: row.verificationStatus,
        lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      },
      city: row.city,
      district: row.district,
      subDistrict: row.subDistrict,
      community: row.community,
      title: row.title,
      address: row.address,
      longitude: this.toNumber(row.longitude),
      latitude: this.toNumber(row.latitude),
      totalPrice: Number(row.totalPrice),
      unitPrice: row.unitPrice,
      bedrooms: row.bedrooms,
      livingRooms: row.livingRooms,
      bathrooms: row.bathrooms,
      area: row.area,
      floor: row.floor,
      totalFloors: row.totalFloors,
      orientation: this.parseEnum(row.orientation, Orientation),
      buildYear: row.buildYear,
      propertyType: this.parseEnum(row.propertyType, PropertyType) ?? PropertyType.APARTMENT,
      ownershipType: this.parseEnum(row.ownershipType, OwnershipType),
      decoration: this.parseEnum(row.decoration, Decoration),
      elevator: row.elevator,
      subwayDistance: row.subwayDistance,
      subway: null,
      schoolInfo: null,
      tags: row.tags,
      images: row.images.map((image, index) => ({
        url: image.url,
        category: image.category as NormalizedProperty['images'][number]['category'],
        sortOrder: image.sortOrder ?? index,
        // 注意：caption 在领域模型里是 string | undefined（不是 null），
        // 因此这里要做转换而不是直接赋值。
        ...(image.caption ? { caption: image.caption } : {}),
      })),
      floorPlan: row.floorPlan,
      description: row.description,
      listingStatus: this.parseEnum(row.listingStatus, ListingStatus) ?? ListingStatus.ACTIVE,
      listingDate: row.listingDate?.toISOString() ?? null,
      lastPriceChange: row.lastPriceChange?.toISOString() ?? null,
    };
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseEnum<T extends Record<string, string>>(
    value: string | null,
    enumObject: T,
  ): T[keyof T] | null {
    if (!value) return null;
    const values = Object.values(enumObject);
    return values.includes(value) ? (value as T[keyof T]) : null;
  }
}
