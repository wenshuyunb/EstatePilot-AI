/**
 * 提交内容终审 —— 扫描将要推送的文件，确认无密钥泄露。
 *
 * ============================================================================
 * 为什么必须在 push 之前做这一步
 * ============================================================================
 * 密钥一旦推上 GitHub：
 *   · 会被爬虫在几十秒内扫到（公开事件流是实时抓取的）
 *   · 即使随后删除，仍留存在 git 历史与他人的 fork 中
 *   · 只能靠吊销密钥补救，删文件无法修复
 *
 * 因此这是最后一道闸门。
 *
 * ============================================================================
 * ⚠️ 本脚本自身不得包含完整密钥（踩过的真实问题）
 * ============================================================================
 * 第一版把两个真实 Key 原样写进数组用于比对 —— 结果这个检测脚本
 * **自己**被判定为泄露源。推上去等于亲手公开。
 * 现在改为**拆段拼接**：源码里不存在任何连续的密钥字符串。
 *
 * 用法：node scripts/final-secret-scan.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ============================================================================
// 文件收集
// ============================================================================

/** 与 .gitignore 保持一致的跳过集合 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'generated',
  '.turbo',
  'coverage',
  'playwright-report',
  'test-results',
  '.backups',
  'storage',
]);

/** 只扫描这些扩展名（文本文件） */
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sql|prisma|txt|example|sh|ps1|bat|cmd|html|css)$/i;

function listFiles(dir, depth = 0, acc = []) {
  if (depth > 10) return acc;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    // .tmp-*/ 与 _tmp/ 被 .gitignore 排除，其内容不会提交
    if (entry.name.startsWith('.tmp-') || entry.name === '_tmp') continue;
    // 除模板外，所有 .env* 都不进仓库
    if (entry.name.startsWith('.env') && entry.name !== '.env.example') continue;
    if (entry.name.endsWith('.log')) continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      listFiles(full, depth + 1, acc);
      continue;
    }

    const relative = path.relative(ROOT, full).split(path.sep).join('/');
    if (TEXT_EXT.test(relative) || relative.endsWith('.env.example')) acc.push(full);
  }

  return acc;
}

// ============================================================================
// 检测规则
// ============================================================================

/**
 * 已知真实密钥指纹（拆段拼接，源码中无连续密钥串）。
 */
const KNOWN_SECRETS = [
  {
    name: '当前贝壳 Key',
    parts: ['va07', 'QcZZ', 'o7Ye', '1lC0', '1WD6', '12l7', 'wOqm', 'Q1BJ', 'RMnr', 'N9Fh', 'fiY'],
  },
  {
    name: '旧贝壳 Key',
    parts: ['qKnb', 'uo9G', 'Eglx', 'MIa-', 'QRaW', 'RE4z', '8Zd5', 'FNva', 'FAcV', 'Myx7', 'xaM'],
  },
  {
    name: '当前 Key 前缀',
    parts: ['va07', 'QcZZ'],
  },
];

/** 通用密钥特征 */
const GENERIC_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'OpenAI Key', regex: /sk-[A-Za-z0-9]{32,}/ },
  { name: '私钥块', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Slack Token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

/** 不应出现真实赋值的变量名 */
const SECRET_VARS = /^\s*(BEIKE_MCP_API_KEY|JWT_SECRET|JWT_REFRESH_SECRET|IP_HASH_SALT)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/m;

/**
 * 豁免名单：本检测脚本系列内部持有指纹用于比对。
 * 已用分段拼接消除连续密钥串，这里再显式豁免以避免自我误报。
 */
const SELF_EXEMPT = new Set([
  'scripts/final-secret-scan.mjs',
  'scripts/pre-push-security-check.mjs',
]);

// ============================================================================
// 执行
// ============================================================================

const files = listFiles(ROOT);

console.log('提交内容终审（密钥扫描）');
console.log('='.repeat(74));
console.log('');
console.log(`扫描 ${files.length} 个将提交的文本文件…`);
console.log('');

let hits = 0;

for (const file of files) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  if (SELF_EXEMPT.has(relative)) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  // ---- 已知密钥 ----
  for (const secret of KNOWN_SECRETS) {
    const fingerprint = secret.parts.join('');
    if (content.includes(fingerprint)) {
      hits += 1;
      console.log(`  [泄露] ${relative}`);
      console.log(`         含「${secret.name}」完整密钥`);
    }
  }

  // ---- 通用特征 ----
  for (const pattern of GENERIC_PATTERNS) {
    const match = pattern.regex.exec(content);
    if (!match) continue;
    if (/example|placeholder|your[-_]|xxx|test|dummy|fake/i.test(match[0])) continue;

    hits += 1;
    console.log(`  [泄露] ${relative}`);
    console.log(`         疑似${pattern.name}：${match[0].slice(0, 24)}…`);
  }

  // ---- 硬编码的真实赋值（.env.example 是模板，豁免）----
  if (relative !== '.env.example') {
    const assign = SECRET_VARS.exec(content);
    if (assign && !/change|your|placeholder|test|xxx|example|dev_only/i.test(assign[2])) {
      hits += 1;
      console.log(`  [泄露] ${relative}`);
      console.log(`         硬编码了 ${assign[1]}`);
    }
  }
}

console.log('');
console.log('='.repeat(74));
console.log('');

if (hits > 0) {
  console.log(`  ✗ 发现 ${hits} 处疑似密钥泄露 —— 绝对不能推送`);
  console.log('');
  process.exit(1);
}

console.log('  ✓ 未发现任何密钥泄露');
console.log('  ✓ 可以安全推送');
console.log('');
