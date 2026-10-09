/**
 * 删除测试客户（连同其全部关联数据）。
 *
 * 用途：实测过程中创建的临时客户会污染 E2E 测试（测试用"列表第一位客户"，
 * 若它的需求画像被改成别的城市，看似无关的用例会莫名其妙失败）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/delete-test-customers.ts            # 预览
 *   node --experimental-strip-types scripts/delete-test-customers.ts -- --yes   # 执行
 *   node --experimental-strip-types scripts/delete-test-customers.ts -- --yes 姓名1 姓名2
 */

import { createPrismaClient } from '@estatepilot/database';

const DEFAULT_NAMES = ['陈女士', '林先生', '郑先生', '王先生'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--yes');
  const names = args.filter((arg) => !arg.startsWith('--'));
  const targets = names.length > 0 ? names : DEFAULT_NAMES;

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-delete-test-customers',
  });

  try {
    const customers = await prisma.customer.findMany({
      where: { name: { in: targets } },
      select: { id: true, name: true },
    });

    console.log(execute ? '⚠️  执行模式\n' : '🔍 预览模式（不会修改数据）\n');
    console.log(`目标客户：${customers.map((c) => c.name).join('、') || '(无匹配)'}`);

    if (customers.length === 0) return;

    const ids = customers.map((c) => c.id);

    if (!execute) {
      console.log('\n将删除这些客户及其全部关联数据（微信消息、需求画像、推荐批次等）。');
      console.log('确认后执行：node --experimental-strip-types scripts/delete-test-customers.ts -- --yes');
      return;
    }

    console.log('\n开始清理…');

    const summary: Array<[string, number]> = [];
    const run = async (label: string, fn: () => Promise<{ count: number }>): Promise<void> => {
      const result = await fn();
      summary.push([label, result.count]);
      if (result.count > 0) console.log(`  ✓ ${label.padEnd(20)} ${result.count}`);
    };

    const cid = { customerId: { in: ids } };

    // 先删叶子（有外键依赖的），再删客户
    await run('生成的文案', () => prisma.generatedCustomerReply.deleteMany({ where: cid }));
    await run('推荐批次', () => prisma.recommendationBatch.deleteMany({ where: cid }));
    await run('客户反馈', () => prisma.customerPropertyFeedback.deleteMany({ where: cid }));
    await run('需求快照', () => prisma.customerRequirementSnapshot.deleteMany({ where: cid }));
    await run('需求画像', () => prisma.customerRequirementProfile.deleteMany({ where: cid }));
    await run('粘贴消息', () => prisma.customerMessageImport.deleteMany({ where: cid }));
    await run('通知', () => prisma.notification.deleteMany({ where: cid }));
    await run('任务', () => prisma.task.deleteMany({ where: cid }));
    await run('沟通记录', () => prisma.communication.deleteMany({ where: cid }));
    await run('带看记录', () => prisma.viewing.deleteMany({ where: cid }));
    await run('销售机会', () => prisma.opportunity.deleteMany({ where: cid }));
    await run('客户-房源匹配', () => prisma.customerPropertyMatch.deleteMany({ where: cid }));
    await run('行为事件', () => prisma.customerBehaviorEvent.deleteMany({ where: cid }));
    await run('收藏', () => prisma.favorite.deleteMany({ where: cid }));
    await run('对比', () => prisma.comparison.deleteMany({ where: cid }));
    await run('行为画像', () => prisma.customerBehavioralProfile.deleteMany({ where: cid }));
    await run('客户画像', () => prisma.customerProfile.deleteMany({ where: cid }));
    await run('客户', () => prisma.customer.deleteMany({ where: { id: { in: ids } } }));

    console.log('\n剩余客户：');
    const remaining = await prisma.customer.findMany({ select: { name: true } });
    console.log(`  ${remaining.map((c) => c.name).join('、')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
