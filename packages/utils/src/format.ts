/**
 * 中文格式化工具：金额、面积、时间、百分比。
 * 房地产行业习惯：总价用「万」，单价用「元/㎡」，面积用「㎡」。
 */

/** 金额格式化为「万」：5600000 → 560万；5685000 → 568.5万 */
export function formatPriceWan(amount: number | null | undefined, fractionDigits = 0): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '-';
  const wan = amount / 10000;
  const fixed = Number.isInteger(wan) ? wan.toFixed(0) : wan.toFixed(fractionDigits || 1);
  return `${fixed}万`;
}

/** 金额格式化带单位后缀：5600000 → 560 万 */
export function formatPriceWanSpaced(amount: number | null | undefined): string {
  const value = formatPriceWan(amount);
  return value === '-' ? value : value.replace('万', ' 万');
}

/** 大额金额格式化：用于成交额、GMV —— 1.235 亿 / 5680 万 */
export function formatAmountLarge(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '-';
  const abs = Math.abs(amount);
  if (abs >= 100000000) return `${(amount / 100000000).toFixed(2)}亿`;
  if (abs >= 10000) return `${(amount / 10000).toFixed(0)}万`;
  return `${amount}`;
}

/** 单价格式化：68500 → 68,500 元/㎡ */
export function formatUnitPrice(unitPrice: number | null | undefined): string {
  if (unitPrice === null || unitPrice === undefined || Number.isNaN(unitPrice)) return '-';
  return `${Math.round(unitPrice).toLocaleString('zh-CN')} 元/㎡`;
}

/** 面积格式化：106.5 → 106.5㎡ */
export function formatArea(area: number | null | undefined, fractionDigits = 1): string {
  if (area === null || area === undefined || Number.isNaN(area)) return '-';
  const rounded = Number(area.toFixed(fractionDigits));
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(fractionDigits);
  return `${text}㎡`;
}

/** 户型格式化：3室2厅1卫 */
export function formatLayout(
  bedrooms: number | null | undefined,
  livingRooms?: number | null,
  bathrooms?: number | null,
): string {
  const parts: string[] = [];
  if (bedrooms !== null && bedrooms !== undefined) parts.push(`${bedrooms}室`);
  if (livingRooms !== null && livingRooms !== undefined) parts.push(`${livingRooms}厅`);
  if (bathrooms !== null && bathrooms !== undefined) parts.push(`${bathrooms}卫`);
  return parts.length > 0 ? parts.join('') : '-';
}

/** 户型简写：3室 → 三房 */
export function formatBedroomsCn(bedrooms: number | null | undefined): string {
  if (bedrooms === null || bedrooms === undefined) return '-';
  const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (bedrooms <= 10) return `${cn[bedrooms]}房`;
  return `${bedrooms}房`;
}

/** 距离格式化：760 → 760米；1500 → 1.5公里 */
export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || Number.isNaN(meters)) return '-';
  if (meters < 1000) return `${Math.round(meters)}米`;
  return `${(meters / 1000).toFixed(1)}公里`;
}

/** 百分比：0.89 → 89%；0.8934 → 89.3% */
export function formatPercent(ratio: number | null | undefined, fractionDigits = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '-';
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

/** 变化百分比（带正负号）：-0.0528 → -5.28% */
export function formatChangePercent(ratio: number | null | undefined, fractionDigits = 2): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '-';
  const sign = ratio > 0 ? '+' : '';
  return `${sign}${(ratio * 100).toFixed(fractionDigits)}%`;
}

/** 价格变化描述：-300000 → 降价 30 万 */
export function formatPriceChange(change: number | null | undefined): string {
  if (change === null || change === undefined || Number.isNaN(change)) return '-';
  if (change === 0) return '价格未变';
  const abs = Math.abs(change);
  return change < 0 ? `降价 ${formatPriceWan(abs)}` : `涨价 ${formatPriceWan(abs)}`;
}

/** 楼层描述：8/18 → 8/18层；1/6 → 低楼层(1/6) */
export function formatFloor(floor: number | null | undefined, totalFloors: number | null | undefined): string {
  if (floor === null || floor === undefined) return '未知楼层';
  if (totalFloors === null || totalFloors === undefined) return `${floor}层`;
  return `${floor}/${totalFloors}层`;
}

/** 楼层位置标签 */
export function floorPositionLabel(floor: number, totalFloors: number): string {
  if (totalFloors <= 1) return '单层';
  const ratio = floor / totalFloors;
  if (floor === totalFloors) return '顶楼';
  if (floor === 1) return '一楼';
  if (ratio <= 0.34) return '低楼层';
  if (ratio <= 0.67) return '中楼层';
  return '高楼层';
}

