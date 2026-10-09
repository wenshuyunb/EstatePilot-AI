/**
 * 把贝壳完整详情持久化到数据库。
 *
 * ============================================================================
 * 为什么必须存库
 * ============================================================================
 * 完整详情是**花 API 配额换来的**（每套 2 次贝壳调用）。
 * 如果只放内存缓存：
 *   · 贝壳限流时（恢复需 20 分钟以上）详情全部丢失 → 界面只能显示"暂无详情"
 *   · API 重启后缓存清空 → 又要重新消耗配额
 *
 * 存库后：
 *   · 限流期间仍能展示完整详情（来自上次成功获取的数据）
 *   · 界面显示详情的获取时间，让经纪人知道新鲜度
 *
 * ============================================================================
 * 数据流
 * ============================================================================
 *   贝壳 entity_detail + entity_material
 *     → BeikeDetailParser 解析
 *     → 本服务写入 Property.fullDetail / detailFetchedAt
 *     → 缓存降级时由 CachedPropertySearchService 读回
 *     → 前端 PropertyDetailPanel 渲染
 *
 * 用法：编排器在详情补全成功后调用 `persistMany()`。
 */

import { Injectable, Logger } from '@nestjs/common';

import { TenantService } from '../tenant/tenant.service.js';
import type { PropertyFullDetail } from '../property/providers/beike/beike-detail-parser.service.js';

export interface PersistDetailInput {
  externalId: string;
  detail: PropertyFullDetail;
  /** 详情来源说明（写入 JSON，便于追溯是实时还是缓存） */
  source: string;
}

@Injectable()
export class PropertyDetailStore {
  private readonly logger = new Logger(PropertyDetailStore.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 批量持久化完整详情。
   *
   * @returns 成功写入的条数
   */
  async persistMany(
    organizationId: string,
    inputs: PersistDetailInput[],
  ): Promise<number> {
    if (inputs.length === 0) return 0;

    const scope = this.tenant.scopeFor(organizationId);

    /**
     * 一次性查出这些房源的数据库 ID。
     *
     * 为什么用 externalId 反查而不是让调用方传：调用方（编排器）
     * 手里只有 externalId，而 upsert 的 idMap 在这一步可能还没建好。
     * 反查一次的成本远低于改造调用链。
     */
    const records = await scope.findMany<{ id: string; externalId: string }>('Property', {
      where: {
        externalId: { in: inputs.map((input) => input.externalId) },
      },
      select: { id: true, externalId: true },
    });

    const idByExternal = new Map<string, string>(
      records.map((record) => [record.externalId, record.id]),
    );

    const fetchedAt = new Date();
    let written = 0;

    for (const input of inputs) {
      const propertyId = idByExternal.get(input.externalId);
      if (!propertyId) {
        // 房源不在库里（可能是多源去重后用了别的 externalId）—— 跳过，不报错
        continue;
      }

      try {
        await scope.update('Property', {
          where: { id: propertyId },
          data: {
            fullDetail: {
              ...input.detail,
              // 记录来源与时间，界面据此展示"详情获取于 X"
              _meta: { source: input.source, fetchedAt: fetchedAt.toISOString() },
            } as unknown as object,
            detailFetchedAt: fetchedAt,
          },
        });
        written += 1;
      } catch (error) {
        this.logger.warn(
          `详情写入失败（房源 ${input.externalId}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (written > 0) {
      this.logger.log(`完整详情已入库：${written} 套（含小区信息、周边配套与图片）`);
    }

    return written;
  }

  /**
   * 读取**单套**房源的已持久化详情（供按需加载使用）。
   *
   * 与 `loadMany` 的区别：这是"经纪人点开某一套"的路径，
   * 返回 null 表示库里没有（需要去贝壳实时获取）。
   */
  async loadOne(
    organizationId: string,
    externalId: string,
  ): Promise<{ detail: PropertyFullDetail; detailFetchedAt: Date | null } | null> {
    const scope = this.tenant.scopeFor(organizationId);

    const record = await scope.findFirst<{
      fullDetail: unknown;
      detailFetchedAt: Date | null;
    }>('Property', {
      where: { externalId },
      select: { fullDetail: true, detailFetchedAt: true },
    });

    if (!record?.fullDetail || typeof record.fullDetail !== 'object') return null;

    const { _meta: _ignored, ...detail } = record.fullDetail as Record<string, unknown>;
    void _ignored;

    return {
      detail: detail as unknown as PropertyFullDetail,
      detailFetchedAt: record.detailFetchedAt,
    };
  }

  /**
   * 持久化**单套**房源详情（供按需加载使用）。
   */
  async persistOne(
    organizationId: string,
    externalId: string,
    detail: PropertyFullDetail,
  ): Promise<void> {
    await this.persistMany(organizationId, [{ externalId, detail, source: 'BEIKE_LIVE' }]);
  }

  /**
   * 读取已持久化的详情（供缓存降级路径使用）。
   *
   * @returns externalId → 详情（只返回有详情的房源）
   */
  async loadMany(
    organizationId: string,
    externalIds: string[],
  ): Promise<Map<string, { detail: PropertyFullDetail; detailFetchedAt: Date | null }>> {
    const result = new Map<string, { detail: PropertyFullDetail; detailFetchedAt: Date | null }>();

    if (externalIds.length === 0) return result;

    const scope = this.tenant.scopeFor(organizationId);

    const records = await scope.findMany<{
      externalId: string;
      fullDetail: unknown;
      detailFetchedAt: Date | null;
    }>('Property', {
      where: { externalId: { in: externalIds } },
      select: { externalId: true, fullDetail: true, detailFetchedAt: true },
    });

    for (const record of records) {
      if (!record.fullDetail || typeof record.fullDetail !== 'object') continue;

      // 去掉内部元数据再交给界面（_meta 只在库里有意义）
      const { _meta: _ignored, ...detail } = record.fullDetail as Record<string, unknown>;
      void _ignored;

      result.set(record.externalId, {
        detail: detail as unknown as PropertyFullDetail,
        detailFetchedAt: record.detailFetchedAt,
      });
    }

    return result;
  }
}
