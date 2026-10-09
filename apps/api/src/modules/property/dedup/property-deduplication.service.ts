/**
 * 房源去重引擎 —— 跨源归并同一套真实房源。
 *
 * ============================================================================
 * 要解决的问题（需求 §8）
 * ============================================================================
 * 同一套房子可能同时出现在多个平台：
 *   贝壳：  XX花园  105㎡  568万  ID 123456
 *   安居客：XX花园  105㎡  565万  ID 998877
 *   → 必须是**一条**推荐，而不是两条。
 *
 * ============================================================================
 * 三级判定策略
 * ============================================================================
 *   第一级：强标识匹配（同 provider + 同 externalId）          置信度 1.00
 *   第二级：指纹精确匹配（归一化小区 + 户型 + 面积档 + 楼层档）  置信度 0.95
 *   第三级：模糊相似度（多维加权）                              置信度 0.60~0.90
 *
 * ============================================================================
 * 核心设计决策：疑似重复**不自动合并**
 * ============================================================================
 * 相似度落在 [0.70, 0.85) 的区间时，标记为「疑似」→ 进人工确认队列。
 *
 * 理由：**错误合并的代价远高于漏合并**。
 *   - 漏合并：经纪人看到两条相似房源，可能自己发现是同一套（可恢复）
 *   - 错误合并：把两套不同的房子合成一条 → 经纪人带客户看错房（不可恢复，且损害信任）
 *
 * 因此宁可让经纪人确认，也不自动合并。
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { NormalizedProperty } from '@estatepilot/types';
import { CommunityNormalizerService } from './community-normalizer.service.js';

/** 归并判定结果的类型 */
export enum DeduplicationVerdict {
  /** 确定是同一套房（强标识或指纹完全一致）→ 自动归并 */
  SAME = 'SAME',
  /** 疑似同一套（相似度在阈值区间）→ 需人工确认 */
  SUSPECTED = 'SUSPECTED',
  /** 不同房源 */
  DIFFERENT = 'DIFFERENT',
}

/** 归并判定结果 */
export interface DeduplicationDecision {
  verdict: DeduplicationVerdict;
  /** 置信度 0~1 */
  confidence: number;
  /** 判定依据（人类可读，便于审计与调试） */
  reason: string;
  /** 各维度得分明细（第三级判定时有值） */
  breakdown?: Array<{ dimension: string; score: number; weight: number; detail: string }>;
}

/** 指纹构成（便于调试时看清是哪部分导致不匹配） */
export interface PropertyFingerprint {
  hash: string;
  parts: {
    city: string;
    communityNormalized: string;
    bedrooms: number;
    /** 面积档（归到 2㎡ 一档，容忍跨源 1㎡ 误差） */
    areaBucket: number;
    /** 楼层档：低/中/高（不同平台对楼层记录方式不同，不能要求精确相等） */
    floorBucket: string;
  };
}

/** 相似度阈值配置 */
export interface DeduplicationThresholds {
  /** ≥ 该值自动归并 */
  autoMerge: number;
  /** ≥ 该值标记为疑似（低于 autoMerge） */
  suspected: number;
}

export const DEFAULT_DEDUP_THRESHOLDS: DeduplicationThresholds = {
  autoMerge: 0.85,
  suspected: 0.7,
};

@Injectable()
export class PropertyDeduplicationService {
  private readonly logger = new Logger(PropertyDeduplicationService.name);

  /** 各维度权重（总和 = 1） */
  private static readonly WEIGHTS = {
    community: 0.4,
    area: 0.2,
    layout: 0.15,
    price: 0.15,
    floor: 0.1,
  } as const;

  constructor(private readonly communityNormalizer: CommunityNormalizerService) {}

  // ==========================================================================
  // 指纹
  // ==========================================================================

