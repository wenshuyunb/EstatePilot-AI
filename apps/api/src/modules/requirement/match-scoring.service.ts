/**
 * 房源匹配评分服务。
 *
 * 权重设计（需求 §19，合计 100）：
 *   预算 25 / 区域 15 / 户型 15 / 面积 10 / 房龄 10 / 交通 10 / 小区 5 / 装修 5 / 历史偏好 5
 *
 * 设计要点：
 *
 * 1. **每一分都要能解释**（需求 §23）。
 *    每个维度都返回 detail 文本，界面可以直接展示"预算 24/25 —— 比理想预算高 18 万"。
 *    如果只给一个总分，经纪人就无法向客户解释为什么推荐这套，
 *    也无法在客户质疑时快速定位问题。
 *
 * 2. **预算是加权而非线性**。
 *    客户对超预算的敏感度远高于低于预算：
 *      理想预算 550 万，房源 538 万 → 几乎满分（省钱是好事，但不额外加分）
 *      理想预算 550 万，房源 568 万 → 扣分（超了，虽然还在上限内）
 *      理想预算 550 万，房源 598 万 → 明显扣分并给出提示
 *    这条曲线是产品判断，不是数学选择。
 *
 * 3. **历史偏好参与打分但不主导**。
 *    客户以前看过精装房、拒绝过老小区，这些信号有价值，
 *    但权重只有 5 分 —— 不能让历史行为盖过客户的当前明确需求。
 *
 * 4. **拒绝过的相似房源降权**（需求 §37）。
 *    客户说过"不要老小区"，那么同类房源分数降低，
 *    避免反复推荐他已经拒绝的类型。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  BuildingAgePreference,
  Decoration,
  DecorationPreferenceLevel,
  PreferencePriority,
  SCORE_DIMENSION_LABELS,
  DEFAULT_MATCHING_WEIGHTS,
  type MergedRequirementProfile,
  type MatchingScoringWeights,
  type NormalizedProperty,
  type ScoreDimension,
  type ScoredPropertyMatch,
} from '@estatepilot/types';

/**
 * 装修偏好 → 房源装修等级的映射。
 *
 * 为什么需要映射：这是**两套不同的枚举**。
 *   Decoration（房源实际装修）：ROUGH / SIMPLE / FINE / LUXURY
 *   DecorationPreferenceLevel（客户偏好）：上面四个 + ANY（不限）
 * 它们语义相关但类型不同，直接强转会被 TS 正确拦下 —— 这里显式映射，
 * 既让类型安全，也让"偏好高档装修时简装房该扣多少分"这件事变得可读。
 */
const DECORATION_LEVEL: Record<DecorationPreferenceLevel, number> = {
  [DecorationPreferenceLevel.ROUGH]: 0,
  [DecorationPreferenceLevel.SIMPLE]: 1,
  [DecorationPreferenceLevel.FINE]: 2,
  [DecorationPreferenceLevel.LUXURY]: 3,
  // 不限：给一个中间基准，不参与"差距"计算
  [DecorationPreferenceLevel.ANY]: 1,
};

/** 把客户偏好等级映射到房源装修枚举（用于比较实际装修是否达标） */
function preferenceToDecoration(preference: DecorationPreferenceLevel): Decoration | null {
  switch (preference) {
    case DecorationPreferenceLevel.ROUGH:
      return Decoration.ROUGH;
    case DecorationPreferenceLevel.SIMPLE:
      return Decoration.SIMPLE;
    case DecorationPreferenceLevel.FINE:
      return Decoration.FINE;
    case DecorationPreferenceLevel.LUXURY:
      return Decoration.LUXURY;
    default:
      return null;
  }
}

/**
 * 房源实际装修 → 等级数值。
 * 用显式 switch 而不是索引映射，因为两套枚举的类型不重叠，
 * 直接互相索引会被 TS 正确拦下（这是好事：防止将来某个枚举加了新成员而这里被漏掉）。
 */
function decorationToLevel(decoration: Decoration): number {
  switch (decoration) {
    case Decoration.ROUGH:
      return 0;
    case Decoration.SIMPLE:
      return 1;
    case Decoration.FINE:
      return 2;
    case Decoration.LUXURY:
      return 3;
    default:
      return 1;
  }
}

/** 打分上下文：来自行为数据与历史反馈 */
export interface ScoringContext {
  /** 客户历史上多次浏览的装修类型 */
  preferredDecorations?: string[];
  /** 客户历史上忽略/拒绝的特征 */
  rejectedFeatures?: string[];
  /** 客户浏览过的小区（说明接受过这类小区） */
  viewedCommunities?: string[];
  /** 已推荐过的房源（externalId → 上次推荐时的价格） */
  previouslyRecommended?: Map<string, number>;
  /** 客户对价格表达过顾虑 */
  priceSensitive?: boolean;
  /** 权重覆盖（来自后台配置） */
  weights?: Partial<MatchingScoringWeights>;
}

