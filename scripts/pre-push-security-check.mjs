/**
 * 上传前安全检查（修正版）。
 *
 * 修正的误报与实现问题：
 *   1. 原先用 `execFileSync`/`spawnSync` 调 git ——
 *      **在本项目的沙箱环境下 Node 无法用管道捕获子进程输出**
 *      （spawn 直接 EPERM，status=null），导致所有 git 判定失效、
 *      把已被忽略的 .env 误报成"会被推上 GitHub"。
 *      现在改为**自己解析 .gitignore**，不依赖子进程。
 *   2. `CHANGE_ME_dev_only_...` 这类占位符曾被当成真实密钥
 *   3. 数据库索引名（43 位字母数字）曾被误判为贝壳 Key
 *
 * 用法：node scripts/pre-push-security-check.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

let problems = 0;
let warnings = 0;

const problem = (m) => {
  problems += 1;
  console.log(`  ✗ ${m}`);
};
const warn = (m) => {
  warnings += 1;
  console.log(`  ⚠️  ${m}`);
};
const ok = (m) => console.log(`  ✓ ${m}`);

// ==========================================================================
// .gitignore 解析（替代 git check-ignore）
// ==========================================================================

/** 读取并解析 .gitignore，支持 gitignore 的通配语义（够用子集） */
function loadIgnoreRules() {
  const rules = [];

  /**
   * 为什么要合并多个 .gitignore：monorepo 里子目录也可以有 .gitignore，
   * 漏读会导致误判"未被忽略"。
   */
  const files = [];
  const collect = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (['node_modules', '.git', '.next', 'dist'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full, depth + 1);
      } else if (entry.name === '.gitignore') {
        files.push(full);
      }
    }
  };
  collect(ROOT);

  for (const file of files) {
    const baseDir = path.relative(ROOT, path.dirname(file)).split(path.sep).join('/');

    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith('#')) continue;

      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;

      rules.push({ baseDir, pattern, negated, raw: line });
    }
  }

  return rules;
}

/**
 * 把 gitignore 的通配模式转成正则。
 *
 * 支持的语义（覆盖本项目用到的全部写法）：
 *   `*`   → 不跨目录的任意字符
 *   `**`  → 跨目录任意字符
 *   `?`   → 单个字符
 *   `/` 结尾 → 只匹配目录
 */
function patternToRegex(pattern, baseDir) {
  let body = pattern;

  /**
   * 目录模式（`node_modules/`）要匹配**目录本身与其全部内容**。
   *
   * 这是第一版的 bug：我只去掉了结尾的 `/`，
   * 生成的正则 `^node_modules$` 只能匹配目录名本身，
   * 匹配不到 `node_modules/foo/index.js` ——
   * 于是误报"node_modules 未被排除"。
   */
  const dirOnly = body.endsWith('/');
  if (dirOnly) body = body.slice(0, -1);

  const anchored = body.startsWith('/');
  if (anchored) body = body.slice(1);

  // 转义正则特殊字符，再把通配符换回来
  let regex = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');

  /**
   * 是否锚定到 baseDir 根：
   *   含 `/`（在中间）或以 `/` 开头 → 锚定
   *   否则可匹配任意层级（gitignore 的默认行为）
   */
  const hasSlash = body.includes('/');
  const prefix = baseDir.length > 0 ? `${baseDir}/` : '';

  // 目录模式额外允许"后面还有路径"
  const suffix = dirOnly ? '(?:/.*)?' : '';

  if (anchored || hasSlash) {
    return new RegExp(`^${prefix}${regex}${suffix}$`);
  }

  return new RegExp(`^${prefix}(?:.*/)?${regex}${suffix}$`);
}

const IGNORE_RULES = loadIgnoreRules();

