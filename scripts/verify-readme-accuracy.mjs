/**
 * 验证 README 里提到的命令、脚本、文件是否真实存在。
 *
 * 为什么要做这个：文档里写错命令比不写更糟 ——
 * 别人 clone 后照着做会失败，然后以为项目坏了。
 *
 * 用法：node scripts/verify-readme-accuracy.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const README = path.join(ROOT, 'README.md');

let problems = 0;
let warnings = 0;
const fail = (m) => {
  problems += 1;
  console.log(`  ✗ ${m}`);
};
const warn = (m) => {
  warnings += 1;
  console.log(`  ⚠️  ${m}`);
};
const ok = (m) => console.log(`  ✓ ${m}`);

if (!existsSync(README)) {
  console.error('README.md 不存在');
  process.exit(1);
}

const readme = readFileSync(README, 'utf8');

console.log('README 准确性验证\n');
console.log('='.repeat(74));

// ========================================================================
console.log('\n【1】README 中引用的 pnpm 脚本是否都存在\n');

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const availableScripts = new Set(Object.keys(packageJson.scripts ?? {}));

/** 提取 README 里出现的 `pnpm xxx` 命令 */
const mentioned = new Set();
for (const match of readme.matchAll(/pnpm\s+([a-z][a-z0-9:_-]*)/g)) {
  mentioned.add(match[1]);
}

let missingScripts = 0;
for (const script of [...mentioned].sort()) {
  // 跳过 pnpm 自身的子命令
  if (['install', 'add', 'remove', 'exec', 'dlx', 'run'].includes(script)) continue;

  if (availableScripts.has(script)) {
    ok(`pnpm ${script}`);
  } else {
    fail(`pnpm ${script}  —— package.json 中没有这个脚本`);
    missingScripts += 1;
  }
}

// ========================================================================
console.log('');
console.log('【2】README 中引用的文件是否存在\n');

/** 提取反引号包裹的、看起来像路径的字符串 */
const pathCandidates = new Set();
for (const match of readme.matchAll(/`([a-zA-Z0-9_./-]+\.(ts|js|mjs|json|yml|yaml|sql|prisma|md))`/g)) {
  pathCandidates.add(match[1]);
}

// 也检查 markdown 链接里的相对路径
for (const match of readme.matchAll(/\]\(([a-zA-Z0-9_./-]+)\)/g)) {
  if (!/^https?:/.test(match[1])) pathCandidates.add(match[1]);
}

let missingFiles = 0;

for (const candidate of [...pathCandidates].sort()) {
  /**
   * 跳过明显是"通配或说明性"的路径：
   *   以 apps/api/scripts/ 结尾的目录说明
   */
  if (candidate.endsWith('/')) continue;
  if (candidate.includes('*')) continue;

  const full = path.join(ROOT, candidate);

  if (existsSync(full)) {
    ok(`${candidate}`);
  } else {
    // 有些是目录说明而非文件
    fail(`${candidate}  —— 不存在`);
    missingFiles += 1;
  }
}

// ========================================================================
console.log('');
console.log('【3】README 中引用的验证脚本是否都存在\n');

const SCRIPT_DIR = path.join(ROOT, 'apps', 'api', 'scripts');

for (const match of readme.matchAll(/scripts\/([a-z0-9-]+\.ts)/g)) {
  const scriptPath = path.join(SCRIPT_DIR, match[1]);
  if (existsSync(scriptPath)) {
    ok(`apps/api/scripts/${match[1]}`);
  } else {
    fail(`apps/api/scripts/${match[1]}  —— 不存在`);
  }
}

// ========================================================================
console.log('');
console.log('【4】README 中引用的环境变量是否都在 .env.example 里\n');

const envExamplePath = path.join(ROOT, '.env.example');
const envKeys = new Set();

if (existsSync(envExamplePath)) {
  for (const line of readFileSync(envExamplePath, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z_0-9]*)=/.exec(line.trim());
    if (match) envKeys.add(match[1]);
  }
}

/**
 * ⚠️ 只校验「必须修改的项」表格里列出的变量，而不是全文所有大写常量。
 *
 * 为什么：README 里还会提到代码层面的常量（如 TENANT_SCOPED_MODELS）、
 * 可选环境变量（如 BEIKE_TRANSPORT，代码内有默认值、无需写进模板）。
 * 把这些都当成"必须存在于 .env.example"会产生误报。
 *
 * 做法：截取"### 2. 配置环境变量"到下一个 `###` 之间的内容，
 * 只校验其中的表格行（形如 `| \`VAR\` | ... |`）。
 */
const envSectionMatch = /### 2\. 配置环境变量([\s\S]*?)(?=\n### )/.exec(readme);

if (!envSectionMatch) {
  fail('未找到「### 2. 配置环境变量」章节');
} else {
  const section = envSectionMatch[1];

  // 表格行：| `VAR` | 说明 |
  const tableVars = [...section.matchAll(/\|\s*`([A-Z][A-Z_0-9]*)`\s*\|/g)].map((m) => m[1]);
  const uniqueVars = [...new Set(tableVars)].sort();

  if (uniqueVars.length === 0) {
    fail('「配置环境变量」章节里没有解析到变量表格');
  }

  for (const key of uniqueVars) {
    if (envKeys.has(key)) {
      ok(`${key}  （在 .env.example 中）`);
    } else {
      fail(`${key}  —— 被列为"必须修改"，但 .env.example 中没有`);
    }
  }

  // 额外：正文中提到的、明确说是"环境变量"的项也应存在
  for (const match of readme.matchAll(/用\s+`([A-Z][A-Z_0-9]+)`\s+环境变量控制/g)) {
    const key = match[1];
    if (envKeys.has(key)) {
      ok(`${key}  （在 .env.example 中）`);
    } else {
      warn(`${key} 未写入 .env.example（若代码内有默认值可接受）`);
    }
  }
}

// ========================================================================
console.log('');
console.log('【5】README 中引用的截图/图片\n');

for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
  const target = match[1];
  if (/^https?:/.test(target)) {
    ok(`远程图片 ${target.slice(0, 50)}`);
  } else if (existsSync(path.join(ROOT, target))) {
    ok(`${target}`);
  } else {
    fail(`图片 ${target}  —— 不存在（会显示破图）`);
  }
}

// ========================================================================
console.log('');
console.log('='.repeat(74));

if (problems > 0) {
  console.log(`\n  ✗ README 有 ${problems} 处不准确\n`);
  process.exit(1);
}

console.log('\n  ✓ README 中引用的命令、文件、环境变量全部真实存在\n');
