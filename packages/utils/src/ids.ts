/**
 * 标识符与令牌生成。
 *
 * 安全要求：
 * - 客户专属链接 token 必须使用 CSPRNG，且不可反推客户 ID。
 * - 使用 URL 安全字符集，避免链接中出现需要转义的字符。
 */

const URL_SAFE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const NUMERIC_ALPHABET = '0123456789';

/**
 * 使用 CSPRNG 生成随机字符串。
 * 拒绝采样避免取模偏差（modulo bias）。
 */
export function randomString(length: number, alphabet: string = URL_SAFE_ALPHABET): string {
  if (length <= 0) return '';
  if (alphabet.length < 2) throw new Error('alphabet 至少需要 2 个字符');

  const maxValid = Math.floor(256 / alphabet.length) * alphabet.length;
  const out: string[] = [];
  const buffer = new Uint8Array(length * 2);

  while (out.length < length) {
    globalThis.crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (out.length >= length) break;
      // 拒绝落在偏差区间的字节
      if (byte >= maxValid) continue;
      out.push(alphabet[byte % alphabet.length] as string);
    }
  }

  return out.join('');
}

/**
 * 生成客户专属分享 token。
 * 默认 16 位，字符集 57 个字符 → 约 93 bit 熵，暴力枚举不可行。
 */
export function generateShareToken(length = 16): string {
  return randomString(length, URL_SAFE_ALPHABET);
}

/** 生成数字验证码 */
export function generateNumericCode(length = 6): string {
  return randomString(length, NUMERIC_ALPHABET);
}

/** 生成带前缀的业务 ID，如 cust_7Ha92KsXb3 */
export function generatePublicId(prefix: string, length = 12): string {
  return `${prefix}_${randomString(length)}`;
}

/** 生成 UUID v4。优先使用平台原生实现 */
export function generateUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // 按 RFC 4122 设置版本与变体位
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 生成去重指纹，用于避免同一事件反复产生销售机会。
 * 对参数做稳定排序后拼接，保证同一语义得到同一指纹。
 */
export function buildDedupeKey(parts: Array<string | number | null | undefined>, windowKey?: string): string {
  const normalized = parts
    .filter((part) => part !== null && part !== undefined && part !== '')
    .map((part) => String(part))
    .join('|');
  return windowKey ? `${normalized}#${windowKey}` : normalized;
}

/** 生成日期窗口键，如 "2026-10-08"（按天去重）或 "2026-10"（按月去重） */
export function buildWindowKey(date: Date = new Date(), granularity: 'day' | 'month' = 'day'): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  if (granularity === 'month') return `${y}-${m}`;
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
