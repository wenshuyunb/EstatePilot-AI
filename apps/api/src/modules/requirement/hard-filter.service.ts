/**
 * 硬性条件过滤服务。
 *
 * 这是**确定性代码**，AI 无权干预（需求 §18、§41）。
 *
 * 为什么这一层必须由代码负责：
 *   客户说"最多 520 万，超过不看"，如果让 AI 判断"这套 620 万但很好，要不要推荐"，
 *   模型很可能给出肯定答案 —— 它是语言模型，不是规则引擎。
 *   而推荐一套客户明确拒绝的房子，会直接摧毁客户对经纪人的信任。
 *
 *   因此：**AI 只能从候选里排顺序，不能决定谁能进入候选。**
 *
 * 同时要避免另一个极端：过滤过严会让客户看不到本该看到的好房源。
 * 所以每一类硬条件都经过权衡：
 *   - 严格预算上限 → 严格执行（客户明确说的）
 *   - 户型         → 严格执行（这是明确需求）
 *   - 区域         → 严格执行（但支持板块与行政区的包含匹配）
 *   - 房龄         → 只在客户明确给出年份时执行
 *   - 面积         → 弹性 ±8%（客户对面积的口头表达通常不精确）
 *   - 楼层/电梯    → 严格执行（客户明确排除的必须排除）
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ListingStatus,
  type NormalizedProperty,
  type PropertySearchQuery,
} from '@estatepilot/types';

/** 单套房源的过滤结果 */
export interface FilterOutcome {
  property: NormalizedProperty;
  passed: boolean;
  /** 被拒绝的原因（passed=false 时有值） */
  rejectedReason: string | null;
  /** 通过但需要注意的点（如价格接近上限） */
  cautions: string[];
}

/** 整体过滤结果 */
export interface HardFilterResult {
  /** 通过的房源 */
  passed: NormalizedProperty[];
  /** 被拒绝的房源及其原因（用于调试与"为什么没推荐这套"的解释） */
  rejected: Array<{ property: NormalizedProperty; reason: string }>;
  /** 通过房源的注意事项映射 */
  cautions: Map<string, string[]>;
  /** 各拒绝原因的数量统计 */
  rejectionStats: Record<string, number>;
}

@Injectable()
export class HardFilterService {
  private readonly logger = new Logger(HardFilterService.name);

  /**
   * 执行硬性过滤。
   *
   * @param properties 候选房源
   * @param query 搜索条件
   */
  filter(properties: NormalizedProperty[], query: PropertySearchQuery): HardFilterResult {
    const passed: NormalizedProperty[] = [];
    const rejected: Array<{ property: NormalizedProperty; reason: string }> = [];
    const cautions = new Map<string, string[]>();
    const rejectionStats: Record<string, number> = {};

    for (const property of properties) {
      const outcome = this.evaluate(property, query);

      if (outcome.passed) {
        passed.push(property);
        if (outcome.cautions.length > 0) {
          cautions.set(property.externalId, outcome.cautions);
        }
      } else {
        const reason = outcome.rejectedReason ?? '未知原因';
        rejected.push({ property, reason });
        // 统计时用简化的原因分类
        const key = this.classifyRejection(reason);
        rejectionStats[key] = (rejectionStats[key] ?? 0) + 1;
      }
    }

    this.logger.log(
      `硬性过滤完成：${properties.length} 套候选 → 通过 ${passed.length} 套，` +
        `拒绝 ${rejected.length} 套` +
        (Object.keys(rejectionStats).length > 0
          ? `（${Object.entries(rejectionStats)
              .map(([key, count]) => `${key} ${count}`)
              .join('，')}）`
          : ''),
    );

    return { passed, rejected, cautions, rejectionStats };
  }

