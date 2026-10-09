/**
 * 推送后验证 —— 确认远端仓库没有暴露敏感文件。
 *
 * ============================================================================
 * 为什么要独立验证
 * ============================================================================
 * 本地检查通过 ≠ 远端就安全。可能的差异来源：
 *   · .gitignore 在提交后才修改（旧文件已进入历史）
 *   · git add 时的暂存状态与预期不符
 *   · 行尾规范化等 git 属性的影响
 *
 * 因此必须**直接检查远端实际内容**。
 *
 * 用法：node scripts/verify-remote-clean.mjs
 */

const OWNER_REPO = 'wenshuyunb/EstatePilot-AI';
const COMMIT = 'ec46b8f1067639afe21b47e75c0700eb061b876d';

const API = `https://api.github.com/repos/${OWNER_REPO}`;

/** 必须在远端存在的文件 */
const MUST_EXIST = [
  'README.md',
  '.env.example',
  '.gitignore',
  '.gitattributes',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'infrastructure/docker-compose.yml',
  'packages/database/prisma/schema.prisma',
  'apps/api/package.json',
  'apps/web/package.json',
];

/** 绝不能在远端出现的路径（正则） */
const MUST_NOT_EXIST = [
  { name: '真实环境变量文件', regex: /^\.env$/ },
  { name: 'env 备份文件', regex: /^\.env\.(backup|local|production|development)/ },
  { name: '子目录 env 文件', regex: /\/\.env(\.|$)/ },
  { name: 'node_modules', regex: /node_modules\// },
  { name: '数据库备份', regex: /^\.backups\/|\.sql\.gz$|\.dump$/ },
  { name: '探针日志', regex: /\.(probe|quota|session|threshold)-log\.txt$/ },
  { name: '构建产物', regex: /^(dist|\.next)\// },
  { name: '临时目录', regex: /^\.tmp-|^_tmp\// },
  { name: 'SSH 私钥', regex: /id_(rsa|ed25519)$/ },
];

async function main() {
  console.log('推送后远端验证\n');
  console.log('='.repeat(74));

  // ---- 1. 获取远端文件树 ----
  console.log('\n【1】获取远端文件树\n');

  const treeUrl = `https://api.github.com/repos/${OWNER_REPO}/git/trees/${COMMIT}?recursive=1`;

  const response = await fetch(treeUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'estatepilot-verify',
    },
  });

  if (!response.ok) {
    console.log(`  ✗ GitHub API 返回 ${response.status}`);
    console.log('  （可能是仓库私有，或 API 限流。请用浏览器人工确认）');
    process.exit(1);
  }

  const data = await response.json();
  const files = (data.tree ?? []).filter((node) => node.type === 'blob').map((node) => node.path);

  console.log(`  远端提交：${COMMIT.slice(0, 10)}`);
  console.log(`  文件总数：${files.length}`);
  console.log(`  仓库可见性：${data.truncated ? '（树被截断）' : '完整'}`);

  // ---- 2. 敏感文件检查 ----
  console.log('');
  console.log('【2】敏感文件泄露检查\n');

  let leaks = 0;

  for (const rule of MUST_NOT_EXIST) {
    const matched = files.filter((file) => rule.regex.test(file));

    if (matched.length === 0) {
      console.log(`  ✓ 无 ${rule.name}`);
      continue;
    }

    leaks += matched.length;
    console.log(`  ✗ 发现 ${rule.name}（${matched.length} 个）：`);
    for (const file of matched.slice(0, 5)) console.log(`      ${file}`);
    if (matched.length > 5) console.log(`      …还有 ${matched.length - 5} 个`);
  }

  // ---- 3. 必需文件检查 ----
  console.log('');
  console.log('【3】必需文件完整性\n');

  let missing = 0;

  for (const file of MUST_EXIST) {
    if (files.includes(file)) {
      console.log(`  ✓ ${file}`);
    } else {
      missing += 1;
      console.log(`  ✗ ${file}  —— 远端不存在`);
    }
  }

  // ---- 4. 数据库迁移 ----
  console.log('');
  console.log('【4】数据库迁移文件\n');

  const migrations = files.filter((file) => /migrations\/.*migration\.sql$/.test(file));

  if (migrations.length === 0) {
    console.log('  ✗ 没有迁移文件');
    missing += 1;
  } else {
    console.log(`  ✓ 共 ${migrations.length} 个迁移：`);
    for (const file of migrations.sort()) {
      console.log(`      ${file.replace('packages/database/prisma/migrations/', '')}`);
    }
  }

  // ---- 5. 目录分布 ----
  console.log('');
  console.log('【5】目录分布\n');

  const byTop = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const key = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    byTop.set(key, (byTop.get(key) ?? 0) + 1);
  }

  for (const [key, count] of [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${key.padEnd(46)} ${count}`);
  }

  // ---- 6. 体积 ----
  console.log('');
  console.log('【6】仓库体积\n');

  const totalBytes = (data.tree ?? [])
    .filter((node) => node.type === 'blob')
    .reduce((sum, node) => sum + (node.size ?? 0), 0);

  console.log(`  总计：${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  const largest = (data.tree ?? [])
    .filter((node) => node.type === 'blob')
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, 5);

  console.log('  最大的 5 个文件：');
  for (const node of largest) {
    console.log(`    ${((node.size ?? 0) / 1024).toFixed(0).padStart(6)} KB  ${node.path}`);
  }

  // ---- 结论 ----
  console.log('');
  console.log('='.repeat(74));

  if (leaks > 0) {
    console.log(`\n  ✗ 发现 ${leaks} 个敏感文件已公开 —— 需要立即处理\n`);
    process.exit(1);
  }

  if (missing > 0) {
    console.log(`\n  ⚠️  有 ${missing} 个必需文件缺失\n`);
    process.exit(1);
  }

  console.log('\n  ✅ 远端仓库验证通过：');
  console.log('     · 无任何敏感文件泄露');
  console.log('     · 必需文件完整');
  console.log(`     · 数据库迁移 ${migrations.length} 个`);
  console.log('');
  console.log(`  仓库地址：https://github.com/${OWNER_REPO}`);
  console.log('');
}

main().catch((error) => {
  console.error('验证异常：', error);
  process.exit(1);
});
