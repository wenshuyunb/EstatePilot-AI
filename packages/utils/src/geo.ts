/**
 * 地理计算与输入校验工具。
 */

/** 地球平均半径（米） */
const EARTH_RADIUS_METERS = 6371008.8;

export interface GeoPoint {
  longitude: number;
  latitude: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Haversine 公式计算两点间直线距离（米）。
 * 用于通勤距离、地铁距离的粗算；真实驾车时间需接入地图服务。
 */
export function haversineDistance(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/** 坐标是否有效（在中国范围内做宽松判断） */
export function isValidChinaCoordinate(point: GeoPoint | null | undefined): boolean {
  if (!point) return false;
  const { longitude, latitude } = point;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  return longitude >= 73 && longitude <= 136 && latitude >= 3 && latitude <= 54;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 中国大陆手机号 */
const CN_MOBILE_REGEX = /^1[3-9]\d{9}$/;

export function isValidChineseMobile(phone: string | null | undefined): boolean {
  if (!phone) return false;
  return CN_MOBILE_REGEX.test(phone.replace(/\D/g, ''));
}

/** 宽松邮箱校验 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return EMAIL_REGEX.test(email.trim());
}

/** 18 位身份证（含校验位验证） */
export function isValidChineseIdCard(idCard: string | null | undefined): boolean {
  if (!idCard) return false;
  const value = idCard.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(value)) return false;

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

  let total = 0;
  for (let i = 0; i < 17; i += 1) {
    const digit = Number(value[i]);
    if (Number.isNaN(digit)) return false;
    total += digit * (weights[i] as number);
  }

  return checkCodes[total % 11] === value[17];
}

/** 面积是否在合理范围（住宅 5～2000㎡） */
export function isValidArea(area: number | null | undefined): boolean {
  if (area === null || area === undefined) return false;
  return Number.isFinite(area) && area >= 5 && area <= 2000;
}

/** 总价是否在合理范围（1 万 ～ 100 亿分=10 亿元） */
export function isValidTotalPrice(price: number | null | undefined): boolean {
  if (price === null || price === undefined) return false;
  return Number.isFinite(price) && price >= 10000 && price <= 1000000000;
}

/** 建成年份是否合理 */
export function isValidBuildYear(year: number | null | undefined, now = new Date()): boolean {
  if (year === null || year === undefined) return false;
  return Number.isInteger(year) && year >= 1900 && year <= now.getFullYear() + 2;
}

/** 清理用户输入，移除控制字符与多余空白（防注入与脏数据） */
export function sanitizeText(input: string | null | undefined, maxLength = 2000): string {
  if (!input) return '';
  // 移除控制字符（保留换行与制表）
  const cleaned = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const trimmed = cleaned.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** 归一化区域名：去除「区」「板块」等后缀便于比较 */
export function normalizeDistrictName(district: string | null | undefined): string {
  if (!district) return '';
  return district
    .trim()
    .replace(/[区县市]$/, '')
    .replace(/\s+/g, '');
}

/** 归一化小区名：去除括号内容与常见后缀，便于跨来源匹配同一小区 */
export function normalizeCommunityName(community: string | null | undefined): string {
  if (!community) return '';
  return community
    .trim()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(小区|花园|公寓|苑|城|湾|府|里|号院)$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 解析分页参数中的整数，非法值回落到默认值 */
export function parseIntSafe(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 解析查询参数中的数字数组，支持 "1,2,3" 与重复参数 */
export function parseNumberArray(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out: number[] = [];
  for (const item of raw) {
    const parsed = typeof item === 'number' ? item : Number.parseInt(String(item).trim(), 10);
    if (Number.isFinite(parsed)) out.push(parsed);
  }
  return out;
}

/** 解析查询参数中的字符串数组，支持 "a,b,c" 与重复参数 */
export function parseStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

/** 解析查询参数中的布尔值 */
export function parseBooleanSafe(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  return fallback;
}

/** 带种子的可复现伪随机数生成器（mulberry32）——用于生成稳定的模拟数据 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从数组中按种子随机取一项 */
export function pickOne<T>(items: readonly T[], random: () => number): T {
  if (items.length === 0) throw new Error('pickOne 需要非空数组');
  const index = Math.floor(random() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

/** 按权重随机取一项，权重为非负数数组 */
export function pickWeighted<T>(items: readonly T[], weights: readonly number[], random: () => number): T {
  if (items.length === 0) throw new Error('pickWeighted 需要非空数组');
  if (items.length !== weights.length) throw new Error('items 与 weights 长度必须一致');

  const total = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (total <= 0) return pickOne(items, random);

  let threshold = random() * total;
  for (let i = 0; i < items.length; i += 1) {
    threshold -= Math.max(0, weights[i] as number);
    if (threshold <= 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}

/** 从数组中随机取 n 项（不重复） */
export function pickMany<T>(items: readonly T[], count: number, random: () => number): T[] {
  if (count >= items.length) return [...items];
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.floor(random() * pool.length);
    const [picked] = pool.splice(index, 1);
    if (picked !== undefined) out.push(picked);
  }
  return out;
}

/** 在区间内取随机整数（含两端） */
export function randomInt(min: number, max: number, random: () => number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

/** 在区间内取随机浮点数 */
export function randomFloat(min: number, max: number, random: () => number, fractionDigits = 2): number {
  const value = random() * (max - min) + min;
  return Number(value.toFixed(fractionDigits));
}

/** 延迟指定毫秒 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 指数退避延迟计算（含抖动），用于外部 API 重试 */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30000, jitterRatio = 0.2): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = exponential * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

/** 按批拆分数组，用于批量写入避免单次 SQL 过大 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('批大小必须大于 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}

/** 移除数组中的重复值（保持首次出现顺序） */
export function unique<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items));
}

/** 按 key 去重，保留首个 */
export function uniqueBy<T, K>(items: readonly T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 按 key 分组 */
export function groupBy<T, K extends string | number>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}