/** 房龄描述：2018 → 7年房龄（按当前年份计算） */
export function formatBuildYear(buildYear: number | null | undefined, now = new Date()): string {
  if (buildYear === null || buildYear === undefined) return '房龄未知';
  const age = now.getFullYear() - buildYear;
  if (age <= 0) return `${buildYear}年（新房）`;
  return `${buildYear}年（${age}年房龄）`;
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** 相对时间描述：刚刚 / 5分钟前 / 3小时前 / 2天前 / 2026-10-01 */
export function formatRelativeTime(input: Date | string | number | null | undefined, now = new Date()): string {
  if (input === null || input === undefined) return '-';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '-';

  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return formatDate(date);

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;

  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days < 30) return `${days}天前`;

  return formatDate(date);
}

/** 日期：2026-10-08 */
export function formatDate(input: Date | string | number | null | undefined): string {
  if (input === null || input === undefined) return '-';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '-';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日期时间：2026-10-08 14:30 */
export function formatDateTime(input: Date | string | number | null | undefined): string {
  if (input === null || input === undefined) return '-';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '-';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${formatDate(date)} ${hh}:${mm}`;
}

/** 时分：14:30 */
export function formatTime(input: Date | string | number | null | undefined): string {
  if (input === null || input === undefined) return '-';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '-';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 中文日期：10月8日 周三 */
export function formatDateCn(input: Date | string | number | null | undefined): string {
  if (input === null || input === undefined) return '-';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '-';
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`;
}

/** 时长（秒）格式化：95 → 1分35秒 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '-';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? `${m}分钟` : `${m}分${s}秒`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}小时` : `${h}小时${rm}分`;
}

/** 计算相差天数（向下取整），用于超期判断 */
export function daysBetween(from: Date | string, to: Date | string = new Date()): number {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

/** 某天的起点（本地时区 00:00:00） */
export function startOfDay(input: Date | string = new Date()): Date {
  const date = input instanceof Date ? new Date(input) : new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** 某天的终点（本地时区 23:59:59.999） */
export function endOfDay(input: Date | string = new Date()): Date {
  const date = input instanceof Date ? new Date(input) : new Date(input);
  date.setHours(23, 59, 59, 999);
  return date;
}

/** 加减天数 */
export function addDays(input: Date | string, days: number): Date {
  const date = input instanceof Date ? new Date(input) : new Date(input);
  date.setDate(date.getDate() + days);
  return date;
}

/** 根据当前小时生成问候语 */
export function greetingByHour(hour = new Date().getHours()): string {
  if (hour < 6) return '凌晨好';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

// ---------------------------------------------------------------------------
// 数值
// ---------------------------------------------------------------------------

/** 数字千分位：1234567 → 1,234,567 */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toLocaleString('zh-CN');
}

/** 限制在 0～100 并保留指定小数位 */
export function clampScore(score: number, fractionDigits = 0): number {
  const clamped = Math.min(100, Math.max(0, score));
  return Number(clamped.toFixed(fractionDigits));
}

/** 限制在 0～1 */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 线性插值归一化：把 value 从 [min,max] 映射到 0～1，超出范围则截断 */
export function normalizeToUnit(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return clamp01((value - min) / (max - min));
}

/**
 * 高斯式衰减：偏离目标越远得分越低，返回 0～1。
 * 用于预算、面积、地铁距离等「越接近越理想」的维度打分。
 */
export function gaussianAffinity(value: number, target: number, tolerance: number): number {
  if (tolerance <= 0) return value === target ? 1 : 0;
  const z = (value - target) / tolerance;
  return clamp01(Math.exp(-0.5 * z * z));
}

/** 安全除法，避免除零 */
export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  if (denominator === 0) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

/** 百分比（0～1）安全转换 */
export function safeRatio(numerator: number, denominator: number): number {
  return clamp01(safeDivide(numerator, denominator, 0));
}

/** 求和 */
export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

/** 平均值，空数组返回 null */
export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return sum(values) / values.length;
}

/** 中位数 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (low === undefined || high === undefined) return null;
  return (low + high) / 2;
}

/** 分位数（p 取 0～1） */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp01(p) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowValue = sorted[lower];
  const highValue = sorted[upper];
  if (lowValue === undefined || highValue === undefined) return null;
  if (lower === upper) return lowValue;
  return lowValue + (highValue - lowValue) * (index - lower);
}

/** 一组数字的极差（用于预算区间推断） */
export function range(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  let min = values[0] as number;
  let max = values[0] as number;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}
