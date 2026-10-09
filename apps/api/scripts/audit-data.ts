/**
 * 数据盘点：区分「真实数据」与「种子/演示数据」。
 *
 * 为什么必须先盘点再删：
 *   库里的数据并非全是假的。例如：
 *     - 41 套贝壳房源是**真实调用官方 API 拿到的**
 *     - 部分客户/行为事件是实测闭环时产生的
 *   盲目清库会把这些一起删掉，而且**不可恢复**。
 *
 * 用法：node --experimental-strip-types scripts/audit-data.ts
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-audit',
  });

  try {
    console.log('数据盘点：真实 vs 种子/演示\n');
    console.log('='.repeat(72));

    // ========================================================================
    // 房源：按来源分类
    // ========================================================================
    console.log('\n【房源】按数据来源');

    const byProvider = await prisma.property.groupBy({
      by: ['externalProvider'],
      _count: { _all: true },
    });

    let realPropertyCount = 0;
    let demoPropertyCount = 0;

    for (const item of byProvider) {
      const isDemo = item.externalProvider === 'MOCK';
      if (isDemo) demoPropertyCount += item._count._all;
      else realPropertyCount += item._count._all;

      const label = isDemo ? '  ⚠ 演示数据（必须删）' : '  ✓ 真实来源（保留）';
      console.log(`  ${item.externalProvider.padEnd(12)} ${String(item._count._all).padStart(6)}  ${label}`);
    }

    console.log(`\n  真实房源合计: ${realPropertyCount}`);
    console.log(`  演示房源合计: ${demoPropertyCount}`);

    // 演示房源的关联数据
    if (demoPropertyCount > 0) {
      const demoIds = (
        await prisma.property.findMany({
          where: { externalProvider: 'MOCK' },
          select: { id: true },
        })
      ).map((p) => p.id);

      console.log('\n  演示房源产生的关联数据：');
      const relCounts = {
        图片: await prisma.propertyImage.count({ where: { propertyId: { in: demoIds } } }),
        价格历史: await prisma.propertyPriceHistory.count({ where: { propertyId: { in: demoIds } } }),
        客户匹配: await prisma.customerPropertyMatch.count({ where: { propertyId: { in: demoIds } } }),
        行为事件: await prisma.customerBehaviorEvent.count({ where: { propertyId: { in: demoIds } } }),
        收藏: await prisma.favorite.count({ where: { propertyId: { in: demoIds } } }),
        对比: await prisma.comparison.count({ where: { propertyId: { in: demoIds } } }),
        带看关联: await prisma.viewingProperty.count({ where: { propertyId: { in: demoIds } } }),
        机会: await prisma.opportunity.count({ where: { propertyId: { in: demoIds } } }),
      };
      for (const [name, count] of Object.entries(relCounts)) {
        console.log(`    ${name.padEnd(12)} ${count}`);
      }
    }

    // ========================================================================
    // 客户：区分种子客户与真实测试客户
    // ========================================================================
    console.log('\n' + '='.repeat(72));
    console.log('\n【客户】');

    const totalCustomers = await prisma.customer.count();
    console.log(`  客户总数: ${totalCustomers}`);

    // 有真实闭环数据的客户 = 被实测过的
    const messageImports = await prisma.customerMessageImport.groupBy({
      by: ['customerId'],
      _count: { _all: true },
    });

    console.log(`  有微信消息导入记录的客户: ${messageImports.length}`);
    for (const item of messageImports) {
      const customer = await prisma.customer.findUnique({
        where: { id: item.customerId },
        select: { name: true },
      });
      console.log(`    · ${customer?.name ?? item.customerId}  （${item._count._all} 条消息）`);
    }

    // ========================================================================
    // 行为事件：判断是否为真实埋点
    // ========================================================================
    console.log('\n' + '='.repeat(72));
    console.log('\n【客户行为事件】');

    const behaviorByType = await prisma.customerBehaviorEvent.groupBy({
      by: ['eventType'],
      _count: { _all: true },
    });
    for (const item of behaviorByType) {
      console.log(`  ${item.eventType.padEnd(24)} ${item._count._all}`);
    }

    // ========================================================================
    // 组织与用户
    // ========================================================================
    console.log('\n' + '='.repeat(72));
    console.log('\n【组织与账号】');

    const orgs = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        _count: { select: { users: true, customers: true, properties: true } },
      },
    });

    for (const org of orgs) {
      console.log(
        `  ${org.isActive ? '✓' : '✗'} ${org.name.padEnd(20)} ` +
          `用户 ${String(org._count.users).padStart(3)}  ` +
          `客户 ${String(org._count.customers).padStart(4)}  ` +
          `房源 ${String(org._count.properties).padStart(5)}`,
      );
    }

    // 账号清单（保留才能登录测试）
    console.log('\n  登录账号：');
    const users = await prisma.user.findMany({
      select: { email: true, name: true, role: true, status: true },
      orderBy: { email: 'asc' },
      take: 12,
    });
    for (const user of users) {
      console.log(`    ${user.email.padEnd(34)} ${user.name.padEnd(10)} ${user.role}`);
    }
    const totalUsers = await prisma.user.count();
    if (totalUsers > users.length) {
      console.log(`    …（共 ${totalUsers} 个账号）`);
    }

    // ========================================================================
    // 微信闭环数据
    // ========================================================================
    console.log('\n' + '='.repeat(72));
    console.log('\n【微信闭环数据】');

    const closedLoop = {
      消息导入: await prisma.customerMessageImport.count(),
      需求画像: await prisma.customerRequirementProfile.count(),
      需求快照: await prisma.customerRequirementSnapshot.count(),
      推荐批次: await prisma.recommendationBatch.count(),
      微信文案: await prisma.generatedCustomerReply.count(),
    };
    for (const [name, count] of Object.entries(closedLoop)) {
      console.log(`  ${name.padEnd(16)} ${count}`);
    }

    // ========================================================================
    // 清理预览
    // ========================================================================
    console.log('\n' + '='.repeat(72));
    console.log('\n【清理预览】如果删除所有演示数据，将影响：');
    console.log(`  · 房源        -${demoPropertyCount}（保留 ${realPropertyCount} 套真实房源）`);
    console.log('  · 连同其图片、价格历史、客户匹配、行为事件等关联记录');
    console.log('\n【建议保留】');
    console.log(`  · ${realPropertyCount} 套真实贝壳房源`);
    console.log('  · 组织与用户账号（否则无法登录测试）');
    console.log('  · 微信闭环实测数据（这是真实的测试产出）');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
