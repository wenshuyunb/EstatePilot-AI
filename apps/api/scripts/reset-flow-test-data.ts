/**
 * 重置闭环测试数据。
 *
 * 用途：反复跑 verify-wechat-flow.ts 时，清掉上一次的需求画像/快照/消息/推荐记录，
 * 让每次测试都从干净基线开始（否则"三级预算演进"这类断言会被历史数据污染）。
 *
 * 安全性：
 *   - 只清理**指定客户**的闭环数据，不动客户本身
 *   - 不影响 properties（房源是共享的，重复入库本来就是幂等的）
 *   - 需要显式传 --yes 才执行
 *
 * 用法：
 *   node --experimental-strip-types scripts/reset-flow-test-data.ts -- --yes <customerId>
 */

import { createPrismaClient } from '@estatepilot/database';

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const customerId = args.find((arg) => !arg.startsWith('--') && arg !== '--yes');

async function main(): Promise<void> {
  if (!confirmed) {
    console.error('这会删除指定客户的闭环测试数据。确认请加 --yes');
    process.exit(1);
  }

  if (!customerId) {
    console.error('请提供 customerId');
    process.exit(1);
  }

  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  const prisma = createPrismaClient({
    connectionString: databaseUrl,
    applicationName: 'estatepilot-reset-flow-test',
  });

  try {
    console.log(`清理客户 ${customerId} 的闭环测试数据…\n`);

    // 顺序很重要：先删子表再删父表（外键约束）
    const feedback = await prisma.customerPropertyFeedback.deleteMany({ where: { customerId } });
    console.log(`  客户反馈：删除 ${feedback.count} 条`);

    const replies = await prisma.generatedCustomerReply.deleteMany({ where: { customerId } });
    console.log(`  生成的文案：删除 ${replies.count} 条`);

    const batches = await prisma.recommendationBatch.deleteMany({ where: { customerId } });
    console.log(`  推荐批次：删除 ${batches.count} 条`);

    const snapshots = await prisma.customerRequirementSnapshot.deleteMany({ where: { customerId } });
    console.log(`  需求快照：删除 ${snapshots.count} 条`);

    // 消息表有 snapshotId 引用（仅字符串，无外键），先清空引用再删
    const messages = await prisma.customerMessageImport.deleteMany({ where: { customerId } });
    console.log(`  粘贴消息：删除 ${messages.count} 条`);

    const profiles = await prisma.customerRequirementProfile.deleteMany({ where: { customerId } });
    console.log(`  需求画像：删除 ${profiles.count} 条`);

    console.log('\n完成。下次运行 verify-wechat-flow.ts 将从干净基线开始。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('重置失败：', error);
  process.exit(1);
});