/** 单套房源的评分明细 */
export interface ScoredProperty {
  property: NormalizedProperty;
  matchScore: number;
  breakdown: ScoreDimension[];
  highlights: string[];
  cautions: string[];
  previouslyRecommended: boolean;
  priceDropReentry: boolean;
  priceChange: number;
}

@Injectable()
export class MatchScoringService {
  private readonly logger = new Logger(MatchScoringService.name);

  /**
   * 对一批房源打分并排序。
   *
   * @param properties 已通过硬性过滤的房源
   * @param profile 客户需求画像
   * @param context 打分上下文
   */
  score(
    properties: NormalizedProperty[],
    profile: MergedRequirementProfile,
    context: ScoringContext = {},
  ): ScoredProperty[] {
    const weights: MatchingScoringWeights = {
      ...DEFAULT_MATCHING_WEIGHTS,
      ...(context.weights ?? {}),
    };

    const scored = properties.map((property) => this.scoreOne(property, profile, weights, context));

    // 排序规则：分数降序；分数相同时，价格更接近理想预算的优先
    scored.sort((a, b) => {
      if (Math.abs(b.matchScore - a.matchScore) > 0.5) return b.matchScore - a.matchScore;

      const aDistance = this.budgetDistance(a.property.totalPrice, profile);
      const bDistance = this.budgetDistance(b.property.totalPrice, profile);
      return aDistance - bDistance;
    });

    // 去重降权（需求 §37）：已推荐过且无变化的房源降到后面
    const reordered = this.applyDeduplication(scored);

    if (reordered.length > 0) {
      this.logger.log(
        `匹配打分完成：${reordered.length} 套房源，` +
          `最高 ${reordered[0]?.matchScore} 分（${reordered[0]?.property.community}），` +
          `平均 ${Math.round(
            reordered.reduce((sum, item) => sum + item.matchScore, 0) / reordered.length,
          )} 分`,
      );
    }

    return reordered;
  }

  /** 对单套房源打分 */
  private scoreOne(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    weights: MatchingScoringWeights,
    context: ScoringContext,
  ): ScoredProperty {
    const breakdown: ScoreDimension[] = [];
    const highlights: string[] = [];
    const cautions: string[] = [];

    // ---- 预算 ----
    const budget = this.scoreBudget(property, profile, weights.budget);
    breakdown.push(budget.dimension);
    if (budget.highlight) highlights.push(budget.highlight);
    if (budget.caution) cautions.push(budget.caution);

    // ---- 区域 ----
    const district = this.scoreDistrict(property, profile, weights.district);
    breakdown.push(district.dimension);
    if (district.highlight) highlights.push(district.highlight);

    // ---- 户型 ----
    const bedrooms = this.scoreBedrooms(property, profile, weights.bedrooms);
    breakdown.push(bedrooms.dimension);
    if (bedrooms.highlight) highlights.push(bedrooms.highlight);

    // ---- 面积 ----
    const area = this.scoreArea(property, profile, weights.area);
    breakdown.push(area.dimension);
    if (area.highlight) highlights.push(area.highlight);

    // ---- 房龄 ----
    const age = this.scoreBuildingAge(property, profile, weights.buildingAge);
    breakdown.push(age.dimension);
    if (age.highlight) highlights.push(age.highlight);
    if (age.caution) cautions.push(age.caution);

    // ---- 交通 ----
    const subway = this.scoreSubway(property, profile, weights.subway);
    breakdown.push(subway.dimension);
    if (subway.highlight) highlights.push(subway.highlight);
    if (subway.caution) cautions.push(subway.caution);

    // ---- 小区 ----
    const community = this.scoreCommunity(property, profile, weights.community);
    breakdown.push(community.dimension);
    if (community.highlight) highlights.push(community.highlight);

    // ---- 装修 ----
    const decoration = this.scoreDecoration(property, profile, weights.decoration);
    breakdown.push(decoration.dimension);
    if (decoration.highlight) highlights.push(decoration.highlight);

    // ---- 历史偏好 ----
    const history = this.scoreHistory(property, profile, weights.history, context);
    breakdown.push(history.dimension);
    if (history.highlight) highlights.push(history.highlight);
    if (history.caution) cautions.push(history.caution);

    // ---- 合计 ----
    const totalScore = breakdown.reduce((sum, item) => sum + item.score, 0);
    const maxScore = breakdown.reduce((sum, item) => sum + item.maxScore, 0);

    // 归一化到 0～100（权重配置可能不等于 100）
    const matchScore = maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0;

    // ---- 推荐去重信息 ----
    const previousPrice = context.previouslyRecommended?.get(property.externalId);
    const previouslyRecommended = previousPrice !== undefined;
    const priceChange = previouslyRecommended ? property.totalPrice - (previousPrice ?? 0) : 0;
    // 降价重新进入推荐（需求 §37）—— 这是再次触达客户的天然理由
    const priceDropReentry = previouslyRecommended && priceChange < 0;

    if (priceDropReentry) {
      highlights.push(`业主降价 ${this.formatWan(Math.abs(priceChange))}`);
    }

    // ---- 汇总（去重）----
    //
    // 推荐理由与注意事项由多个打分维度分别追加，**存在重复的可能**：
    // 例如"预算"维度说"距地铁约 480 米"、"交通"维度也说一次；
    // 或者同一句注意事项被两个维度命中。
    //
    // 重复不仅让卡片显得啰嗦，还会在前端引发 React 重复 key 警告
    // （实测踩过：标签里出现两个「月」导致 key 冲突）。
    // 因此在数据源头去重，前端再按内容+序号兜底。
    const uniqueHighlights = [...new Set(highlights)];
    const uniqueCautions = [...new Set(cautions)];

    return {
      property,
      matchScore,
      breakdown,
      highlights: uniqueHighlights,
      cautions: uniqueCautions,
      previouslyRecommended,
      priceDropReentry,
      priceChange,
    };
  }

