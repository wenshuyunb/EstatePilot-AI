/**
 * 房源导入服务。
 *
 * 支持三种导入方式（覆盖真实中介的所有数据来源）：
 *   1. 粘贴导入  —— 从贝壳/链家/安居客后台复制文本，解析后入库（最常用）
 *   2. CSV 导入   —— 已有 Excel 表格的中介
 *   3. 官方 API   —— 贝壳开放平台（见 providers/beike）
 *
 * 去重策略（这是导入功能最关键的工程问题）：
 *   同一套房源被重复导入会产生脏数据，进而污染匹配结果。
 *   因此用「指纹」判定：小区名归一化 + 户型 + 面积 + 楼层 → 哈希。
 *   若指纹相同但总价不同，视为**价格更新**（写价格历史），而不是新增。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ListingStatus,
  PropertyProviderKind,
  PropertyType,
  type NormalizedProperty,
} from '@estatepilot/types';
import { createHash } from 'node:crypto';
import { TenantService } from '../tenant/tenant.service.js';
import {
  PropertyTextParserService,
  type ParsedPropertyDraft,
} from './property-text-parser.service.js';

export interface ImportOptions {
  /** 城市，默认上海 */
  city?: string;
  /** 是否跳过关键字段不全的记录 */
  skipIncomplete?: boolean;
  /** 是否在重复时更新价格（并写价格历史） */
  updateOnDuplicate?: boolean;
  /** 房源来源标记，用于后续追溯 */
  sourceLabel?: string;
}

export interface ImportResult {
  /** 成功新增 */
  created: number;
  /** 因重复被跳过 */
  skipped: number;
  /** 因重复但价格变化而更新 */
  priceUpdated: number;
  /** 字段不全被拒绝 */
  rejected: number;
  /** 逐条结果，便于前端展示明细 */
  details: Array<{
    draftId: string;
    status: 'CREATED' | 'SKIPPED_DUPLICATE' | 'PRICE_UPDATED' | 'REJECTED';
    propertyId: string | null;
    title: string;
    reason: string | null;
  }>;
  durationMs: number;
}

@Injectable()
export class PropertyImportService {
  private readonly logger = new Logger(PropertyImportService.name);

  constructor(
    private readonly tenant: TenantService,
    private readonly parser: PropertyTextParserService,
  ) {}

  /**
   * 从粘贴文本导入房源。
   *
   * 流程：解析 → 校验 → 去重检查 → 入库（含图片）
   */
  async importFromText(
    organizationId: string,
    text: string,
    options: ImportOptions = {},
  ): Promise<ImportResult & { parseSummary: { totalBlocks: number; parsedBlocks: number; importable: number } }> {
    const startedAt = Date.now();
    const city = options.city ?? '上海';
    const skipIncomplete = options.skipIncomplete ?? true;
    const updateOnDuplicate = options.updateOnDuplicate ?? true;

    const scope = this.tenant.scopeFor(organizationId);

    // ---- 1. 解析 ----
    const parseResult = this.parser.parse(text, { city });
    this.logger.log(
      `粘贴导入解析完成：${parseResult.summary.parsedBlocks}/${parseResult.summary.totalBlocks} 条可解析，` +
        `${parseResult.summary.importable} 条字段完整`,
    );

    const result: ImportResult = {
      created: 0,
      skipped: 0,
      priceUpdated: 0,
      rejected: 0,
      details: [],
      durationMs: 0,
    };

    // ---- 2. 逐条处理 ----
    for (const draft of parseResult.drafts) {
      // 关键字段不全
      if (skipIncomplete && draft.missingFields.length > 0) {
        result.rejected += 1;
        result.details.push({
          draftId: draft.draftId,
          status: 'REJECTED',
          propertyId: null,
          title: draft.fields.title ?? draft.rawText.slice(0, 40),
          reason: `缺少关键字段：${draft.missingFields.join('、')}`,
        });
        continue;
      }

      const fingerprint = this.buildFingerprint(draft, city);

      try {
        // ---- 去重检查 ----
        const existing = await this.findByFingerprint(scope, fingerprint, draft, city);

        if (existing) {
          // 已存在：检查价格是否变化
          const newPrice = BigInt(draft.fields.totalPrice ?? 0);

          if (updateOnDuplicate && existing.totalPrice !== newPrice && newPrice > 0n) {
            await this.updatePrice(scope, existing.id, existing.totalPrice, newPrice, draft);

            result.priceUpdated += 1;
            result.details.push({
              draftId: draft.draftId,
              status: 'PRICE_UPDATED',
              propertyId: existing.id,
              title: draft.fields.title ?? draft.fields.community ?? '',
              reason: `价格由 ${Number(existing.totalPrice) / 10000} 万更新为 ${Number(newPrice) / 10000} 万`,
            });
          } else {
            result.skipped += 1;
            result.details.push({
              draftId: draft.draftId,
              status: 'SKIPPED_DUPLICATE',
              propertyId: existing.id,
              title: draft.fields.title ?? draft.fields.community ?? '',
              reason: '系统中已存在相同房源',
            });
          }
          continue;
        }

        // ---- 新增 ----
        const propertyId = await this.createProperty(scope, draft, {
          city,
          organizationId,
          sourceLabel: options.sourceLabel ?? 'PASTE_IMPORT',
          fingerprint,
        });

        result.created += 1;
        result.details.push({
          draftId: draft.draftId,
          status: 'CREATED',
          propertyId,
          title: draft.fields.title ?? draft.fields.community ?? '',
          reason: null,
        });
      } catch (error) {
        result.rejected += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`导入房源失败（${draft.draftId}）：${message}`);
        result.details.push({
          draftId: draft.draftId,
          status: 'REJECTED',
          propertyId: null,
          title: draft.fields.title ?? draft.rawText.slice(0, 40),
          reason: `入库失败：${message.slice(0, 150)}`,
        });
      }
    }