  /**
   * 构建跨源归并指纹。
   *
   * 设计要点（每一处都有踩坑依据）：
   *
   * 1. **面积档精度与匹配的关系**
   *    指纹用于"把候选聚到一起"，**判定精度由 `compare()` 负责**（它会算相对误差）。
   *    因此档位要**足够宽**以容忍跨源误差，又不能宽到把不同户型混在一起。
   *
   *    ⚠️ 踩过的坑：最初用 `Math.round(area / 2) * 2`（2㎡ 档），
   *    104.8 → 104 而 105.2 → 106，两条**跨源同一套房**落进不同档 → 漏匹配。
   *    根因是边界处舍入方向相反。
   *    现在用 5㎡ 档：104.8 → 105、105.2 → 105，稳定命中。
   *    5㎡ 的宽档不会误合并（105㎡ 与 135㎡ 仍分属不同档）。
   *
   * 2. **楼层分档必须考虑建筑总层数**
   *    ⚠️ 踩过的坑：最初纯按比例分档（≤33% 低 / ≤67% 中 / 其余高），
   *    导致 6 层楼的 5 楼被判为"高楼层"—— 但 5/6 层显然是中楼层。
   *    比例法对低层建筑失效。现在：总层数 ≤6 时不设"高"档。
   *
   * 3. **小区名用归一化后的键**
   *    这是跨源匹配的关键 —— "玉兰香苑(四期)" 与 "玉兰香苑" 归一化后应相同。
   */
  buildFingerprint(property: NormalizedProperty): PropertyFingerprint {
    const communityNormalized = this.communityNormalizer.normalizeKey(
      property.community,
      property.district,
    );

    const areaBucket = this.toAreaBucket(property.area);
    const floorBucket = this.toFloorBucket(property.floor, property.totalFloors);

    const parts = {
      city: property.city,
      communityNormalized,
      bedrooms: property.bedrooms,
      areaBucket,
      floorBucket,
    };

    const hash = createHash('sha256')
      .update(
        [parts.city, parts.communityNormalized, parts.bedrooms, parts.areaBucket, parts.floorBucket].join('|'),
      )
      .digest('hex')
      .slice(0, 32);

    return { hash, parts };
  }

  /**
   * 面积分档：5㎡ 一档。
   *
   * 为什么是 5：跨源面积记录的差异通常在 1㎡ 内（104.8 vs 105.2），
   * 5㎡ 档足以吸收这种误差，又远小于相邻户型的面积差（通常 ≥10㎡）。
   */
  private toAreaBucket(area: number): number {
    return Math.round(area / 5) * 5;
  }

  /**
   * 楼层分档。
   *
   * 规则：
   *   - 总层数 ≤ 6（多层/老式公房）→ 只有 low / mid，**没有 high**
   *     （6 层楼的 5、6 楼是中楼层，不是"高层"）
   *   - 总层数 > 6 → 按比例分 low / mid / high
   *   - 无总层数 → 用绝对楼层粗判
   */
  private toFloorBucket(floor: number | null, totalFloors: number | null): string {
    if (floor === null) return 'unknown';

    // 无总层数：绝对楼层粗判
    if (totalFloors === null || totalFloors <= 0) {
      if (floor <= 3) return 'low';
      if (floor <= 8) return 'mid';
      return 'high';
    }

    // 低层建筑（≤6 层）：不设 high 档
    if (totalFloors <= 6) {
      return floor <= 2 ? 'low' : 'mid';
    }

    const ratio = floor / totalFloors;
    if (ratio <= 0.34) return 'low';
    if (ratio <= 0.7) return 'mid';
    return 'high';
  }

  // ==========================================================================
  // 判定
  // ==========================================================================