  // =========================================================================
  // 各维度打分
  // =========================================================================

  /**
   * 预算打分（满分 25）。
   *
   * 这是权重最高的维度，也是最需要产品判断的一个。
   * 曲线设计：低于理想预算 → 满分附近（客户省钱）；
   *          理想 ~ 常规上限 → 缓降；
   *          常规 ~ 极限上限 → 明显扣分；
   *          超过极限上限 → 0 分（正常情况下已被硬过滤拦掉）。
   */
  private scoreBudget(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null; caution: string | null } {
    const price = property.totalPrice;

    const target = profile.budgetTarget;
    const normalMax = profile.budgetNormalMax ?? profile.budgetStretchMax;
    const stretchMax = profile.budgetStretchMax;

    // 完全没有预算信息 → 给中等分，不奖不罚
    if (target === null && normalMax === null && stretchMax === null) {
      return {
        dimension: {
          key: 'budget',
          label: SCORE_DIMENSION_LABELS.budget,
          score: maxScore * 0.6,
          maxScore,
          detail: '客户未提供预算，无法评估价格匹配度',
        },
        highlight: null,
        caution: null,
      };
    }

    // 参考点：理想预算优先。没有理想预算时才退回常规上限/极限上限。
    const reference = target ?? normalMax ?? stretchMax ?? price;
    let ratio: number;

    // 计算某一档内的线性下降比例
    const ratioInBand = (current: number, bandStart: number, bandEnd: number, top: number, bottom: number): number => {
      const span = Math.max(1, bandEnd - bandStart);
      const position = Math.min(1, Math.max(0, (current - bandStart) / span));
      return top - position * (top - bottom);
    };

    if (price <= reference) {
      // 达到或低于理想预算 → 满分。
      // 注意：低于理想预算同样是满分（不是加分项）——
      // 便宜当然好，但房子便宜往往意味着有短板，额外加分会让打分失真。
      ratio = 1;
    } else if (normalMax !== null && price <= normalMax) {
      // 理想预算 ~ 常规上限：1.0 → 0.82
      // 这一段是客户"能接受但不算理想"的区间，扣分要温和
      ratio = ratioInBand(price, reference, normalMax, 1, 0.82);
    } else if (stretchMax !== null && price <= stretchMax) {
      // 常规上限 ~ 极限上限：0.82 → 0.55
      // 这一段需要明确提示"接近或超出客户上限"
      const base = normalMax ?? reference;
      ratio = ratioInBand(price, base, stretchMax, 0.82, 0.55);
    } else if (stretchMax !== null) {
      // 超过极限上限 → 快速降到 0（正常情况下已被硬过滤拦掉）
      const excess = (price - stretchMax) / Math.max(1, stretchMax);
      ratio = Math.max(0, 0.55 - excess * 5);
    } else {
      // 没有上限信息但超了理想预算 → 按超出比例温和扣分
      const excess = (price - reference) / Math.max(1, reference);
      ratio = Math.max(0.3, 1 - excess * 2.2);
    }

    const score = Math.round(ratio * maxScore * 10) / 10;

    // 生成可读说明 —— 这是经纪人向客户解释的依据。
    // 判定阈值必须与上面的打分曲线一致，否则会出现"文案说超出预算、打分却是满分"的矛盾。
    let detail: string;
    let highlight: string | null = null;
    let caution: string | null = null;

    if (reference !== price && price <= reference) {
      const saving = reference - price;
      detail = `总价 ${this.formatWan(price)}，比理想预算低 ${this.formatWan(saving)}`;
      highlight = `总价 ${this.formatWan(price)} 在理想预算内`;
    } else if (price <= reference) {
      detail = `总价 ${this.formatWan(price)}，正好符合理想预算`;
      highlight = `总价 ${this.formatWan(price)} 符合理想预算`;
    } else if (normalMax !== null && price <= normalMax) {
      const over = price - reference;
      detail = `总价 ${this.formatWan(price)}，比理想预算高 ${this.formatWan(over)}，仍在可接受范围内`;
      highlight = `总价 ${this.formatWan(price)} 在可接受范围内`;
    } else if (stretchMax !== null && price <= stretchMax) {
      const over = price - reference;
      detail = `总价 ${this.formatWan(price)}，比理想预算高 ${this.formatWan(over)}，接近客户上限`;
      caution = `总价 ${this.formatWan(price)} 已接近客户上限，需说明议价空间`;
    } else {
      const over = price - reference;
      detail = `总价 ${this.formatWan(price)}，比理想预算高 ${this.formatWan(over)}`;
      caution = `总价 ${this.formatWan(price)} 超出预算，推荐前需谨慎`;
    }

    return {
      dimension: { key: 'budget', label: SCORE_DIMENSION_LABELS.budget, score, maxScore, detail },
      highlight,
      caution,
    };
  }