  /** 评估单套房源 */
  evaluate(property: NormalizedProperty, query: PropertySearchQuery): FilterOutcome {
    const cautions: string[] = [];

    // =====================================================================
    // 1. 必须可售 —— 这是第一道也是最重要的一道
    // =====================================================================
    // 贝壳的搜索结果里会包含已成交/已过户的房源（用于成交参考）。
    // 把已经卖掉的房子推荐给客户是最严重的错误之一。
    if (query.onlyActive && property.listingStatus !== ListingStatus.ACTIVE) {
      return {
        property,
        passed: false,
        rejectedReason: `房源状态为「${this.describeStatus(property.listingStatus)}」，非在售`,
        cautions,
      };
    }

    // 关键字段缺失 → 无法判断，保守拒绝（避免推给客户后才发现信息不全）
    if (property.totalPrice <= 0) {
      return { property, passed: false, rejectedReason: '缺少价格信息', cautions };
    }
    if (property.area <= 0) {
      return { property, passed: false, rejectedReason: '缺少面积信息', cautions };
    }

    // =====================================================================
    // 2. 预算上限（最严格的硬条件）
    // =====================================================================
    if (query.budgetMax !== null && property.totalPrice > query.budgetMax) {
      return {
        property,
        passed: false,
        rejectedReason:
          `总价 ${this.formatWan(property.totalPrice)} 超出上限 ` +
          `${this.formatWan(query.budgetMax)}`,
        cautions,
      };
    }

    if (query.budgetMin !== null && property.totalPrice < query.budgetMin) {
      return {
        property,
        passed: false,
        rejectedReason:
          `总价 ${this.formatWan(property.totalPrice)} 低于下限 ` +
          `${this.formatWan(query.budgetMin)}`,
        cautions,
      };
    }

    // =====================================================================
    // 3. 户型（明确需求，严格执行）
    // =====================================================================
    if (query.bedrooms.length > 0 && !query.bedrooms.includes(property.bedrooms)) {
      return {
        property,
        passed: false,
        rejectedReason: `户型 ${property.bedrooms} 房不符合要求（需要 ${query.bedrooms.join(' 或 ')} 房）`,
        cautions,
      };
    }

    // =====================================================================
    // 4. 区域
    // =====================================================================
    // 匹配规则：板块优先，其次行政区。用包含匹配是因为
    // 贝壳返回的是「浦东」「张江」这类简称，而客户可能说「浦东新区」。
    if (query.subDistricts.length > 0 || query.districts.length > 0) {
      const locationText = `${property.district} ${property.subDistrict ?? ''} ${property.community}`;

      const locationMatched =
        query.subDistricts.some((sub) => locationText.includes(sub)) ||
        query.districts.some((district) => {
          const normalized = district.replace(/[区县]$/, '');
          return locationText.includes(normalized) || locationText.includes(district);
        });

      // 注意：**只有当客户明确指定了区域时才过滤**。
      // 如果区域来自行为画像推断，则不过滤（推断信息不够可靠，不能用来排除房源）。
      if (!locationMatched) {
        return {
          property,
          passed: false,
          rejectedReason:
            `位置「${property.district}${property.subDistrict ? ` ${property.subDistrict}` : ''}」` +
            `不在需求范围内（${[...query.subDistricts, ...query.districts].join('、')}）`,
          cautions,
        };
      }
    }

    // =====================================================================
    // 5. 面积（弹性 ±8% —— 客户口头表达通常不精确）
    // =====================================================================
    const AREA_TOLERANCE = 0.08;

    if (query.areaMin !== null && property.area < query.areaMin * (1 - AREA_TOLERANCE)) {
      return {
        property,
        passed: false,
        rejectedReason: `面积 ${property.area}㎡ 小于需求下限 ${query.areaMin}㎡`,
        cautions,
      };
    }

    if (query.areaMax !== null && property.area > query.areaMax * (1 + AREA_TOLERANCE)) {
      return {
        property,
        passed: false,
        rejectedReason: `面积 ${property.area}㎡ 超出需求上限 ${query.areaMax}㎡`,
        cautions,
      };
    }

    // =====================================================================
    // 6. 建成年份（只在客户明确给出年份时执行）
    // =====================================================================
    if (query.builtAfterYear !== null && property.buildYear !== null) {
      // 给 1 年弹性：客户说"2015 年以后"，2014 年建成的房子其实差别不大
      if (property.buildYear < query.builtAfterYear - 1) {
        return {
          property,
          passed: false,
          rejectedReason: `建成年份 ${property.buildYear} 早于要求的 ${query.builtAfterYear} 年`,
          cautions,
        };
      }
    }

    // =====================================================================
    // 7. 电梯（客户明确要求时必须严格执行）
    // =====================================================================
    if (query.requireElevator && property.elevator === false) {
      return {
        property,
        passed: false,
        rejectedReason: '客户要求有电梯，但该房源无电梯',
        cautions,
      };
    }

    // 电梯信息缺失时不拒绝，但给出提示
    if (query.requireElevator && property.elevator === null) {
      cautions.push('电梯信息未获取到，需向业主确认');
    }

    // =====================================================================
    // 8. 楼层排除（客户明确说"不要一楼/顶楼"）
    // =====================================================================
    if (query.avoidFirstFloor && property.floor !== null && property.floor <= 1) {
      return {
        property,
        passed: false,
        rejectedReason: '客户明确不要一楼',
        cautions,
      };
    }

    if (
      query.avoidTopFloor &&
      property.floor !== null &&
      property.totalFloors !== null &&
      property.floor >= property.totalFloors
    ) {
      return {
        property,
        passed: false,
        rejectedReason: '客户明确不要顶楼',
        cautions,
      };
    }

    // =====================================================================
    // 9. 通过但需要提示的情况
    // =====================================================================
    if (query.budgetMax !== null) {
      const ratio = property.totalPrice / query.budgetMax;
      if (ratio > 0.95) {
        cautions.push(`总价 ${this.formatWan(property.totalPrice)} 已接近预算上限`);
      }
    }

    if (property.subwayDistance === null) {
      // 客户明确在意地铁时，缺少距离信息是个明显短板，需要提示经纪人核实
      cautions.push('地铁距离信息未获取到，推荐前建议确认');
    }

    if (property.buildYear === null) {
      cautions.push('建成年份未获取到');
    }

    if (property.images.length === 0) {
      cautions.push('暂无房源图片');
    }

    return { property, passed: true, rejectedReason: null, cautions };
  }

