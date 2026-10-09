/**
 * 房源详情服务 —— 按需加载完整详情与图片。
 *
 * ============================================================================
 * 为什么改为按需（真实容量数据驱动）
 * ============================================================================
 * 实测调用量分析（20 次搜索/天/人的典型场景）：
 *   · 列表预取全部详情：一次搜索 11 次调用 → 约 220 次/天/人
 *   · 列表只取摘要 + 详情按需：一次搜索 1 次调用 → 约 30 次/天/人
 *
 * 而实测：11 次密集调用即触发贝壳限流，**恢复需 30 分钟以上**，
 * 且限流是按账号/Key 计的 —— 10 个经纪人共用同一份额度。
 *
 * 因此策略调整为：
 *   · **列表**：只用搜索响应自带的摘要字段（面积/户型/朝向/楼层/年份/小区）
 *   · **详情**：经纪人点开某一套时才加载（本服务）
 *   · **缓存**：详情加载后落库 + 内存缓存，30 分钟内重复查看零调用
 *
 * ============================================================================
 * 数据来源优先级
 * ============================================================================
 *   1. 内存缓存（本次进程已取过）—— 最快
 *   2. 数据库持久化（历史取过）—— 快，且限流/重启后仍可用
 *   3. 贝壳实时接口 —— 慢（2-3 秒），消耗配额
 *
 * 只有 1、2 都未命中才走 3。这样"同一套房源只看一次"，
 * 反复查看不产生任何额外调用。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BeikeMcpClient } from './beike-mcp-client.js';
import { BeikeDetailCache } from './beike-detail-cache.service.js';
import {
  BeikeDetailParser,
  type PropertyFullDetail,
  type PropertyImage,
} from './beike-detail-parser.service.js';

export interface LoadedDetail {
  detail: PropertyFullDetail;
  images: PropertyImage[];
  vrUrl: string | null;
  /** 数据来源，便于界面如实标注新鲜度 */
  from: 'MEMORY_CACHE' | 'DATABASE' | 'BEIKE_LIVE';
  /** 详情获取时间（界面展示"获取于 X 分钟前"） */
  fetchedAt: string | null;
  /** 可取到的警告（如"本次为历史数据"） */
  note: string | null;
}

/** 数据库读取回调（由调用方注入，避免本服务依赖 requirement 模块） */
export type PersistedDetailLoader = (
  externalId: string,
) => Promise<{ detail: PropertyFullDetail; detailFetchedAt: Date | null } | null>;

/** 数据库写入回调 */
export type PersistedDetailSaver = (
  externalId: string,
  detail: PropertyFullDetail,
) => Promise<void>;

@Injectable()
export class PropertyDetailService {
  private readonly logger = new Logger(PropertyDetailService.name);

  /** 同一房源的并发加载去重（避免用户连点产生多次请求） */
  private readonly inflight = new Map<string, Promise<LoadedDetail | null>>();

  constructor(
    private readonly beike: BeikeMcpClient,
    private readonly parser: BeikeDetailParser,
    private readonly cache: BeikeDetailCache,
  ) {}

  /**
   * 加载某套房源的完整详情。
   *
   * @param city 城市（贝壳接口必填）
   * @param loadPersisted 从数据库读取历史详情的回调
   * @param savePersisted 把实时详情落库的回调
   */
  async load(
    externalId: string,
    city: string,
    loadPersisted: PersistedDetailLoader,
    savePersisted: PersistedDetailSaver,
  ): Promise<LoadedDetail | null> {
    // ---- 并发去重：同一房源已在加载中就直接复用 ----
    const existing = this.inflight.get(externalId);
    if (existing) {
      this.logger.debug(`房源 ${externalId} 详情已在加载中，复用同一请求`);
      return existing;
    }

    const task = this.doLoad(externalId, city, loadPersisted, savePersisted).finally(() => {
      this.inflight.delete(externalId);
    });

    this.inflight.set(externalId, task);
    return task;
  }

  private async doLoad(
    externalId: string,
    city: string,
    loadPersisted: PersistedDetailLoader,
    savePersisted: PersistedDetailSaver,
  ): Promise<LoadedDetail | null> {
    // ======================================================================
    // 1. 内存缓存
    // ======================================================================
    const cached = this.cache.get(externalId);
    if (cached) {
      return {
        detail: cached.detail,
        images: cached.images,
        vrUrl: cached.vrUrl,
        from: 'MEMORY_CACHE',
        fetchedAt: new Date(cached.cachedAt).toISOString(),
        note: null,
      };
    }

    // ======================================================================
    // 2. 数据库持久化
    // ======================================================================
    try {
      const persisted = await loadPersisted(externalId);
      if (persisted) {
        // 回填内存缓存，下次更快
        this.cache.set(externalId, {
          detail: persisted.detail,
          vrUrl: persisted.detail.vrUrl,
          images: persisted.detail.images,
        });

        const ageMinutes = persisted.detailFetchedAt
          ? Math.round((Date.now() - persisted.detailFetchedAt.getTime()) / 60_000)
          : null;

        return {
          detail: persisted.detail,
          images: persisted.detail.images,
          vrUrl: persisted.detail.vrUrl,
          from: 'DATABASE',
          fetchedAt: persisted.detailFetchedAt?.toISOString() ?? null,
          note:
            ageMinutes !== null && ageMinutes > 60
              ? `这是 ${Math.round(ageMinutes / 60)} 小时前获取的详情，价格与在售状态可能有变化`
              : null,
        };
      }
    } catch (error) {
      this.logger.warn(
        `读取历史详情失败（房源 ${externalId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // ======================================================================
    // 3. 贝壳实时接口（消耗配额）
    // ======================================================================
    const client = this.beike.getDirectClient();
    if (!client) {
      this.logger.debug('直连未启用，无法加载实时详情');
      return null;
    }

    try {
      const detailResult = await client.callTool('entity_detail', {
        city_name: city,
        entity_ids: externalId,
        entity_type: 'house',
      });

      if (!detailResult.ok) {
        this.logger.warn(
          `房源 ${externalId} 详情获取失败：${String(detailResult.error).slice(0, 120)}`,
        );
        return null;
      }

      const detail = this.parser.parseDetail(detailResult.text);

      // 图片单独取（entity_detail 只带户型图，实景图要 entity_material）
      const materialResult = await client.callTool('entity_material', {
        city_name: city,
        entity_ids: externalId,
        entity_type: 'house',
        fields: ['房源图片'],
      });

      const material = materialResult.ok
        ? this.parser.parseMaterial(materialResult.text)
        : { images: [] as PropertyImage[], vrUrl: null as string | null };

      // 合并图片并按 URL 去重
      const merged = new Map<string, PropertyImage>();
      for (const image of [...material.images, ...detail.images]) {
        const key = image.url.split('?')[0] ?? image.url;
        if (!merged.has(key)) merged.set(key, image);
      }

      const images = [...merged.values()];
      detail.images = images;
      detail.vrUrl = material.vrUrl ?? detail.vrUrl;

      // 写缓存 + 落库
      this.cache.set(externalId, { detail, vrUrl: detail.vrUrl, images });

      try {
        await savePersisted(externalId, detail);
      } catch (error) {
        // 落库失败不影响返回 —— 内存缓存已有
        this.logger.warn(
          `详情落库失败（房源 ${externalId}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return {
        detail,
        images,
        vrUrl: detail.vrUrl,
        from: 'BEIKE_LIVE',
        fetchedAt: new Date().toISOString(),
        note: null,
      };
    } catch (error) {
      this.logger.warn(
        `房源 ${externalId} 实时详情异常：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