  /** 区域打分（满分 15） */
  private scoreDistrict(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null } {
    const subDistricts = profile.subDistricts;
    const districts = profile.districts;

    if (subDistricts.length === 0 && districts.length === 0) {
      return {
        dimension: {
          key: 'district',
          label: SCORE_DIMENSION_LABELS.district,
          score: maxScore * 0.6,
          maxScore,
          detail: '客户未指定区域',
        },
        highlight: null,
      };
    }

    const locationText = `${property.district} ${property.subDistrict ?? ''} ${property.community}`;

    // 板块命中 → 最高分（客户最在意的精确位置）
    const subIndex = subDistricts.findIndex((sub) => locationText.includes(sub));
    if (subIndex >= 0) {
      // 越靠前的板块是客户越优先提到的
      const positionBonus = subIndex === 0 ? 1 : 0.92;
      return {
        dimension: {
          key: 'district',
          label: SCORE_DIMENSION_LABELS.district,
          score: Math.round(maxScore * positionBonus * 10) / 10,
          maxScore,
          detail: `位于${subDistricts[subIndex]}板块，符合客户明确要求`,
        },
        highlight: `位于${subDistricts[subIndex]}板块`,
      };
    }

    // 行政区命中 → 较高分（范围对，但不够精确）
    const districtMatch = districts.find((district) => {
      const normalized = district.replace(/[区县]$/, '');
      return locationText.includes(normalized) || locationText.includes(district);
    });

    if (districtMatch) {
      return {
        dimension: {
          key: 'district',
          label: SCORE_DIMENSION_LABELS.district,
          score: Math.round(maxScore * 0.78 * 10) / 10,
          maxScore,
          detail: `位于${districtMatch}，在客户要求的行政区内，但不在最优先板块`,
        },
        highlight: `位于${property.district}`,
      };
    }

    // 都不命中（硬过滤正常会拦掉，走到这里说明区域条件来自推断）
    return {
      dimension: {
        key: 'district',
        label: SCORE_DIMENSION_LABELS.district,
        score: Math.round(maxScore * 0.3 * 10) / 10,
        maxScore,
        detail: `位置 ${property.district} 不在客户指定范围内`,
      },
      highlight: null,
    };
  }

