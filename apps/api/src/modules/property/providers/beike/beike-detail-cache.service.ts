/**
 * 贝壳详情缓存 —— 同一房源在 TTL 内不重复请求。
 *
 * ============================================================================
 * 为什么需要（真实事故）
 * ============================================================================
 * 经纪人会反复搜同一个客户的需求（客户改口一次就搜一次），
 * 每次都会重新拉取**同一批房源**的详情。
 *
 * 实测：同一小区（如"高林居住区三里"）在多次搜索中反复出现，
 * 每次都打 2 次贝壳接口（detail + material）。
 * 这既是浪费，也是触发限流的主因之一。
 *
 * ============================================================================
 * 缓存策略
 * ============================================================================
 *   · **按房源 ID 缓存**，不是按搜索条件 —— 房源详情与其被怎么搜到无关
 *   · TTL 默认 30 分钟：房源详情变化很慢（价格可能变，但小区/周边几乎不变），
 *     而贝壳的挂牌状态变化通常以天计
 *   · **容量上限 + LRU 淘汰**：内存不能无限增长
 *
 * ⚠️ 缓存**不改变可信度判定**：命中的是"本次仍然是实时查询"},
 *    只是省掉了重复请求。详情里不含"是否仍在售"这种时效极强的字段时，
 *    才允许这么缓存 —— 挂牌状态以搜索结果为权威。
 */

import { Injectable, Logger } from '@nestjs/common';

import type { PropertyFullDetail } from './beike-detail-parser.service.js';
import type { PropertyImage } from './beike-detail-parser.service.js';
import { BEIKE_USAGE_POLICY } from './beike-usage-policy.js';

/** 缓存条目 */
interface CacheEntry {
  detail: PropertyFullDetail;
  vrUrl: string | null;
  images: PropertyImage[];
  cachedAt: number;
}

@Injectable()
export class BeikeDetailCache {
  private readonly logger = new Logger(BeikeDetailCache.name);

  /** TTL：30 分钟（集中定义在 usage-policy，避免多处硬编码不一致） */
  private readonly ttlMs = BEIKE_USAGE_POLICY.detailCacheTtlMs;

  /** 容量上限：500 套房源（每套详情约 10-30KB，总量可控） */
  private readonly maxEntries = 500;

  /**
   * 用 Map 实现 LRU：Map 保持插入顺序，
   * 命中时先 delete 再 set 即可把条目移到"最新"位置。
   */
  private readonly store = new Map<string, CacheEntry>();

  /** 统计（供诊断） */
  private hits = 0;
  private misses = 0;

  /** 取缓存（命中会刷新 LRU 位置） */
  get(propertyId: string): CacheEntry | null {
    const entry = this.store.get(propertyId);

    if (!entry) {
      this.misses += 1;
      return null;
    }

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(propertyId);
      this.misses += 1;
      return null;
    }

    // 移到最新位置（LRU）
    this.store.delete(propertyId);
    this.store.set(propertyId, entry);
    this.hits += 1;

    return entry;
  }

  /** 写入缓存 */
  set(
    propertyId: string,
    value: { detail: PropertyFullDetail; vrUrl: string | null; images: PropertyImage[] },
  ): void {
    // 已存在则先删（保证 LRU 顺序）
    this.store.delete(propertyId);

    this.store.set(propertyId, { ...value, cachedAt: Date.now() });

    // 超容量则淘汰最旧的（Map 的第一个键）
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** 批量查询：返回命中的部分 */
  getMany(propertyIds: string[]): Map<string, CacheEntry> {
    const result = new Map<string, CacheEntry>();

    for (const id of propertyIds) {
      const entry = this.get(id);
      if (entry) result.set(id, entry);
    }

    return result;
  }

  /** 统计快照 */
  snapshot(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${Math.round((this.hits / total) * 100)}%` : '—',
    };
  }

  /** 清空（测试用） */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