/** 判断相对路径是否被忽略（按 gitignore 规则，后面的规则优先） */
function isIgnored(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  let ignored = false;

  for (const rule of IGNORE_RULES) {
    const regex = patternToRegex(rule.pattern, rule.baseDir);
    if (regex.test(normalized)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

console.log('上传前安全检查\n');
console.log('='.repeat(74));

// ========================================================================
console.log('\n【1】.env.example 是否含真实值\n');

const examplePath = path.join(ROOT, '.env.example');

/** 占位符判定（覆盖 CHANGE_ME / dev_only 等常见写法） */
function isPlaceholder(value) {
  if (value.length === 0) return true;
  if (/^(your|xxx|changeme|placeholder|todo|none|null|empty)$/i.test(value)) return true;
  if (/change[_-]?me/i.test(value)) return true;
  if (/dev[_-]?only/i.test(value)) return true;
  if (/your[-_]|example\.|placeholder|<[^>]+>|\.\.\.|\$\{/.test(value)) return true;
  if (/^(postgres|postgresql|redis|mysql):\/\//.test(value)) return true;
  if (/^(true|false|\d+)$/.test(value)) return true;
  if (/^(mock|local|debug|info|warn|error)$/i.test(value)) return true;
  // 本地开发默认密码（形如 xxx_dev_pwd），无外泄风险
  if (/_dev_pwd$|_dev_password$|^dev[_-]/i.test(value)) return true;
  return false;
}

if (!existsSync(examplePath)) {
  warn('.env.example 不存在（建议提供，便于他人配置）');
} else {
  const content = readFileSync(examplePath, 'utf8');

  const SENSITIVE = /^([A-Za-z_0-9]+(?:API_KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL|SALT))\s*=\s*(.*)$/;

  let checked = 0;
  let flagged = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const match = SENSITIVE.exec(trimmed);
    if (!match) continue;

    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    checked += 1;

    if (isPlaceholder(value)) continue;

    const looksRandom =
      value.length >= 24 &&
      /^[A-Za-z0-9_\-+/=]+$/.test(value) &&
      /[A-Z]/.test(value) &&
      /[a-z]/.test(value) &&
      /\d/.test(value);

    flagged += 1;
    if (looksRandom) problem(`${key} 疑似真实密钥（${value.slice(0, 8)}…，长度 ${value.length}）`);
    else warn(`${key} 可能不是占位符：${value.slice(0, 40)}`);
  }

  if (flagged === 0) ok(`检查 ${checked} 个敏感配置项，均为占位符或本地默认值`);

  /**
   * 已知泄露片段的黑名单。
   *
   * ⚠️ 不能直接写完整密钥 —— 这个检测脚本自身会被推送，
   * 源码里出现密钥等于亲手公开。因此拆段拼接。
   */
  const KNOWN_FRAGMENTS = [['va07Qc', 'ZZ'].join(''), ['qKnbuo9', 'G'].join('')];

  for (const fragment of KNOWN_FRAGMENTS) {
    if (content.includes(fragment)) {
      problem(`.env.example 含本次使用的真实贝壳 Key 片段（${fragment}…）`);
    }
  }
}

// ========================================================================
console.log('');
console.log('【2】env 文件的忽略状态\n');

const envFiles = [];
const scanEnv = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (['node_modules', '.git', '.next', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanEnv(full, depth + 1);
      continue;
    }
    if (entry.name.startsWith('.env')) envFiles.push(path.relative(ROOT, full));
  }
};

scanEnv(ROOT);

for (const file of envFiles) {
  const relative = file.split(path.sep).join('/');

  if (relative === '.env.example') {
    if (!isIgnored(relative)) ok('.env.example 会被提交（正确）');
    else problem('.env.example 被忽略了（别人无法配置）');
    continue;
  }

  if (isIgnored(relative)) {
    ok(`${relative} 已忽略`);
  } else {
    problem(`${relative} **未忽略** —— 会被推上 GitHub！`);
  }
}

// ========================================================================
console.log('');
console.log('【3】源码里是否有硬编码密钥\n');

const sourceFiles = [];
const collect = (dir, depth = 0) => {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', '.next', '.git', 'generated', 'migrations'].includes(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, depth + 1);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(entry.name)) sourceFiles.push(full);
  }
};

for (const dir of ['apps', 'packages', 'scripts']) {
  const full = path.join(ROOT, dir);
  if (existsSync(full)) collect(full);
}

/**
 * 密钥特征（修正版）。
 *
 * ⚠️ 关键修正：第一版用裸的 43 位字母数字串匹配贝壳 Key，
 * 结果把数据库**索引名**（如 `customers_organizationId_idx`）也匹配进来了 ——
 * 索引名正好也是 43 位。
 * 现在改为匹配"贝壳 Key 的赋值上下文"。
 */
const SECRET_PATTERNS = [
  {
    name: '贝壳 Key（BEIKE 赋值上下文）',
    regex: /BEIKE[A-Z_]*\s*[:=]\s*["'`]([A-Za-z0-9_-]{40,})["'`]/g,
  },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'OpenAI Key', regex: /["'`]sk-[A-Za-z0-9]{32,}["'`]/g },
  { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: '私钥', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

let found = 0;

for (const file of sourceFiles) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    const matches = content.match(regex);
    if (!matches) continue;

    const real = matches.filter((m) => !/test|example|fake|dummy|placeholder|sample|mock/i.test(m));
    if (real.length > 0) {
      found += real.length;
      problem(`${path.relative(ROOT, file)} 含${name}：${real[0].slice(0, 24)}…`);
    }
  }
}

if (found === 0) ok(`扫描 ${sourceFiles.length} 个源码文件，未发现硬编码密钥`);

// ========================================================================
console.log('');
console.log('【4】必需文件完整性\n');

const REQUIRED = [
  { path: 'package.json', why: '根包定义' },
  { path: 'pnpm-lock.yaml', why: '依赖锁定（保证可复现安装）' },
  { path: 'pnpm-workspace.yaml', why: 'monorepo 工作区' },
  { path: '.env.example', why: '环境变量模板' },
  { path: 'packages/database/prisma/schema.prisma', why: '数据库 schema' },
  { path: 'infrastructure/docker-compose.yml', why: '本地依赖服务（Postgres/Redis）' },
  { path: 'infrastructure/postgres/init/01-extensions.sql', why: '数据库扩展初始化（pgvector/trgm）' },
  { path: 'README.md', why: '项目说明（别人 clone 后的入口）' },
];

for (const { path: file, why } of REQUIRED) {
  if (existsSync(path.join(ROOT, file))) ok(`${file}  (${why})`);
  else problem(`缺少 ${file}  (${why})`);
}

const migrationsDir = path.join(ROOT, 'packages', 'database', 'prisma', 'migrations');
if (existsSync(migrationsDir)) {
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const missing = dirs.filter((dir) => !existsSync(path.join(migrationsDir, dir, 'migration.sql')));
  if (missing.length === 0) ok(`数据库迁移 ${dirs.length} 个，均有 migration.sql`);
  else for (const dir of missing) problem(`迁移 ${dir} 缺少 migration.sql`);

  const ignoredMigrations = dirs.filter((dir) =>
    isIgnored(`packages/database/prisma/migrations/${dir}/migration.sql`),
  );
  if (ignoredMigrations.length > 0) {
    for (const dir of ignoredMigrations) problem(`迁移 ${dir} 被 .gitignore 排除了`);
  } else {
    ok('所有迁移文件都会提交');
  }
} else {
  problem('迁移目录不存在');
}

// ========================================================================
console.log('');
console.log('【5】体积与依赖\n');

if (isIgnored('node_modules/foo/index.js') || isIgnored('apps/api/node_modules/x/y.js')) {
  ok('node_modules 会被排除（正确：由 pnpm install 从 lockfile 重建）');
} else {
  problem('node_modules 未被排除 —— 会产生 10 万+ 文件');
}

if (existsSync(path.join(ROOT, 'pnpm-lock.yaml'))) {
  const size = statSync(path.join(ROOT, 'pnpm-lock.yaml')).size;
  const content = readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const packages = (content.match(/^ {2}\S+:/gm) ?? []).length;
  ok(`pnpm-lock.yaml 存在（${(size / 1024).toFixed(0)} KB，约 ${packages} 个依赖条目）`);
}

// 统计将要提交的文件（按忽略规则估算）
let fileCount = 0;
let totalBytes = 0;

const measure = (dir, depth = 0) => {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(ROOT, full).split(path.sep).join('/');

    if (isIgnored(relative)) continue;
    if (entry.name === '.git') continue;

    if (entry.isDirectory()) {
      measure(full, depth + 1);
    } else {
      try {
        fileCount += 1;
        totalBytes += statSync(full).size;
      } catch {
        // 忽略
      }
    }
  }
};

measure(ROOT);

console.log(`  预计提交 ${fileCount} 个文件，约 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

// ========================================================================
console.log('');
console.log('='.repeat(74));

if (problems > 0) {
  console.log(`\n  ✗ ${problems} 个必须修复的问题，${warnings} 个警告\n`);
  process.exit(1);
}

console.log(`\n  ✓ 安全检查通过（${warnings} 个警告）\n`);

