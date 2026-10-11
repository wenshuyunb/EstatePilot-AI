/**
 * 数据库行 → NormalizedProperty 的显式映射。
 *
 * ============================================================================
 * 为什么必须有这一层（线上 500 事故）
 * ============================================================================
 * 事故现象：切换微信文案模板（自然/简短/详细）时报"生成失败"，
 * 后端日志：
 *   `TypeError: Cannot convert a BigInt value to a number`
 *   at WeChatReplyGenerator.formatWan
 *
 * 根因：**同一个字段在两条路径下的 JS 类型不同**
 *
 *   · 首次生成 → 房源对象来自 Provider 解析结果，`totalPrice` 是 `number` ✅
 *   · 重新生成 → 房源从数据库读回，Prisma 的 `BigInt`/`Decimal` 直接暴露 ⚠️
 *
 * 实测（本地库真实数据）：
 *   ```
 *   totalPrice  2760000  bigint / BigInt     ← Math.abs() 抛异常
 *   area        77       object / Decimal2   ← 数值运算不可靠
 *   unitPrice   35844    number / Number     ✅
 *   ```
 *
 * 而且原实现用了 `property: property as never` **强制关掉类型检查**，
 * 于是编译器本可以发现的类型不匹配被掩盖到了运行时。
 *
 * ============================================================================
 * 设计原则
 * ============================================================================
 *   1. **所有数值字段用 `toNumber()` 归一化** —— 不依赖调用方传什么类型
 *   2. **绝不抛异常** —— 脏数据返回 null/0，让文案降级而不是整个接口 500
 *   3. **字段一一对应** —— 数据库列名与 NormalizedProperty 保持一致，
 *      但 `Decimal`/`BigInt` 必须转换
 */

import type { NormalizedProperty, PropertyImage } from '@estatepilot/types';

/**
 * 把任意数值形态安全转成 number。
 *
 * 覆盖 Prisma 可能返回的全部形态：
 *   · `bigint`   —— BigInt 列（如 totalPrice）
 *   · `Decimal`  —— Decimal.js 实例（如 area），有 `toNumber()` 方法
 *   · `string`   —— 某些驱动会以字符串返回大数
 *   · `number`   —— 原生数值
 *   · `null` / `undefined`
 *
 * @param fallback 转换失败时的返回值（默认 null）
 */
export function toNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) return fallback;

  // 原生数值（含 NaN / Infinity 的排查）
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;

  // BigInt：直接 Number() 转换（金额在"万"量级远小于 2^53，精度足够）
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }

  // Decimal.js 实例：优先用它的 toNumber()
  if (typeof value === 'object') {
    const candidate = value as { toNumber?: () => number; toString?: () => string };

    if (typeof candidate.toNumber === 'function') {
      try {
        const converted = candidate.toNumber();
        return Number.isFinite(converted) ? converted : fallback;
      } catch {
        // 落到 toString 分支
      }
    }

    if (typeof candidate.toString === 'function') {
      const parsed = Number(candidate.toString());
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    return fallback;
  }

  // 字符串
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

/** 同 `toNumber`，但保证返回 number（失败时为 0） */
function toRequiredNumber(value: unknown): number {
  return toNumber(value, 0) ?? 0;
}

/** 安全取字符串 */
function toText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** 安全取可空字符串 */
function toNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/** 安全取字符串数组 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** 把 JSON 字段解析成对象（Prisma 的 Json 列可能是对象或字符串） */
function toObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 把数据库 Property 行映射为 `NormalizedProperty`。
 *
 * 用途：任何"从库里读房源再交给业务逻辑（文案生成、打分、展示）"的场景。
 *
 * ⚠️ 不要把数据库行直接 `as never` 传给业务层 —— 那正是本次 500 事故的成因。
 */
export function mapPropertyRowToNormalized(
  row: Record<string, unknown>,
): NormalizedProperty {
  return {
    // ---- 来源标识 ----
    externalProvider: row['externalProvider'] as NormalizedProperty['externalProvider'],
    externalId: toText(row['externalId']),
    rawData: toObject(row['rawData']),

    // ---- 位置 ----
    city: toText(row['city']),
    district: toText(row['district']),
    subDistrict: toNullableText(row['subDistrict']),
    community: toText(row['community']),
    title: toText(row['title']),
    address: toNullableText(row['address']),
    longitude: toNumber(row['longitude']),
    latitude: toNumber(row['latitude']),

    // ---- 价格 ----
    // ⚠️ totalPrice 是 BigInt 列，必须转换
    totalPrice: toRequiredNumber(row['totalPrice']),
    unitPrice: toRequiredNumber(row['unitPrice']),

    // ---- 户型 ----
    bedrooms: toRequiredNumber(row['bedrooms']),
    livingRooms: toRequiredNumber(row['livingRooms']),
    bathrooms: toRequiredNumber(row['bathrooms']),
    // ⚠️ area 是 Decimal 列，必须转换
    area: toRequiredNumber(row['area']),

    // ---- 楼层 ----
    floor: toNumber(row['floor']),
    totalFloors: toNumber(row['totalFloors']),

    // ---- 房屋属性 ----
    orientation: (row['orientation'] ?? null) as NormalizedProperty['orientation'],
    buildYear: toNumber(row['buildYear']),
    propertyType: row['propertyType'] as NormalizedProperty['propertyType'],
    ownershipType: (row['ownershipType'] ?? null) as NormalizedProperty['ownershipType'],
    decoration: (row['decoration'] ?? null) as NormalizedProperty['decoration'],
    elevator: typeof row['elevator'] === 'boolean' ? row['elevator'] : null,

    // ---- 配套 ----
    subwayDistance: toNumber(row['subwayDistance']),
    subway: toObject(row['subwayInfo']) as NormalizedProperty['subway'],
    schoolInfo: toObject(row['schoolInfo']) as NormalizedProperty['schoolInfo'],

    // ---- 展示 ----
    tags: toStringArray(row['tags']),
    images: Array.isArray(row['images']) ? (row['images'] as PropertyImage[]) : [],
    floorPlan: toStringArray(row['floorPlan']),
    description: toNullableText(row['description']),

    /**
     * ---- 状态与时间 ----
     *
     * ⚠️ 注意 `NormalizedProperty` 里没有 `coverImage` / `propertyFee` /
     *    `propertyManagementCompany` —— 它们只存在于数据库表中。
     *    不要在这里"顺手"补上：多余字段会被类型断言掩盖，
     *    而下游其实读不到（这与本次 BigInt 事故同源：靠断言绕过类型检查）。
     *    若将来需要，应先扩展 `NormalizedProperty` 定义。
     */
    listingStatus: row['listingStatus'] as NormalizedProperty['listingStatus'],
    listingDate: (row['listingDate'] ?? null) as NormalizedProperty['listingDate'],
    lastPriceChange: (row['lastPriceChange'] ?? null) as NormalizedProperty['lastPriceChange'],
  };
}
