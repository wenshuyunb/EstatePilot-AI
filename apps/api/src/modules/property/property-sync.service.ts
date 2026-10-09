/**
 * 房源同步服务。
 *
 * 职责：把 Provider 的数据同步进数据库，并识别五类变化：
 *   1. 新增房源
 *   2. 房源信息更新（面积、装修、描述等）
 *   3. **价格变化**（写入 property_price_history —— 这是降价机会的数据来源）
 *   4. 挂牌状态变化（下架 / 重新挂牌）
 *   5. 已消失的房源（Provider 不再返回 → 标记下架）
 *
 * 性能设计：
 *   - 用 externalId 索引批量查询已存在的房源，避免逐条 SELECT（N+1）。
 *   - 写库用 createMany / 分批 update，控制单次事务大小。
 *   - 价格历史与房源更新在同一事务内完成，避免「价格变了但历史没记」。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ListingStatus,
  PropertyProviderKind,
  type NormalizedProperty,
  type PropertySyncResult,
} from '@estatepilot/types';
import { chunk } from '@estatepilot/utils';
import { TenantService } from '../tenant/tenant.service.js';
import { PropertyProviderRegistry } from './providers/provider-registry.js';

/** 已在库的房源摘要，用于比对变化 */
interface ExistingProperty {
  id: string;
  externalId: string;
  totalPrice: bigint;
  unitPrice: number;
  area: unknown;
  listingStatus: string;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  decoration: string | null;
  buildYear: number | null;
  floor: number | null;
  totalFloors: number | null;
  subwayDistance: number | null;
  title: string;
}

export interface SyncOptions {
  /** 同步哪个组织的房源 */
  organizationId: string;
  /** 城市 */
  city?: string;
  /** 指定区域的增量同步 */
  district?: string;
  /** 每批处理条数 */
  batchSize?: number;
  /** 是否写入价格历史（增量同步时可选关闭） */
  recordPriceHistory?: boolean;
}

@Injectable()
export class PropertySyncService {
  private readonly logger = new Logger(PropertySyncService.name);

  constructor(
    private readonly tenant: TenantService,
    private readonly providers: PropertyProviderRegistry,
  ) {}