    result.durationMs = Date.now() - startedAt;

    this.logger.log(
      `粘贴导入完成：新增 ${result.created}，价格更新 ${result.priceUpdated}，` +
        `跳过重复 ${result.skipped}，拒绝 ${result.rejected}，耗时 ${result.durationMs}ms`,
    );

    return { ...result, parseSummary: parseResult.summary };
  }

  /**
   * 仅解析不入库（供前端"预览"步骤使用）。
   * 用户先看到解析结果、修正错误字段，再确认导入 —— 避免脏数据直接进库。
   */
  previewParse(text: string, options: { city?: string } = {}): ReturnType<PropertyTextParserService['parse']> {
    return this.parser.parse(text, options);
  }

  // -------------------------------------------------------------------------
  // 指纹与去重
  // -------------------------------------------------------------------------

  /**
   * 构建房源指纹。
   *
   * 组成：城市 + 归一化小区名 + 户型 + 面积(取整) + 楼层
   * 不含价格 —— 价格会变，但房子还是同一套。
   *
   * 面积取整到整数是为了容忍「128.5㎡」与「128.5平米」这类写法差异；
   * 楼层参与是为了区分同一小区同户型的不同楼层房源（它们是不同标的）。
   */
  private buildFingerprint(draft: ParsedPropertyDraft, city: string): string {
    const f = draft.fields;

    const normalizedCommunity = (f.community ?? '')
      .trim()
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();

    const parts = [
      city,
      normalizedCommunity,
      String(f.bedrooms ?? 0),
      String(Math.round(f.area ?? 0)),
      String(f.floor ?? 0),
    ];

    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  }

  /**
   * 按指纹查找已存在的房源。
   *
   * 实现说明：指纹存在 rawData 里，直接查 JSON 字段性能不好，
   * 因此先用「小区名 + 户型 + 面积范围」在数据库里粗筛，
   * 再在内存里精确比对指纹。这样既能命中索引，又保证准确。
   */
  private async findByFingerprint(
    scope: ReturnType<TenantService['scopeFor']>,
    fingerprint: string,
    draft: ParsedPropertyDraft,
    city: string,
  ): Promise<{ id: string; totalPrice: bigint } | null> {
    const f = draft.fields;
    if (!f.community || f.area === null || f.bedrooms === null) return null;

    const normalizedCommunity = f.community
      .trim()
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();

    // 粗筛：同小区 + 同户型 + 面积接近
    const candidates = await scope.findMany<{
      id: string;
      totalPrice: bigint;
      area: unknown;
      floor: number | null;
      rawData: unknown;
    }>('Property', {
      where: {
        city,
        communityNormalized: normalizedCommunity,
        bedrooms: f.bedrooms,
        area: { gte: Math.max(0, Math.round(f.area) - 3), lte: Math.round(f.area) + 3 },
      },
      select: { id: true, totalPrice: true, area: true, floor: true, rawData: true },
      take: 30,
    });

    // 精确比对：重建指纹
    for (const candidate of candidates) {
      const rawData = candidate.rawData as { fingerprint?: string } | null;
      if (rawData?.fingerprint === fingerprint) {
        return { id: candidate.id, totalPrice: candidate.totalPrice };
      }

      // 兼容没有指纹的历史数据：用字段重建比对
      const rebuiltParts = [
        city,
        normalizedCommunity,
        String(f.bedrooms ?? 0),
        String(Math.round(Number(candidate.area))),
        String(candidate.floor ?? 0),
      ];
      const rebuilt = createHash('sha256').update(rebuiltParts.join('|')).digest('hex').slice(0, 32);
      if (rebuilt === fingerprint) {
        return { id: candidate.id, totalPrice: candidate.totalPrice };
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // 入库
  // -------------------------------------------------------------------------

  private async createProperty(
    scope: ReturnType<TenantService['scopeFor']>,
    draft: ParsedPropertyDraft,
    options: { city: string; organizationId: string; sourceLabel: string; fingerprint: string },
  ): Promise<string> {
    const f = draft.fields;

    // 生成外部 ID：内部导入用 IMP- 前缀，与 Mock/Beike 区分开
    const externalId = `IMP-${options.fingerprint.slice(0, 16).toUpperCase()}`;

    // 检查 externalId 是否已存在（理论上指纹已覆盖，这里是双保险）
    const existingByExternalId = await scope.findFirst<{ id: string }>('Property', {
      where: {
        externalProvider: PropertyProviderKind.INTERNAL,
        externalId,
      },
      select: { id: true },
    });

    if (existingByExternalId) {
      throw new Error(`该房源已导入（外部 ID ${externalId}）`);
    }

    const property = await scope.create<{ id: string }>('Property', {
      data: {
        externalProvider: PropertyProviderKind.INTERNAL,
        externalId,
        rawData: {
          source: options.sourceLabel,
          importedAt: new Date().toISOString(),
          parseConfidence: draft.confidence,
          fingerprint: options.fingerprint,
          // 保留原始文本便于人工核对（截断避免撑爆字段）
          rawText: draft.rawText.slice(0, 4000),
          warnings: draft.warnings,
        },

        city: options.city,
        district: f.district ?? '待补充',
        subDistrict: f.subDistrict,
        community: f.community ?? '',
        title: f.title ?? `${f.community} ${f.bedrooms}室`,
        address: f.address,
        longitude: null,
        latitude: null,

        totalPrice: BigInt(f.totalPrice ?? 0),
        unitPrice: f.unitPrice ?? Math.round((f.totalPrice ?? 0) / (f.area ?? 1)),

        bedrooms: f.bedrooms ?? 0,
        livingRooms: f.livingRooms ?? ((f.bedrooms ?? 0) >= 3 ? 2 : 1),
        bathrooms: f.bathrooms ?? 1,
        area: f.area ?? 0,

        floor: f.floor,
        totalFloors: f.totalFloors,

        orientation: f.orientation,
        buildYear: f.buildYear,
        propertyType: f.propertyType ?? PropertyType.APARTMENT,
        ownershipType: f.ownershipType,
        decoration: f.decoration,
        elevator: f.elevator,

        subwayDistance: f.subwayDistance,
        subwayInfo: f.subway ?? undefined,
        schoolInfo: f.schoolInfo ?? undefined,

        tags: f.tags.length > 0 ? f.tags : ['内部房源'],
        floorPlan: [],
        coverImage: f.imageUrls[0] ?? null,
        description: f.description,

        listingStatus: f.listingStatus ?? ListingStatus.ACTIVE,
        listingDate: new Date(),
        lastSyncedAt: new Date(),

        communityNormalized: (f.community ?? '')
          .replace(/[（(][^）)]*[）)]/g, '')
          .replace(/\s+/g, '')
          .toLowerCase(),
        districtNormalized: (f.district ?? '').replace(/[区县]$/, ''),
      },
    });

    // 图片
    if (f.imageUrls.length > 0) {
      await scope.createMany(
        'PropertyImage',
        f.imageUrls.slice(0, 30).map((url, index) => ({
          propertyId: property.id,
          url,
          category: index === 0 ? 'EXTERIOR' : 'INTERIOR',
          sortOrder: index,
        })),
      );
    }

    return property.id;
  }

  /** 更新价格并写价格历史（与 Provider 同步走同一张历史表） */
  private async updatePrice(
    scope: ReturnType<TenantService['scopeFor']>,
    propertyId: string,
    oldPrice: bigint,
    newPrice: bigint,
    draft: ParsedPropertyDraft,
  ): Promise<void> {
    const change = newPrice - oldPrice;
    const changePercent =
      oldPrice !== 0n ? Number(((Number(change) / Number(oldPrice)) * 100).toFixed(3)) : 0;
    const area = draft.fields.area ?? 0;

    await scope.transaction(async (tx) => {
      await tx.update('Property', {
        where: { id: propertyId },
        data: {
          totalPrice: newPrice,
          unitPrice: area > 0 ? Math.round(Number(newPrice) / area) : draft.fields.unitPrice ?? 0,
          lastPriceChange: new Date(),
          lastSyncedAt: new Date(),
        },
      });

      await tx.create('PropertyPriceHistory', {
        data: {
          propertyId,
          oldPrice,
          newPrice,
          change,
          changePercent,
          oldUnitPrice: area > 0 ? Math.round(Number(oldPrice) / area) : null,
          newUnitPrice: area > 0 ? Math.round(Number(newPrice) / area) : null,
          reason: 'MANUAL_IMPORT',
        },
      });
    });

    this.logger.log(
      `导入更新价格：房源 ${propertyId} ${Number(oldPrice) / 10000}万 → ${Number(newPrice) / 10000}万`,
    );
  }

  // -------------------------------------------------------------------------
  // 确认导入（前端预览 → 修正 → 确认的两步流程）
  // -------------------------------------------------------------------------

  /**
   * 按用户修正后的草稿导入。
   *
   * 为什么需要这个：粘贴解析不可能 100% 准确，
   * 让用户在前端修正后再入库，比解析错了直接入库再由人去删要好得多。
   */
  async importConfirmedDrafts(
    organizationId: string,
    drafts: ParsedPropertyDraft[],
    options: ImportOptions = {},
  ): Promise<ImportResult> {
    const startedAt = Date.now();
    const city = options.city ?? '上海';
    const scope = this.tenant.scopeFor(organizationId);

    const result: ImportResult = {
      created: 0,
      skipped: 0,
      priceUpdated: 0,
      rejected: 0,
      details: [],
      durationMs: 0,
    };

    for (const draft of drafts) {
      const f = draft.fields;

      // 用户修正后仍缺关键字段则拒绝
      if (!f.community || f.totalPrice === null || f.area === null || f.bedrooms === null) {
        result.rejected += 1;
        result.details.push({
          draftId: draft.draftId,
          status: 'REJECTED',
          propertyId: null,
          title: f.title ?? f.community ?? draft.draftId,
          reason: '缺少关键字段（小区/总价/面积/户型）',
        });
        continue;
      }

      const fingerprint = this.buildFingerprint(draft, city);

      try {
        const existing = await this.findByFingerprint(scope, fingerprint, draft, city);

        if (existing) {
          const newPrice = BigInt(f.totalPrice);
          if ((options.updateOnDuplicate ?? true) && existing.totalPrice !== newPrice) {
            await this.updatePrice(scope, existing.id, existing.totalPrice, newPrice, draft);
            result.priceUpdated += 1;
            result.details.push({
              draftId: draft.draftId,
              status: 'PRICE_UPDATED',
              propertyId: existing.id,
              title: f.title ?? f.community,
              reason: '价格已更新',
            });
          } else {
            result.skipped += 1;
            result.details.push({
              draftId: draft.draftId,
              status: 'SKIPPED_DUPLICATE',
              propertyId: existing.id,
              title: f.title ?? f.community,
              reason: '系统中已存在相同房源',
            });
          }
          continue;
        }

        const propertyId = await this.createProperty(scope, draft, {
          city,
          organizationId,
          sourceLabel: options.sourceLabel ?? 'PASTE_IMPORT',
          fingerprint,
        });

        result.created += 1;
        result.details.push({
          draftId: draft.draftId,
          status: 'CREATED',
          propertyId,
          title: f.title ?? f.community,
          reason: null,
        });
      } catch (error) {
        result.rejected += 1;
        result.details.push({
          draftId: draft.draftId,
          status: 'REJECTED',
          propertyId: null,
          title: f.title ?? f.community ?? draft.draftId,
          reason: error instanceof Error ? error.message.slice(0, 150) : '入库失败',
        });
      }
    }

    result.durationMs = Date.now() - startedAt;
    return result;
  }

  /** 把草稿转成 NormalizedProperty（供需要走 Provider 同步链路的场景） */
  toNormalizedProperty(
    draft: ParsedPropertyDraft,
    options: { city: string; externalId: string; organizationId: string },
  ): NormalizedProperty | null {
    return this.parser.toNormalizedProperty(draft, options);
  }
}