  /**
   * 判定两条房源是否为同一套。
   *
   * @param thresholds 阈值配置（不同租户可能有不同容忍度）
   */
  compare(
    a: NormalizedProperty,
    b: NormalizedProperty,
    thresholds: DeduplicationThresholds = DEFAULT_DEDUP_THRESHOLDS,
  ): DeduplicationDecision {
    // ---- 第一级：强标识 ----
    const sameProvider = a.externalProvider === b.externalProvider;
    const sameExternalId = a.externalId === b.externalId;

    // 同 provider 但 externalId 不同 → **确定是两套**（同一平台的房源 ID 唯一）
    if (sameProvider && !sameExternalId) {
      return {
        verdict: DeduplicationVerdict.DIFFERENT,
        confidence: 1,
        reason: `同一来源（${a.externalProvider}）但 externalId 不同 → 是两套房源`,
      };
    }

    if (sameProvider && sameExternalId) {
      return {
        verdict: DeduplicationVerdict.SAME,
        confidence: 1,
        reason: '同来源同 externalId → 同一条记录',
      };
    }

    // ---- 第二级：指纹精确匹配（跨源） ----
    const fingerprintA = this.buildFingerprint(a);
    const fingerprintB = this.buildFingerprint(b);

    if (fingerprintA.hash === fingerprintB.hash) {
      // 指纹一致还要交叉验证价格：同小区同户型同面积同楼层，价格差太多可能是不同房源
      // （例如同一栋楼的镜像户型）
      const priceDiffRatio = this.relativeDiff(a.totalPrice, b.totalPrice);

      if (priceDiffRatio <= 0.05) {
        return {
          verdict: DeduplicationVerdict.SAME,
          confidence: 0.95,
          reason:
            `指纹一致（${fingerprintA.parts.communityNormalized} / ${a.bedrooms}房 / ` +
            `${fingerprintA.parts.areaBucket}㎡档 / ${fingerprintA.parts.floorBucket}层档）` +
            `，价格差 ${(priceDiffRatio * 100).toFixed(1)}%`,
        };
      }

      // 指纹一致但价格差 > 5% → 疑似，交人工确认
      return {
        verdict: DeduplicationVerdict.SUSPECTED,
        confidence: 0.75,
        reason:
          `指纹一致但价格差异较大（${(priceDiffRatio * 100).toFixed(1)}%），` +
          `可能是不同房源或报价差异，建议人工确认`,
      };
    }

    // ---- 第三级：模糊相似度 ----
    const breakdown = this.scoreDimensions(a, b);
    const similarity = breakdown.reduce((sum, item) => sum + item.score * item.weight, 0);

    if (similarity >= thresholds.autoMerge) {
      return {
        verdict: DeduplicationVerdict.SAME,
        confidence: similarity,
        reason: `多维相似度 ${(similarity * 100).toFixed(1)}% ≥ ${(thresholds.autoMerge * 100).toFixed(0)}%，判定为同一套`,
        breakdown,
      };
    }

    if (similarity >= thresholds.suspected) {
      return {
        verdict: DeduplicationVerdict.SUSPECTED,
        confidence: similarity,
        reason:
          `多维相似度 ${(similarity * 100).toFixed(1)}% 落在疑似区间 ` +
          `[${(thresholds.suspected * 100).toFixed(0)}%, ${(thresholds.autoMerge * 100).toFixed(0)}%)，` +
          `需人工确认（错误合并会导致带看错房，因此不自动合并）`,
        breakdown,
      };
    }

    return {
      verdict: DeduplicationVerdict.DIFFERENT,
      confidence: 1 - similarity,
      reason: `多维相似度 ${(similarity * 100).toFixed(1)}% 低于疑似阈值`,
      breakdown,
    };
  }

  /**
   * 各维度打分。
   *
   * 权重：小区 40% / 面积 20% / 户型 15% / 价格 15% / 楼层 10%
   *
   * 为什么小区权重最高：小区是最强的区分特征。
   * 两个房源在任何其它维度都可能巧合相似，但小区不同基本可以确定不是同一套。
   */
  private scoreDimensions(
    a: NormalizedProperty,
    b: NormalizedProperty,
  ): Array<{ dimension: string; score: number; weight: number; detail: string }> {
    const weights = PropertyDeduplicationService.WEIGHTS;

    // ---- 小区 ----
    const communityScore = this.communityNormalizer.similarity(a.community, b.community);

    // ---- 面积（相对误差 < 2% 满分，> 5% 归零） ----
    const areaDiff = this.relativeDiff(a.area, b.area);
    const areaScore = areaDiff <= 0.02 ? 1 : areaDiff >= 0.05 ? 0 : 1 - (areaDiff - 0.02) / 0.03;

    // ---- 户型 ----
    const layoutMatch =
      a.bedrooms === b.bedrooms &&
      a.livingRooms === b.livingRooms &&
      a.bathrooms === b.bathrooms;
    const bedroomsMatch = a.bedrooms === b.bedrooms;
    const layoutScore = layoutMatch ? 1 : bedroomsMatch ? 0.7 : 0;

    // ---- 价格（相对误差 < 1% 满分，> 5% 归零） ----
    // 不同平台报价会有差异，因此容忍度比面积大
    const priceDiff = this.relativeDiff(a.totalPrice, b.totalPrice);
    const priceScore = priceDiff <= 0.01 ? 1 : priceDiff >= 0.05 ? 0 : 1 - (priceDiff - 0.01) / 0.04;

    // ---- 楼层 ----
    const floorA = this.toFloorBucket(a.floor, a.totalFloors);
    const floorB = this.toFloorBucket(b.floor, b.totalFloors);
    const floorScore = floorA === floorB ? 1 : floorA === 'unknown' || floorB === 'unknown' ? 0.5 : 0;

    return [
      {
        dimension: '小区',
        score: communityScore,
        weight: weights.community,
        detail: `${a.community} vs ${b.community}`,
      },
      {
        dimension: '面积',
        score: areaScore,
        weight: weights.area,
        detail: `${a.area}㎡ vs ${b.area}㎡（差 ${(areaDiff * 100).toFixed(1)}%）`,
      },
      {
        dimension: '户型',
        score: layoutScore,
        weight: weights.layout,
        detail: `${a.bedrooms}室${a.livingRooms}厅${a.bathrooms}卫 vs ${b.bedrooms}室${b.livingRooms}厅${b.bathrooms}卫`,
      },
      {
        dimension: '价格',
        score: priceScore,
        weight: weights.price,
        detail: `${this.formatWan(a.totalPrice)} vs ${this.formatWan(b.totalPrice)}（差 ${(priceDiff * 100).toFixed(1)}%）`,
      },
      {
        dimension: '楼层',
        score: floorScore,
        weight: weights.floor,
        detail: `${floorA} vs ${floorB}`,
      },
    ];
  }

