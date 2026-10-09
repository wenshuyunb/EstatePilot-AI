/**
 * 小区名归一化服务 —— 唯一实现。
 *
 * ============================================================================
 * 为什么必须抽成唯一实现
 * ============================================================================
 * 审计发现代码里有**三份不一致**的归一化实现：
 *   - `property-import.service.ts`  去括号 + 去空格 + 小写
 *   - `property-upsert.service.ts`  去空格 + 去括号 + 无效的后缀正则
 *   - `property-sync.service.ts`    去括号 + 去空格 + 小写
 *
 * 危害：
 *   1. 大小写不一致 → `浦东XX花园` 与 `浦东xx花园` 是不同字符串，跨源匹配直接失败
 *   2. 三份实现会各自漂移，改一处忘另两处
 *   3. 都无法处理行政区前缀 → `浦东XX花园` 与 `XX花园` 不相等
 *      （这正是跨源归并最需要的能力）
 *
 * ============================================================================
 * 保守原则（重要）
 * ============================================================================
 * 归一化过于激进会**错误合并不同小区**，例如：
 *   "浦东花园" 与 "浦西花园" 都去掉前缀后变成 "花园" → 错误合并
 *
 * 而错误合并的代价远高于漏合并 —— 把两套不同的房子合成一条，
 * 会让经纪人带客户看错房。这是**不可接受**的错误。
 *
 * 因此本实现遵循：
 *   1. 默认只做「安全的」归一化（去空白/括号/大小写/全半角）
 *   2. 行政区前缀去除**只在同城市同行政区内**生效（由调用方保证）
 *   3. 保留原始名（`community` 字段不变），归一化结果只用于匹配
 */

import { Injectable } from '@nestjs/common';

/** 归一化结果（含辅助信息，便于调试与审计） */
export interface CommunityNormalizationResult {
  /** 归一化后的键（用于匹配/索引） */
  normalized: string;
  /** 是否去除了行政区前缀 */
  strippedDistrictPrefix: boolean;
  /** 去除的内容（便于审计） */
  removedParts: string[];
}

@Injectable()
export class CommunityNormalizerService {
  /**
   * 上海行政区列表 —— 用于去除小区名里的行政区前缀。
   *
   * 为什么硬编码而不是查库：归一化是**高频调用**（每次入库、每次匹配），
   * 查库会成为性能瓶颈。行政区变动频率极低，硬编码可接受。
   */
  private static readonly DISTRICT_PREFIXES: string[] = [
    '浦东新区',
    '浦东',
    '徐汇',
    '静安',
    '黄浦',
    '长宁',
    '普陀',
    '虹口',
    '杨浦',
    '闵行',
    '宝山',
    '嘉定',
    '金山',
    '松江',
    '青浦',
    '奉贤',
    '崇明',
  ];

  /**
   * 通用归一化（不含行政区前缀处理）。
   *
   * 处理步骤：
   *   1. 全角转半角（"Ａ" → "A"）
   *   2. 去除所有空白
   *   3. 去除括号内容（分期信息，如「(四期)」「（南区）」）
   *   4. 转小写
   */
  normalizeBasic(name: string): string {
    if (!name) return '';

    return name
      .replace(/[\uFF01-\uFF5E]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0),
      )
      .replace(/\s+/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .toLowerCase()
      .trim();
  }

  /**
   * 完整归一化（含行政区前缀去除）。
   *
   * ⚠️ 调用方必须保证：比较双方来自**同一城市**。
   * 跨城市比较时不要用这个方法（会把"浦东"当成噪音误删）。
   */
  normalize(name: string, options: { district?: string | null } = {}): CommunityNormalizationResult {
    const removedParts: string[] = [];
    const basic = this.normalizeBasic(name);

    let normalized = basic;

    // ---- 去除行政区前缀 ----
    // 只在该小区确实属于这个行政区时才去（避免误删）
    let strippedDistrictPrefix = false;

    for (const prefix of CommunityNormalizerService.DISTRICT_PREFIXES) {
      const prefixLower = prefix.toLowerCase();

      // 小区名以行政区开头，且长度足够（避免"浦东"本身就是小区名的一部分）
      if (normalized.startsWith(prefixLower) && normalized.length > prefixLower.length + 1) {
        // 若调用方给了行政区，则要求一致 —— 这是安全阀
        if (options.district) {
          const districtLower = this.normalizeBasic(options.district);
          const prefixMatchesDistrict =
            districtLower.includes(prefixLower) || prefixLower.includes(districtLower);
          if (!prefixMatchesDistrict) continue;
        }

        const stripped = normalized.slice(prefixLower.length);
        // 剥离后不能太短（否则可能把整个小区名剥没了）
        if (stripped.length >= 2) {
          removedParts.push(prefix);
          normalized = stripped;
          strippedDistrictPrefix = true;
          break;
        }
      }
    }

    return { normalized, strippedDistrictPrefix, removedParts };
  }

  /** 便捷方法：只要归一化后的键 */
  normalizeKey(name: string, district?: string | null): string {
    return this.normalize(name, { district: district ?? null }).normalized;
  }

  /**
   * 判断两个小区名是否指向同一小区。
   *
   * 这是跨源归并的**第一道判定**，因此必须保守：
   * 只有归一化后完全相等，或一方是另一方的完整子串且长度足够时，才认为是同一小区。
   */
  isSameCommunity(
    a: { community: string; district?: string | null },
    b: { community: string; district?: string | null },
  ): boolean {
    const keyA = this.normalizeKey(a.community, a.district);
    const keyB = this.normalizeKey(b.community, b.district);

    if (!keyA || !keyB) return false;
    if (keyA === keyB) return true;

    // 包含关系：要求较短的一方至少 3 个字，避免"花园"匹配上"XX花园"
    const shorter = keyA.length <= keyB.length ? keyA : keyB;
    const longer = keyA.length <= keyB.length ? keyB : keyA;

    if (shorter.length >= 3 && longer.includes(shorter)) {
      // 进一步要求：长度差异不能过大（否则"花园"和"汤臣一品花园"会被误判）
      return longer.length - shorter.length <= 4;
    }

    return false;
  }

  /**
   * 计算两个小区名的相似度（0~1）。
   *
   * 用于第三级模糊匹配（指纹不匹配但字段高度相似时）。
   * 算法：归一化后的字符级 Jaccard 相似度 + 长度惩罚。
   */
  similarity(a: string, b: string): number {
    const keyA = this.normalizeBasic(a);
    const keyB = this.normalizeBasic(b);

    if (!keyA || !keyB) return 0;
    if (keyA === keyB) return 1;

    const setA = new Set(keyA.split(''));
    const setB = new Set(keyB.split(''));

    let intersection = 0;
    for (const char of setA) {
      if (setB.has(char)) intersection += 1;
    }

    const union = setA.size + setB.size - intersection;
    if (union === 0) return 0;

    const jaccard = intersection / union;

    // 长度惩罚：字数差异过大时降低相似度
    const lengthRatio =
      Math.min(keyA.length, keyB.length) / Math.max(keyA.length, keyB.length);

    return jaccard * (0.7 + 0.3 * lengthRatio);
  }
}