  /** 户型打分（满分 15） */
  private scoreBedrooms(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null } {
    if (profile.bedrooms.length === 0) {
      return {
        dimension: {
          key: 'bedrooms',
          label: SCORE_DIMENSION_LABELS.bedrooms,
          score: maxScore * 0.6,
          maxScore,
          detail: '客户未指定户型',
        },
        highlight: null,
      };
    }

    const index = profile.bedrooms.indexOf(property.bedrooms);
    if (index === 0) {
      return {
        dimension: {
          key: 'bedrooms',
          label: SCORE_DIMENSION_LABELS.bedrooms,
          score: maxScore,
          maxScore,
          detail: `${property.bedrooms} 房正好符合客户需求`,
        },
        highlight: `${property.bedrooms} 房符合需求`,
      };
    }
    if (index > 0) {
      return {
        dimension: {
          key: 'bedrooms',
          label: SCORE_DIMENSION_LABELS.bedrooms,
          score: Math.round(maxScore * 0.85 * 10) / 10,
          maxScore,
          detail: `${property.bedrooms} 房在客户可接受范围内`,
        },
        highlight: `${property.bedrooms} 房可接受`,
      };
    }

    // 不在列表里（硬过滤应已拦掉）
    return {
      dimension: {
        key: 'bedrooms',
        label: SCORE_DIMENSION_LABELS.bedrooms,
        score: Math.round(maxScore * 0.3 * 10) / 10,
        maxScore,
        detail: `${property.bedrooms} 房不在客户要求的户型范围内`,
      },
      highlight: null,
    };
  }

  /** 面积打分（满分 10） */
  private scoreArea(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null } {
    const { areaMin, areaMax } = profile;

    if (areaMin === null && areaMax === null) {
      return {
        dimension: {
          key: 'area',
          label: SCORE_DIMENSION_LABELS.area,
          score: maxScore * 0.6,
          maxScore,
          detail: '客户未指定面积',
        },
        highlight: null,
      };
    }

    const area = property.area;

    // 在区间内 → 满分（越靠近中间越高一点）
    if ((areaMin === null || area >= areaMin) && (areaMax === null || area <= areaMax)) {
      return {
        dimension: {
          key: 'area',
          label: SCORE_DIMENSION_LABELS.area,
          score: maxScore,
          maxScore,
          detail: `建筑面积 ${area}㎡，完全符合需求`,
        },
        highlight: `${area}㎡`,
      };
    }

    // 超出边界 → 按超出比例扣分
    let deviation = 0;
    if (areaMax !== null && area > areaMax) deviation = (area - areaMax) / areaMax;
    else if (areaMin !== null && area < areaMin) deviation = (areaMin - area) / areaMin;

    const ratio = Math.max(0.4, 1 - deviation * 3);
    return {
      dimension: {
        key: 'area',
        label: SCORE_DIMENSION_LABELS.area,
        score: Math.round(ratio * maxScore * 10) / 10,
        maxScore,
        detail: `建筑面积 ${area}㎡，${area > (areaMax ?? 0) ? '略大于' : '略小于'}客户期望`,
      },
      highlight: null,
    };
  }

