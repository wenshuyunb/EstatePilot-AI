/**
 * 数据库重置脚本。
 *
 * 用途：把数据库恢复到「空库 + 已迁移」状态，用于重新 seed 或排查脏数据。
 *
 * ⚠️ 危险操作：会删除所有业务数据。
 * 因此脚本要求显式确认（传 --yes），并且在非开发环境拒绝执行。
 *
 * 用法：
 *   pnpm --filter @estatepilot/database reset -- --yes
 *
 * 实现说明：用 TRUNCATE ... CASCADE 而不是逐表 delete。
 * 原因：本项目有 36 张表、大量外键，逐表删除既慢又容易因顺序问题失败；
 * TRUNCATE CASCADE 由 PostgreSQL 自己处理依赖顺序，且会重置自增序列。
 * 注意保留 _prisma_migrations 表，否则迁移历史会丢失、需要重新 deploy。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

const { createPrismaClient } = await import('../client.js');

const confirmed = process.argv.includes('--yes');
const nodeEnv = process.env.NODE_ENV ?? 'development';

if (nodeEnv === 'production') {
  console.error(
    '\n[拒绝执行] NODE_ENV=production 时禁止重置数据库。\n' +
      '如果确实需要重置生产库，请手动执行 SQL 并做好备份。\n',
  );
  process.exit(1);
}

if (!confirmed) {
  console.error(
    '\n[需要确认] 该操作会删除所有业务数据。\n' +
      '  确认后请执行：  pnpm --filter @estatepilot/database reset -- --yes\n',
  );
  process.exit(1);
}

const prisma = createPrismaClient({
  connectionString: process.env.DATABASE_URL as string,
  applicationName: 'estatepilot-reset',
});

/**
 * 需要清空的表。
 * 用显式列表而不是「查 pg_tables 后全删」，是为了避免误删扩展表或未来的非业务表。
 */
const TABLES_TO_TRUNCATE = [
  // 行为与画像
  'customer_behavior_events',
  'customer_behavior_profiles',
  'customer_profiles',
  'intent_score_history',
  'consent_logs',
  'customer_share_links',
  // 匹配与机会
  'customer_property_matches',
  'opportunities',
  'notifications',
  // 带看与沟通
  'viewing_properties',
  'viewings',
  'voice_notes',
  'communications',
  // 房源
  'property_price_history',
  'property_provider_records',
  'property_images',
  'properties',
  // 客户
  'favorites',
  'comparisons',
  'tasks',
  'customers',
  // AI
  'ai_messages',
  'ai_conversations',
  'ai_runs',
  // 配置
  'behavior_scoring_rules',
  'property_provider_configs',
  'feature_flags',
  'system_settings',
  // 组织与用户
  'audit_logs',
  'refresh_tokens',
  'users',
  'teams',
  'stores',
  'subscriptions',
  'organizations',
];

async function main(): Promise<void> {
  console.log(`\n数据库重置（NODE_ENV=${nodeEnv}）`);
  console.log('保留表：_prisma_migrations（迁移历史）、pgvector 扩展\n');

  // 先查一遍当前数据量，让操作可追溯
  const before = await prisma.organization.count();
  console.log(`当前组织数：${before}`);

  for (const tableName of TABLES_TO_TRUNCATE) {
    try {
      // 表名来自上面的硬编码列表，不存在 SQL 注入风险
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${tableName}" CASCADE`);
      console.log(`  ✓ ${tableName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 表不存在不算失败（便于在旧版本数据库上运行）
      if (message.includes('does not exist')) {
        console.log(`  - ${tableName}（表不存在，跳过）`);
      } else {
        console.error(`  ✗ ${tableName}：${message.split('\n')[0]}`);
        throw error;
      }
    }
  }

  const after = await prisma.organization.count();
  console.log(`\n重置完成：组织数 ${before} → ${after}`);
  console.log('下一步：pnpm --filter @estatepilot/database seed\n');

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('\n重置失败：', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