  /**
   * 分析零结果的原因，并给出放宽建议（需求 §44）。
   *
   * 关键原则：**未经经纪人确认，绝不自动放宽客户的硬条件。**
   * 这里只做分析并给出方案，由经纪人决定是否采纳。
   */
  analyzeZeroResult(
    allCandidates: Array<{ property: NormalizedProperty; reason: string }>,
    query: PropertySearchQuery,
  ): {
    possibleCauses: string[];
    suggestions: Array<{
      label: string;
      description: string;
      /** 需要放宽的条件键 */
      relaxField: string;
      /** 放宽后的建议值 */
      suggestedValue: string;
    }>;
  } {
    const possibleCauses: string[] = [];
    const suggestions: Array<{
      label: string;
      description: string;
      relaxField: string;
      suggestedValue: string;
    }> = [];

    if (allCandidates.length === 0) {
      possibleCauses.push('贝壳没有返回任何候选房源，可能是区域或条件过于具体');
      suggestions.push({
        label: '扩大区域范围',
        description: '把搜索范围从具体板块扩大到所在行政区',
        relaxField: 'subDistricts',
        suggestedValue: '使用行政区而非板块进行搜索',
      });
      return { possibleCauses, suggestions };
    }

    // 统计各类拒绝原因
    const reasonCounts = new Map<string, number>();
    for (const item of allCandidates) {
      const key = this.classifyRejection(item.reason);
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }

    const sorted = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);

    for (const [reason, count] of sorted) {
      possibleCauses.push(`${count} 套房源因为「${reason}」被排除`);

      switch (reason) {
        case '预算超限': {
          if (query.budgetMax !== null) {
            const raised = Math.round(query.budgetMax * 1.2);
            suggestions.push({
              label: `预算提高到 ${this.formatWan(raised)}`,
              description: `当前上限 ${this.formatWan(query.budgetMax)}，提高 20% 后可能匹配到更多房源`,
              relaxField: 'budgetMax',
              suggestedValue: String(raised),
            });
          }
          break;
        }
        case '户型不符': {
          if (query.bedrooms.length > 0) {
            const alternatives = query.bedrooms
              .flatMap((count) => [count - 1, count + 1])
              .filter((count) => count >= 1 && count <= 6);
            suggestions.push({
              label: `放宽户型到 ${alternatives.join(' 或 ')} 房`,
              description: '户型是最常见的零结果原因，放宽一档通常能立刻找到房源',
              relaxField: 'bedrooms',
              suggestedValue: alternatives.join(','),
            });
          }
          break;
        }
        case '位置不符': {
          suggestions.push({
            label: '扩大区域范围',
            description: '把搜索范围从板块扩大到相邻板块或整个行政区',
            relaxField: 'subDistricts',
            suggestedValue: '清空板块，改用行政区搜索',
          });
          break;
        }
        case '面积不符': {
          if (query.areaMin !== null) {
            suggestions.push({
              label: `面积下限放宽到 ${Math.round(query.areaMin * 0.85)}㎡`,
              description: '客户对面积的口头表达通常有弹性',
              relaxField: 'areaMin',
              suggestedValue: String(Math.round(query.areaMin * 0.85)),
            });
          }
          break;
        }
        case '房龄不符': {
          if (query.builtAfterYear !== null) {
            suggestions.push({
              label: `房龄放宽到 ${query.builtAfterYear - 5} 年`,
              description: '适当放宽建成年份要求',
              relaxField: 'builtAfterYear',
              suggestedValue: String(query.builtAfterYear - 5),
            });
          }
          break;
        }
        case '楼层不符': {
          suggestions.push({
            label: '放宽楼层限制',
            description: '如果客户对楼层的要求不是必须的，可以取消该限制',
            relaxField: 'avoidFirstFloor',
            suggestedValue: 'false',
          });
          break;
        }
        case '非在售': {
          // 这不是需要放宽的条件，而是提示
          break;
        }
        default:
          break;
      }
    }

    return { possibleCauses, suggestions };
  }

  /** 把拒绝原因归类（用于统计与建议） */
  private classifyRejection(reason: string): string {
    if (reason.includes('超出上限') || reason.includes('低于下限')) return '预算超限';
    if (reason.includes('户型')) return '户型不符';
    if (reason.includes('不在需求范围内')) return '位置不符';
    if (reason.includes('面积')) return '面积不符';
    if (reason.includes('建成年份')) return '房龄不符';
    if (reason.includes('一楼') || reason.includes('顶楼')) return '楼层不符';
    if (reason.includes('非在售')) return '非在售';
    if (reason.includes('缺少')) return '信息缺失';
    return '其他';
  }

  /** 状态描述 */
  private describeStatus(status: ListingStatus): string {
    switch (status) {
      case ListingStatus.SOLD:
        return '已成交';
      case ListingStatus.PENDING:
        return '已下定';
      case ListingStatus.DELISTED:
        return '已下架';
      case ListingStatus.SUSPENDED:
        return '暂缓出售';
      default:
        return '在售';
    }
  }

  /** 万元格式化 */
  private formatWan(amount: number): string {
    const wan = amount / 10_000;
    return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
  }
}