  /** 房龄打分（满分 10） */
  private scoreBuildingAge(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null; caution: string | null } {
    const buildYear = property.buildYear;

    if (buildYear === null) {
      return {
        dimension: {
          key: 'buildingAge',
          label: SCORE_DIMENSION_LABELS.buildingAge,
          score: maxScore * 0.5,
          maxScore,
          detail: '建成年份未知',
        },
        highlight: null,
        caution: '建成年份未知，建议向业主确认',
      };
    }

    const age = new Date().getFullYear() - buildYear;

    // 客户没有房龄偏好 → 给中性偏上的分（新房略加分）
    if (!profile.buildingAgePreference || profile.buildingAgePreference === BuildingAgePreference.ANY) {
      if (!profile.avoidOldCommunity) {
        const ratio = age <= 10 ? 0.9 : age <= 20 ? 0.75 : 0.6;
        return {
          dimension: {
            key: 'buildingAge',
            label: SCORE_DIMENSION_LABELS.buildingAge,
            score: Math.round(ratio * maxScore * 10) / 10,
            maxScore,
            detail: `${buildYear} 年建成（${age} 年房龄）`,
          },
          highlight: age <= 10 ? `${buildYear} 年建成，房龄较新` : null,
          caution: null,
        };
      }
    }

    // 客户明确偏好较新
    switch (profile.buildingAgePreference) {
      case BuildingAgePreference.WITHIN_5: {
        const ratio = age <= 5 ? 1 : Math.max(0.3, 1 - (age - 5) * 0.14);
        return {
          dimension: {
            key: 'buildingAge',
            label: SCORE_DIMENSION_LABELS.buildingAge,
            score: Math.round(ratio * maxScore * 10) / 10,
            maxScore,
            detail:
              age <= 5
                ? `${buildYear} 年建成，符合"5 年内"要求`
                : `${buildYear} 年建成（${age} 年房龄），超出 5 年要求`,
          },
          highlight: age <= 5 ? `${age} 年房龄，非常新` : null,
          caution: age > 10 ? `${age} 年房龄，与客户要求有差距` : null,
        };
      }

      case BuildingAgePreference.WITHIN_10: {
        const ratio = age <= 10 ? 1 : Math.max(0.35, 1 - (age - 10) * 0.08);
        return {
          dimension: {
            key: 'buildingAge',
            label: SCORE_DIMENSION_LABELS.buildingAge,
            score: Math.round(ratio * maxScore * 10) / 10,
            maxScore,
            detail:
              age <= 10 ? `${buildYear} 年建成，符合"10 年内"要求` : `${buildYear} 年建成（${age} 年房龄）`,
          },
          highlight: age <= 10 ? `${age} 年房龄` : null,
          caution: age > 15 ? `${age} 年房龄较老` : null,
        };
      }

      case BuildingAgePreference.WITHIN_20: {
        const ratio = age <= 20 ? 1 : Math.max(0.4, 1 - (age - 20) * 0.05);
        return {
          dimension: {
            key: 'buildingAge',
            label: SCORE_DIMENSION_LABELS.buildingAge,
            score: Math.round(ratio * maxScore * 10) / 10,
            maxScore,
            detail: `${buildYear} 年建成（${age} 年房龄）`,
          },
          highlight: null,
          caution: null,
        };
      }

      case BuildingAgePreference.NEWER:
      default: {
        // "新一点"是模糊要求 → 分段给分，避免过严
        const ratio = age <= 5 ? 1 : age <= 10 ? 0.92 : age <= 15 ? 0.78 : age <= 25 ? 0.55 : 0.35;
        return {
          dimension: {
            key: 'buildingAge',
            label: SCORE_DIMENSION_LABELS.buildingAge,
            score: Math.round(ratio * maxScore * 10) / 10,
            maxScore,
            detail: `${buildYear} 年建成（${age} 年房龄）${age <= 10 ? '，较新' : ''}`,
          },
          highlight: age <= 10 ? `${buildYear} 年建成，房龄较新` : null,
          caution: age > 25 ? `${age} 年房龄偏老，客户表示过不想要老小区` : null,
        };
      }
    }
  }

  /** 地铁打分（满分 10） */
  private scoreSubway(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null; caution: string | null } {
    const distance = property.subwayDistance;
    const priority = profile.subwayPriority;
    const maxAcceptable = profile.subwayDistanceMax;

    if (distance === null) {
      const ratio = priority === PreferencePriority.HIGH ? 0.35 : 0.55;
      return {
        dimension: {
          key: 'subway',
          label: SCORE_DIMENSION_LABELS.subway,
          score: Math.round(ratio * maxScore * 10) / 10,
          maxScore,
          detail: '地铁距离信息未获取到',
        },
        highlight: null,
        caution: priority === PreferencePriority.HIGH ? '客户重视地铁，但该房源地铁距离未知' : null,
      };
    }

    // 客户给了明确的可接受距离 → 超出就扣分
    if (maxAcceptable !== null) {
      if (distance <= maxAcceptable) {
        return {
          dimension: {
            key: 'subway',
            label: SCORE_DIMENSION_LABELS.subway,
            score: maxScore,
            maxScore,
            detail: `距地铁约 ${distance} 米，在客户可接受范围内`,
          },
          highlight: `距地铁约 ${distance} 米`,
          caution: null,
        };
      }

      const excess = (distance - maxAcceptable) / maxAcceptable;
      const ratio = Math.max(0.2, 1 - excess * 1.5);
      return {
        dimension: {
          key: 'subway',
          label: SCORE_DIMENSION_LABELS.subway,
          score: Math.round(ratio * maxScore * 10) / 10,
          maxScore,
          detail: `距地铁约 ${distance} 米，超出客户期望的 ${maxAcceptable} 米`,
        },
        highlight: null,
        caution: `距地铁 ${distance} 米，超出客户要求`,
      };
    }

    // 没有明确距离要求 → 按绝对距离分段
    let ratio: number;
    if (distance <= 300) ratio = 1;
    else if (distance <= 500) ratio = 0.95;
    else if (distance <= 800) ratio = 0.85;
    else if (distance <= 1200) ratio = 0.7;
    else if (distance <= 2000) ratio = 0.5;
    else ratio = 0.3;

    // 客户重视地铁时，差距放大
    if (priority === PreferencePriority.HIGH && distance > 800) {
      ratio = Math.max(0.25, ratio - 0.15);
    }

    return {
      dimension: {
        key: 'subway',
        label: SCORE_DIMENSION_LABELS.subway,
        score: Math.round(ratio * maxScore * 10) / 10,
        maxScore,
        detail: `距地铁约 ${distance} 米${distance <= 800 ? '，步行可达' : ''}`,
      },
      highlight: distance <= 800 ? `距地铁约 ${distance} 米` : null,
      caution:
        priority === PreferencePriority.HIGH && distance > 1000
          ? `客户重视地铁，但距离 ${distance} 米较远`
          : null,
    };
  }

