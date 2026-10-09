/**
 * 敏感信息脱敏与哈希工具。
 *
 * 合规要求（中国个人信息保护法）：
 * - 手机号、姓名在前端列表与日志中必须脱敏。
 * - IP 绝不存明文，只存加盐哈希。
 * - 任何日志都不得出现完整手机号、身份证号。
 */

/**
 * 手机号脱敏：13812345678 → 138****5678
 * 非 11 位手机号按通用规则保留首尾。
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}****${digits.slice(7)}`;
  }
  if (digits.length >= 7) {
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }
  if (digits.length >= 4) {
    return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
  }
  return '****';
}

/** 姓名脱敏：张三 → 张*；欧阳修 → 欧**；张 → 张 */
export function maskName(name: string | null | undefined): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed[0] + '*'.repeat(trimmed.length - 1);
}

/** 身份证脱敏：保留前 6 后 4 */
export function maskIdCard(idCard: string | null | undefined): string {
  if (!idCard) return '';
  const value = idCard.trim();
  if (value.length <= 10) return maskName(value);
  return `${value.slice(0, 6)}${'*'.repeat(value.length - 10)}${value.slice(-4)}`;
}

/** 邮箱脱敏：zhangsan@example.com → zh****an@example.com */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return maskName(email);
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}*${domain}`;
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 4))}${local.slice(-2)}${domain}`;
}

/** 地址脱敏：只保留到区/路级别，隐藏门牌号 */
export function maskAddress(address: string | null | undefined): string {
  if (!address) return '';
  return address.replace(/\d+\s*(号|弄|室|楼|层|单元)/g, '***');
}

/** 微信/QQ 等账号脱敏 */
export function maskAccount(account: string | null | undefined): string {
  if (!account) return '';
  const value = account.trim();
  if (value.length <= 3) return '***';
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(2, value.length - 4))}${value.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// 哈希（同构实现：浏览器用 Web Crypto，Node 22+ 也原生提供全局 crypto.subtle）
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 计算加盐 SHA-256 哈希，返回十六进制字符串。
 * 用于 ipHash：既能把同一 IP 归并做行为分析，又不可逆推出原始 IP。
 */
export async function saltedHash(value: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${value}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * IP 脱敏哈希。IPv4 会先截断到 /24 网段再哈希，
 * 这样同一小区/同一网络的访问可以聚合，同时进一步降低可识别性。
 */
export async function hashIp(ip: string | null | undefined, salt: string): Promise<string> {
  if (!ip) return '';
  const normalized = ip.trim().replace(/^::ffff:/, '');
  const segments = normalized.split('.');
  // IPv4：截断到 /24，只保留前三段
  const target = segments.length === 4 ? `${segments[0]}.${segments[1]}.${segments[2]}.0` : normalized;
  return saltedHash(target, salt);
}