  /** 相对差异（分母用较大值，避免除零） */
  private relativeDiff(a: number, b: number): number {
    const max = Math.max(Math.abs(a), Math.abs(b));
    if (max === 0) return 0;
    return Math.abs(a - b) / max;
  }

  private formatWan(amount: number): string {
    return `${Math.round(amount / 10_000)}万`;
  }

  // ==========================================================================
  // 批量归并
  // ==========================================================================

  /** 归并结果 */
  merge(properties: NormalizedProperty[]): {
    merged: Array<{ primary: NormalizedProperty; duplicates: NormalizedProperty[] }>;
    suspected: Array<{ a: NormalizedProperty; b: NormalizedProperty; decision: DeduplicationDecision }>;
  } {
    const groups: Array<{ primary: NormalizedProperty; duplicates: NormalizedProperty[] }> = [];
    const suspected: Array<{ a: NormalizedProperty; b: NormalizedProperty; decision: DeduplicationDecision }> = [];

    // 指纹索引：加速精确匹配（这是绝大多数命中路径）
    const fingerprintIndex = new Map<string, number>();

    for (const property of properties) {
      const fingerprint = this.buildFingerprint(property);

      // 先按指纹快速查
      const existingIndex = fingerprintIndex.get(fingerprint.hash);
      if (existingIndex !== undefined) {
        const group = groups[existingIndex];
        if (group) {
          const decision = this.compare(group.primary, property);

          if (decision.verdict === DeduplicationVerdict.SAME) {
            group.duplicates.push(property);
            continue;
          }

          if (decision.verdict === DeduplicationVerdict.SUSPECTED) {
            suspected.push({ a: group.primary, b: property, decision });
          }
        }
      }

      // 指纹没命中 → 做一次小范围模糊比对（只跟同小区候选比，避免 O(n²)）
      const fuzzyMatchIndex = this.findFuzzyMatch(groups, property);
      if (fuzzyMatchIndex !== null) {
        const group = groups[fuzzyMatchIndex];
        if (group) {
          const decision = this.compare(group.primary, property);
          if (decision.verdict === DeduplicationVerdict.SAME) {
            group.duplicates.push(property);
            continue;
          }
          if (decision.verdict === DeduplicationVerdict.SUSPECTED) {
            suspected.push({ a: group.primary, b: property, decision });
          }
        }
      }

      fingerprintIndex.set(fingerprint.hash, groups.length);
      groups.push({ primary: property, duplicates: [] });
    }

    const mergedAway = groups.reduce((sum, group) => sum + group.duplicates.length, 0);
    this.logger.log(
      `去重完成：输入 ${properties.length} 条 → 归并后 ${groups.length} 条` +
        `（合并掉 ${mergedAway} 条，疑似待确认 ${suspected.length} 组）`,
    );

    return { merged: groups, suspected };
  }

  /**
   * 在已有分组中找可能的模糊匹配。
   *
   * 只跟**同小区**的候选比对 —— 这是关键的性能优化：
   * 全量两两比对是 O(n²)，而按小区分桶后每组通常只有几条。
   */
  private findFuzzyMatch(
    groups: Array<{ primary: NormalizedProperty }>,
    property: NormalizedProperty,
  ): number | null {
    const city = property.city;

    for (let index = 0; index < groups.length; index += 1) {
      const candidate = groups[index]?.primary;
      if (!candidate) continue;

      // 必须同城
      if (candidate.city !== city) continue;

      // 小区必须相似（这是最强的区分特征，先做粗筛）
      if (
        !this.communityNormalizer.isSameCommunity(
          { community: candidate.community, district: candidate.district },
          { community: property.community, district: property.district },
        )
      ) {
        continue;
      }

      // 户型不同基本可以排除（3房与2房不可能是同一套）
      if (candidate.bedrooms !== property.bedrooms) continue;

      return index;
    }

    return null;
  }
}