  /** 小区打分（满分 5） */
  private scoreCommunity(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null; caution: string | null } {
    const priority = profile.communityQualityPriority;

    // 用可获得的信号评估小区品质：
    // 小区名在客户关注列表里、有学区信息（通常配套较好）、楼龄较新
    let ratio = 0.7;
    const reasons: string[] = [];

    if (profile.communities.includes(property.community)) {
      ratio = 1;
      reasons.push('客户明确提到过该小区');
    } else {
      // 学区信息是小区配套的间接信号（对口学校的房源通常小区成熟度较高）
      if (property.schoolInfo?.primarySchool) {
        ratio += 0.15;
        reasons.push('对口学校信息完整');
      }
      // 楼龄反映小区新旧
      if (property.buildYear !== null) {
        const age = new Date().getFullYear() - property.buildYear;
        if (age <= 10) {
          ratio += 0.1;
          reasons.push(`${age} 年房龄，小区较新`);
        } else if (age >= 30) {
          ratio -= 0.25;
          reasons.push(`${age} 年房龄，小区偏老`);
        }
      }
      // 房源标签里的品质信号
      const qualityTags = property.tags.filter((tag) =>
        /封闭|门禁|人车分流|绿化|品质|改善/.test(tag),
      );
      if (qualityTags.length > 0) {
        ratio += 0.05;
      }
    }

    ratio = Math.min(1, Math.max(0.25, ratio));

    // 客户很在意小区环境时，差距被放大
    if (priority === PreferencePriority.HIGH && ratio < 0.8) {
      ratio = ratio * 0.85;
    }

    return {
      dimension: {
        key: 'community',
        label: SCORE_DIMENSION_LABELS.community,
        score: Math.round(ratio * maxScore * 10) / 10,
        maxScore,
        detail:
          reasons.length > 0
            ? reasons.join('；')
            : `${property.community}，小区信息有限，建议实地了解`,
      },
      highlight:
        profile.communities.includes(property.community)
          ? '客户关注的小区'
          : property.schoolInfo?.primarySchool
            ? '配套信息完整'
            : null,
      caution:
        profile.communityQualityPriority === PreferencePriority.HIGH && ratio < 0.75
          ? '客户很在意小区环境，但该小区可获取的品质信息有限，建议实地了解'
          : null,
    };
  }

  /** 装修打分（满分 5） */
  private scoreDecoration(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
  ): { dimension: ScoreDimension; highlight: string | null; caution: string | null } {
    const required = profile.decorationPreference;

    // 客户没有装修要求（含"装修无所谓"）→ 精装略加分，其余中性
    if (!required || required === DecorationPreferenceLevel.ANY || property.decoration === null) {
      const ratio = property.decoration === Decoration.FINE ? 0.9 : 0.7;
      return {
        dimension: {
          key: 'decoration',
          label: SCORE_DIMENSION_LABELS.decoration,
          score: Math.round(ratio * maxScore * 10) / 10,
          maxScore,
          detail: property.decoration
            ? `装修情况：${this.describeDecoration(property.decoration)}`
            : '装修情况未知',
        },
        highlight: property.decoration === Decoration.FINE ? '精装修' : null,
        caution: property.decoration === null ? '装修情况未知，建议实地确认' : null,
      };
    }

    // 用映射表比较（两套枚举不同，不能直接比大小）
    const requiredLevel = DECORATION_LEVEL[required];
    const actualLevel = decorationToLevel(property.decoration);
    const gap = requiredLevel - actualLevel;

    let ratio: number;
    if (gap <= 0) ratio = 1; // 达到或超出要求
    else if (gap === 1) ratio = 0.6; // 差一档
    else ratio = 0.3;

    // 客户明确"必须精装"时更严格
    if (profile.requireFineDecoration && gap > 0) {
      ratio = Math.min(ratio, 0.45);
    }

    const meets = gap <= 0;
    const requiredDecoration = preferenceToDecoration(required);

    return {
      dimension: {
        key: 'decoration',
        label: SCORE_DIMENSION_LABELS.decoration,
        score: Math.round(ratio * maxScore * 10) / 10,
        maxScore,
        detail: meets
          ? `装修为${this.describeDecoration(property.decoration)}，符合客户要求`
          : `装修为${this.describeDecoration(property.decoration)}，低于客户期望的${this.describeDecoration(required)}`,
      },
      highlight: meets ? this.describeDecoration(property.decoration) : null,
      caution:
        !meets && profile.requireFineDecoration
          ? `客户要求必须精装，但该房源为${this.describeDecoration(property.decoration)}`
          : !meets && requiredDecoration === Decoration.LUXURY
            ? '装修档次低于客户期望'
            : null,
    };
  }