  /**
   * 执行一次完整同步。
   *
   * 这是一个「幂等」操作：重复执行不会产生重复数据，
   * 只有真实变化才会写入 —— 因此可以安全地定时跑。
   */
  async sync(options: SyncOptions): Promise<PropertySyncResult> {
    const startedAt = Date.now();
    const city = options.city ?? '上海';
    const batchSize = options.batchSize ?? 200;
    const recordPriceHistory = options.recordPriceHistory ?? true;

    const provider = this.providers.getDefault();
    const scope = this.tenant.scopeFor(options.organizationId);
    const syncBatchId = `sync-${Date.now().toString(36)}`;

    this.logger.log(
      `开始同步房源：provider=${provider.kind} city=${city} org=${options.organizationId} batch=${syncBatchId}`,
    );

    const result: PropertySyncResult = {
      provider: provider.kind,
      created: 0,
      updated: 0,
      priceChanged: 0,
      statusChanged: 0,
      delisted: 0,
      relisted: 0,
      failed: 0,
      durationMs: 0,
    };

    // ---- 1. 分页拉取全部房源 ----
    const incoming: NormalizedProperty[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const batch = await provider.fetchProperties({
        city,
        ...(options.district ? { district: options.district } : {}),
        page,
        pageSize: 200,
      });
      incoming.push(...batch.items);
      hasMore = batch.hasMore;
      page += 1;

      // 安全阀：避免 Provider 异常导致无限循环
      if (page > 200) {
        this.logger.warn('分页超过 200 页，提前终止（可能是 Provider 返回异常）');
        break;
      }
    }

    this.logger.log(`Provider 返回 ${incoming.length} 条房源`);

    // ---- 2. 批量查出已存在的房源 ----
    const externalIds = incoming.map((item) => item.externalId);
    const existingMap = new Map<string, ExistingProperty>();

    for (const idBatch of chunk(externalIds, 1000)) {
      const rows = await scope.findMany<ExistingProperty>('Property', {
        where: {
          externalProvider: provider.kind,
          externalId: { in: idBatch },
        },
        select: {
          id: true,
          externalId: true,
          totalPrice: true,
          unitPrice: true,
          area: true,
          listingStatus: true,
          bedrooms: true,
          livingRooms: true,
          bathrooms: true,
          decoration: true,
          buildYear: true,
          floor: true,
          totalFloors: true,
          subwayDistance: true,
          title: true,
        },
      });
      for (const row of rows) existingMap.set(row.externalId, row);
    }

    this.logger.log(`数据库中已存在 ${existingMap.size} 条对应房源`);

    // ---- 3. 分类处理 ----
    const toCreate: NormalizedProperty[] = [];

    for (const item of incoming) {
      const existing = existingMap.get(item.externalId);

      if (!existing) {
        toCreate.push(item);
        continue;
      }

      try {
        const outcome = await this.applyUpdate(
          scope,
          existing,
          item,
          recordPriceHistory,
          syncBatchId,
          options.organizationId,
        );
        if (outcome === 'PRICE_CHANGED') result.priceChanged += 1;
        else if (outcome === 'STATUS_CHANGED') {
          result.statusChanged += 1;
          if (item.listingStatus === ListingStatus.ACTIVE) result.relisted += 1;
        } else if (outcome === 'UPDATED') result.updated += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `同步房源失败 ${item.externalId}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // ---- 4. 批量创建新房源 ----
    for (const createBatch of chunk(toCreate, batchSize)) {
      try {
        const created = await this.createBatch(scope, createBatch, options.organizationId);
        result.created += created;
      } catch (error) {
        result.failed += createBatch.length;
        this.logger.error(
          `批量创建房源失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // ---- 5. 检测已消失的房源（Provider 不再返回 → 标记下架）----
    if (incoming.length > 0) {
      const incomingIds = new Set(externalIds);
      const missing = [...existingMap.values()].filter(
        (row) => !incomingIds.has(row.externalId) && row.listingStatus === ListingStatus.ACTIVE,
      );

      if (missing.length > 0) {
        const delistedCount = await scope.updateMany('Property', {
          where: { id: { in: missing.map((row) => row.id) } },
          data: {
            listingStatus: ListingStatus.DELISTED,
            delistedAt: new Date(),
            lastSyncedAt: new Date(),
          },
        });
        result.delisted = delistedCount;
        this.logger.log(`标记 ${delistedCount} 套已下架房源（Provider 不再返回）`);
      }
    }

    result.durationMs = Date.now() - startedAt;

    this.logger.log(
      `同步完成：新增 ${result.created}，更新 ${result.updated}，` +
        `价格变化 ${result.priceChanged}，状态变化 ${result.statusChanged}，` +
        `下架 ${result.delisted}，失败 ${result.failed}，耗时 ${result.durationMs}ms`,
    );

    return result;
  }

  /**
   * 处理一条已存在房源的变化。
   * 返回变化类型，供统计使用。
   */
  private async applyUpdate(
    scope: ReturnType<TenantService['scopeFor']>,
    existing: ExistingProperty,
    incoming: NormalizedProperty,
    recordPriceHistory: boolean,
    syncBatchId: string,
    organizationId: string,
  ): Promise<'PRICE_CHANGED' | 'STATUS_CHANGED' | 'UPDATED' | 'UNCHANGED'> {
    const oldPrice = existing.totalPrice;
    const newPrice = BigInt(incoming.totalPrice);
    const priceChanged = oldPrice !== newPrice;
    const statusChanged = existing.listingStatus !== incoming.listingStatus;

    // 非价格、非状态的常规字段变化
    const regularChanged =
      existing.title !== incoming.title ||
      Number(existing.area) !== incoming.area ||
      existing.bedrooms !== incoming.bedrooms ||
      existing.livingRooms !== incoming.livingRooms ||
      existing.bathrooms !== incoming.bathrooms ||
      existing.decoration !== (incoming.decoration ?? null) ||
      existing.buildYear !== (incoming.buildYear ?? null) ||
      existing.floor !== (incoming.floor ?? null) ||
      existing.totalFloors !== (incoming.totalFloors ?? null) ||
      existing.subwayDistance !== (incoming.subwayDistance ?? null) ||
      existing.unitPrice !== incoming.unitPrice;

    if (!priceChanged && !statusChanged && !regularChanged) {
      // 完全没变：只更新同步时间，避免无意义的写放大
      await scope.update('Property', {
        where: { id: existing.id },
        data: { lastSyncedAt: new Date() },
      });
      return 'UNCHANGED';
    }

    // ---- 价格变化：必须在同一事务里写历史 ----
    if (priceChanged && recordPriceHistory) {
      const change = newPrice - oldPrice;
      const changePercent =
        oldPrice !== 0n ? Number((Number(change) / Number(oldPrice)) * 100).toFixed(3) : '0';

      await scope.transaction(async (tx) => {
        await tx.update('Property', {
          where: { id: existing.id },
          data: {
            totalPrice: newPrice,
            unitPrice: incoming.unitPrice,
            lastPriceChange: new Date(),
            lastSyncedAt: new Date(),
            listingStatus: incoming.listingStatus,
          },
        });

        await tx.create('PropertyPriceHistory', {
          data: {
            propertyId: existing.id,
            oldPrice,
            newPrice,
            change,
            changePercent: Number(changePercent),
            oldUnitPrice: existing.unitPrice,
            newUnitPrice: incoming.unitPrice,
            reason: 'PROVIDER_SYNC',
          },
        });
      });

      // 记录 Provider 同步日志（失败不影响主流程）
      await this.logProviderRecord(scope, incoming, existing.id, 'PRICE_CHANGED', syncBatchId);

      const direction = change < 0n ? '降价' : '涨价';
      this.logger.log(
        `${direction}：${incoming.community} ${incoming.title} ` +
          `${Number(oldPrice) / 10000}万 → ${Number(newPrice) / 10000}万（${changePercent}%）`,
      );
      void organizationId;

      return 'PRICE_CHANGED';
    }

    // ---- 状态变化 ----
    if (statusChanged) {
      const delisted = incoming.listingStatus === ListingStatus.DELISTED;
      await scope.update('Property', {
        where: { id: existing.id },
        data: {
          listingStatus: incoming.listingStatus,
          delistedAt: delisted ? new Date() : null,
          wasRelisted:
            !delisted && existing.listingStatus === ListingStatus.DELISTED
              ? true
              : undefined,
          lastSyncedAt: new Date(),
          ...(priceChanged ? { totalPrice: newPrice, unitPrice: incoming.unitPrice } : {}),
        },
      });
      await this.logProviderRecord(scope, incoming, existing.id, 'STATUS_CHANGED', syncBatchId);
      return 'STATUS_CHANGED';
    }

    // ---- 常规字段更新 ----
    await scope.update('Property', {
      where: { id: existing.id },
      data: {
        title: incoming.title,
        area: incoming.area,
        bedrooms: incoming.bedrooms,
        livingRooms: incoming.livingRooms,
        bathrooms: incoming.bathrooms,
        decoration: incoming.decoration,
        buildYear: incoming.buildYear,
        floor: incoming.floor,
        totalFloors: incoming.totalFloors,
        subwayDistance: incoming.subwayDistance,
        orientation: incoming.orientation,
        unitPrice: incoming.unitPrice,
        lastSyncedAt: new Date(),
      },
    });
    await this.logProviderRecord(scope, incoming, existing.id, 'UPDATED', syncBatchId);
    return 'UPDATED';
  }

  /** 批量创建房源（含图片） */
  private async createBatch(
    scope: ReturnType<TenantService['scopeFor']>,
    items: NormalizedProperty[],
    organizationId: string,
  ): Promise<number> {
    let created = 0;

    for (const item of items) {
      try {
        // 单条创建：需要拿到 ID 才能写关联的图片与价格历史
        const property = await scope.create<{ id: string }>('Property', {
          data: this.toCreateData(item, organizationId),
        });

        if (item.images.length > 0) {
          await scope.createMany(
            'PropertyImage',
            item.images.map((image) => ({
              propertyId: property.id,
              url: image.url,
              category: image.category ?? 'INTERIOR',
              sortOrder: image.sortOrder ?? 0,
              caption: image.caption ?? null,
            })),
          );
        }

        // 若该房源已有降价历史（Provider 的 lastPriceChange 早于今天），
        // 补一条价格历史，让「降价」这件事在库里可追溯
        if (item.lastPriceChange) {
          const changeDate = new Date(item.lastPriceChange);
          if (!Number.isNaN(changeDate.getTime())) {
            // 反推原价：假设是降价，原价 = 现价 / (1 - 典型降幅)。这里用 5% 作为估算，
            // 并在 reason 中注明是估算值，避免伪造精确数据。
            const estimatedOld = Math.round((item.totalPrice / 0.95) / 10_000) * 10_000;
            await scope.create('PropertyPriceHistory', {
              data: {
                propertyId: property.id,
                oldPrice: BigInt(estimatedOld),
                newPrice: BigInt(item.totalPrice),
                change: BigInt(item.totalPrice - estimatedOld),
                changePercent: Number((((item.totalPrice - estimatedOld) / estimatedOld) * 100).toFixed(3)),
                reason: 'PROVIDER_SYNC_ESTIMATED',
              },
            });
          }
        }

        created += 1;
      } catch (error) {
        this.logger.error(
          `创建房源失败 ${item.externalId}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return created;
  }

  /** 把归一化房源转成 Prisma 创建数据 */
  private toCreateData(item: NormalizedProperty, _organizationId: string): Record<string, unknown> {
    return {
      externalProvider: item.externalProvider,
      externalId: item.externalId,
      rawData: item.rawData ?? undefined,

      city: item.city,
      district: item.district,
      subDistrict: item.subDistrict,
      community: item.community,
      title: item.title,
      address: item.address,
      longitude: item.longitude,
      latitude: item.latitude,

      totalPrice: BigInt(item.totalPrice),
      unitPrice: item.unitPrice,

      bedrooms: item.bedrooms,
      livingRooms: item.livingRooms,
      bathrooms: item.bathrooms,
      area: item.area,

      floor: item.floor,
      totalFloors: item.totalFloors,

      orientation: item.orientation,
      buildYear: item.buildYear,
      propertyType: item.propertyType,
      ownershipType: item.ownershipType,
      decoration: item.decoration,
      elevator: item.elevator,

      subwayDistance: item.subwayDistance,
      subwayInfo: item.subway ?? undefined,
      schoolInfo: item.schoolInfo ?? undefined,

      tags: item.tags,
      floorPlan: item.floorPlan,
      coverImage: item.images[0]?.url ?? null,
      description: item.description,

      listingStatus: item.listingStatus,
      listingDate: item.listingDate ? new Date(item.listingDate) : null,
      lastPriceChange: item.lastPriceChange ? new Date(item.lastPriceChange) : null,
      lastSyncedAt: new Date(),

      // 归一化字段，用于模糊搜索与跨来源匹配
      communityNormalized: this.normalizeCommunity(item.community),
      districtNormalized: this.normalizeDistrict(item.district),
    };
  }

  /** 记录 Provider 同步明细，便于排查「这条数据为什么变了」 */
  private async logProviderRecord(
    scope: ReturnType<TenantService['scopeFor']>,
    item: NormalizedProperty,
    propertyId: string,
    changeType: string,
    syncBatchId: string,
  ): Promise<void> {
    try {
      await scope.create('PropertyProviderRecord', {
        data: {
          propertyId,
          provider: item.externalProvider,
          externalId: item.externalId,
          payload: {
            totalPrice: item.totalPrice,
            unitPrice: item.unitPrice,
            listingStatus: item.listingStatus,
            area: item.area,
          },
          changeType,
          syncBatchId,
          success: true,
        },
      });
    } catch {
      // 同步明细写入失败不应影响主流程
    }
  }

  /** 小区名归一化（去括号、去后缀、小写），用于模糊搜索 */
  private normalizeCommunity(name: string): string {
    return name
      .trim()
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  /** 区域名归一化 */
  private normalizeDistrict(district: string): string {
    return district.trim().replace(/[区县]$/, '');
  }

  /** 同步单个区域（供后台手动触发增量同步） */
  async syncDistrict(organizationId: string, district: string): Promise<PropertySyncResult> {
    return this.sync({ organizationId, district, recordPriceHistory: true });
  }

  /** 检查 Provider 是否就绪，供后台展示 */
  describeProviders(): ReturnType<PropertyProviderRegistry['listStatus']> {
    return this.providers.listStatus();
  }

  /** 当前生效的 Provider 类型 */
  get activeProviderKind(): PropertyProviderKind {
    return this.providers.getDefault().kind;
  }
}