  /**
   * 历史偏好打分（满分 5）。
   *
   * 依据客户此前的真实行为：浏览过什么、收藏过什么、忽略过什么。
   * 权重刻意压低（5 分），因为历史行为可能已经过时 ——
   * 客户上个月看的房子不代表他现在还想要那种。
   */
  private scoreHistory(
    property: NormalizedProperty,
    profile: MergedRequirementProfile,
    maxScore: number,
    context: ScoringContext,
  ): { dimension: ScoreDimension; highlight: string | null; caution: string | null } {
    const reasons: string[] = [];
    let ratio = 0.6; // 默认中性

    // 客户浏览过的小区 → 说明接受这类位置
    if (context.viewedCommunities?.includes(property.community)) {
      ratio += 0.25;
      reasons.push('客户浏览过该小区');
    }

    // 历史偏好的装修类型
    if (
      property.decoration &&
      context.preferredDecorations?.includes(property.decoration)
    ) {
      ratio += 0.15;
      reasons.push('装修类型符合客户历史偏好');
    }

    // 客户拒绝过的特征 → 降权（这是需求 §37 的"避免重复推荐"逻辑）
    if (context.rejectedFeatures && context.rejectedFeatures.length > 0) {
      const matchedRejection = context.rejectedFeatures.find((feature) => {
        const text = `${property.tags.join(' ')} ${property.community} ${property.description ?? ''}`;
        return text.includes(feature);
      });

      if (matchedRejection) {
        ratio -= 0.35;
        reasons.push(`包含客户曾拒绝的特征（${matchedRejection}）`);
      }
    }

    ratio = Math.min(1, Math.max(0.1, ratio));

    const caution =
      context.rejectedFeatures &&
      context.rejectedFeatures.length > 0 &&
      ratio < 0.4
        ? '该房源特征与客户之前拒绝过的房源相似'
        : null;

    return {
      dimension: {
        key: 'history',
        label: SCORE_DIMENSION_LABELS.history,
        score: Math.round(ratio * maxScore * 10) / 10,
        maxScore,
        detail: reasons.length > 0 ? reasons.join('；') : '暂无客户历史行为数据',
      },
      highlight: reasons.length > 0 && ratio > 0.75 ? reasons[0] ?? null : null,
      caution,
    };
  }

  // =========================================================================
  // 去重
  // =========================================================================

  /**
   * 推荐去重（需求 §37）。
   *
   * 规则：
   *   - 已推荐过且**价格下降** → 保持原排名甚至提前（降价是再次触达的天然理由）
   *   - 已推荐过且**无变化** → 降到最后（不要重复推同一套房，客户会觉得系统没用）
   *   - 从未推荐过 → 保持原排名
   */
  private applyDeduplication(scored: ScoredProperty[]): ScoredProperty[] {
    const fresh: ScoredProperty[] = [];
    const priceDropped: ScoredProperty[] = [];
    const repeated: ScoredProperty[] = [];

    for (const item of scored) {
      if (!item.previouslyRecommended) {
        fresh.push(item);
      } else if (item.priceDropReentry) {
        priceDropped.push(item);
      } else {
        repeated.push(item);
      }
    }

    // 顺序：新面孔 → 降价的 → 重复的
    // 降价的排在重复的前面，因为降价提供了新的沟通理由
    return [...fresh, ...priceDropped, ...repeated];
  }

  /** 计算房源价格与客户理想预算的距离（用于同分排序） */
  private budgetDistance(price: number, profile: MergedRequirementProfile): number {
    const reference = profile.budgetTarget ?? profile.budgetNormalMax ?? price;
    return Math.abs(price - reference);
  }

  /** 装修描述 */
  private describeDecoration(decoration: string): string {
    switch (decoration) {
      case DecorationPreferenceLevel.LUXURY:
        return '豪装';
      case DecorationPreferenceLevel.FINE:
        return '精装';
      case DecorationPreferenceLevel.SIMPLE:
        return '简装';
      case DecorationPreferenceLevel.ROUGH:
        return '毛坯';
      default:
        return String(decoration);
    }
  }

  /** 万元格式化 */
  private formatWan(amount: number): string {
    const wan = Math.abs(amount) / 10_000;
    return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
  }
}
