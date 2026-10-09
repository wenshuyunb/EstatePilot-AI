/**
 * 清除种子/演示数据，准备真实上线实测。
 *
 * ============================================================================
 * 设计原则：只删"确认是种子数据"的，保留"真实产生的"
 * ============================================================================
 * 库里并非全是假数据：
 *   ✗ 删除：2,090 套 MOCK 演示房源 + 其 38,000+ 条关联记录
 *   ✗ 删除：300 个种子客户 + 其画像/行为/带看/机会/任务（都是脚本生成的）
 *   ✓ 保留：41 套**真实贝壳房源**（真实调用官方 API 拿到的）
 *   ✓ 保留：唐刚刚 —— 唯一有真实微信消息记录的客户（31 条）
 *   ✓ 保留：组织与登录账号（删了就无法登录）
 *   ✓ 保留：微信闭环的实测产出（需求快照、推荐批次、微信文案）
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *   # 1. 先看会删什么（默认 dry-run，不写库）
 *   node --experimental-strip-types scripts/clean-demo-data.ts
 *
 *   # 2. 确认后真的执行
 *   node --experimental-strip-types scripts/clean-demo-data.ts -- --yes
 *
 * ⚠️ 删除**不可恢复**。执行前请确认已了解影响范围。
 */

import { createPrismaClient } from '@estatepilot/database';

/** 要保留的客户（有真实微信消息记录）—— 自动识别，无需硬编码 */
async function findRealCustomers(
  prisma: ReturnType<typeof createPrismaClient>,
): Promise<Set<string>> {
  const withMessages = await prisma.customerMessageImport.findMany({
    select: { customerId: true },
    distinct: ['customerId'],
  });

  const withFeedback = await prisma.customerPropertyFeedback.findMany({
    select: { customerId: true },
    distinct: ['customerId'],
  });

  const withReplies = await prisma.generatedCustomerReply.findMany({
    select: { customerId: true },
    distinct: ['customerId'],
  });

  const ids = new Set<string>();
  for (const row of [...withMessages, ...withFeedback, ...withReplies]) {
    ids.add(row.customerId);
  }
  return ids;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--yes');

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-clean-demo',
  });

  try {
    console.log(execute ? '⚠️  执行模式：将真实删除数据\n' : '🔍 预览模式（dry-run）：不会修改数据\n');
    console.log('='.repeat(72));

    // ========================================================================
    // 1. 识别要删的数据
    // ========================================================================
    const demoProperties = await prisma.property.findMany({
      where: { externalProvider: 'MOCK' },
      select: { id: true },
    });
    const demoPropertyIds = demoProperties.map((p) => p.id);

    const keepCustomerIds = await findRealCustomers(prisma);
    const seedCustomers = await prisma.customer.findMany({
      where: keepCustomerIds.size > 0 ? { id: { notIn: [...keepCustomerIds] } } : {},
      select: { id: true },
    });
    const seedCustomerIds = seedCustomers.map((c) => c.id);

    console.log('\n【将删除】');
    console.log(`  MOCK 演示房源              ${demoPropertyIds.length}`);
    console.log(`  种子客户                   ${seedCustomerIds.length}`);

    if (keepCustomerIds.size > 0) {
      const kept = await prisma.customer.findMany({
        where: { id: { in: [...keepCustomerIds] } },
        select: { name: true },
      });
      console.log(`\n【将保留的客户】${kept.map((c) => c.name).join('、')}`);
    }

    const keptProperties = await prisma.property.count({
      where: { externalProvider: { not: 'MOCK' } },
    });
    console.log(`\n【将保留】`);
    console.log(`  真实房源（贝壳等）          ${keptProperties}`);
    console.log(`  组织与登录账号              保留`);
    console.log(`  微信闭环实测数据            保留`);

    // ========================================================================
    // 2. 统计关联数据
    // ========================================================================
    console.log('\n【演示房源的关联记录】');

    const propertyRelations = {
      '图片': await prisma.propertyImage.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '价格历史': await prisma.propertyPriceHistory.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '客户-房源匹配': await prisma.customerPropertyMatch.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '行为事件': await prisma.customerBehaviorEvent.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '收藏': await prisma.favorite.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '对比': await prisma.comparison.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '带看-房源': await prisma.viewingProperty.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '销售机会': await prisma.opportunity.count({ where: { propertyId: { in: demoPropertyIds } } }),
      '多源快照': await prisma.propertyProviderRecord.count({ where: { propertyId: { in: demoPropertyIds } } }),
    };

    for (const [name, count] of Object.entries(propertyRelations)) {
      console.log(`  ${name.padEnd(16)} ${count}`);
    }

    console.log('\n【种子客户的关联记录】');

    const customerRelations = {
      '客户画像': await prisma.customerProfile.count({ where: { customerId: { in: seedCustomerIds } } }),
      '行为画像': await prisma.customerBehavioralProfile.count({ where: { customerId: { in: seedCustomerIds } } }),
      '行为事件': await prisma.customerBehaviorEvent.count({ where: { customerId: { in: seedCustomerIds } } }),
      '客户-房源匹配': await prisma.customerPropertyMatch.count({ where: { customerId: { in: seedCustomerIds } } }),
      '收藏': await prisma.favorite.count({ where: { customerId: { in: seedCustomerIds } } }),
      '对比': await prisma.comparison.count({ where: { customerId: { in: seedCustomerIds } } }),
      '带看': await prisma.viewing.count({ where: { customerId: { in: seedCustomerIds } } }),
      '销售机会': await prisma.opportunity.count({ where: { customerId: { in: seedCustomerIds } } }),
      '沟通记录': await prisma.communication.count({ where: { customerId: { in: seedCustomerIds } } }),
      '任务': await prisma.task.count({ where: { customerId: { in: seedCustomerIds } } }),
      '意向分历史': await prisma.intentScoreHistory.count({ where: { customerId: { in: seedCustomerIds } } }),
      '通知': await prisma.notification.count({ where: { customerId: { in: seedCustomerIds } } }),
      '分享链接': await prisma.customerShareLink.count({ where: { customerId: { in: seedCustomerIds } } }),
      '语音笔记': await prisma.voiceNote.count({ where: { customerId: { in: seedCustomerIds } } }),
    };

    for (const [name, count] of Object.entries(customerRelations)) {
      console.log(`  ${name.padEnd(16)} ${count}`);
    }

    const totalToDelete =
      demoPropertyIds.length +
      seedCustomerIds.length +
      Object.values(propertyRelations).reduce((a, b) => a + b, 0) +
      Object.values(customerRelations).reduce((a, b) => a + b, 0);

    console.log('\n' + '='.repeat(72));
    console.log(`\n合计将删除约 ${totalToDelete} 条记录`);

    if (!execute) {
      console.log('\n这是预览模式。确认无误后执行：');
      console.log('  node --experimental-strip-types scripts/clean-demo-data.ts -- --yes\n');
      return;
    }

    // ========================================================================
    // 3. 执行删除（按依赖顺序，叶子先删）
    // ========================================================================
    console.log('\n开始清理…\n');

    const summary: Array<{ step: string; count: number }> = [];

    const run = async (
      step: string,
      fn: () => Promise<{ count: number }>,
    ): Promise<void> => {
      const result = await fn();
      summary.push({ step, count: result.count });
      console.log(`  ✓ ${step.padEnd(28)} 删除 ${result.count}`);
    };

    // ---- 3.1 演示房源的关联（先删叶子，再删主表）----
    if (demoPropertyIds.length > 0) {
      const pid = { propertyId: { in: demoPropertyIds } };

      await run('多源快照记录', () => prisma.propertyProviderRecord.deleteMany({ where: pid }));
      await run('销售机会', () => prisma.opportunity.deleteMany({ where: pid }));
      await run('带看-房源关联', () => prisma.viewingProperty.deleteMany({ where: pid }));
      await run('客户-房源匹配', () => prisma.customerPropertyMatch.deleteMany({ where: pid }));
      await run('行为事件', () => prisma.customerBehaviorEvent.deleteMany({ where: pid }));
      await run('收藏', () => prisma.favorite.deleteMany({ where: pid }));
      await run('对比', () => prisma.comparison.deleteMany({ where: pid }));
      await run('价格历史', () => prisma.propertyPriceHistory.deleteMany({ where: pid }));
      await run('房源图片', () => prisma.propertyImage.deleteMany({ where: pid }));
    }

    // ---- 3.2 种子客户的关联 ----
    if (seedCustomerIds.length > 0) {
      const cid = { customerId: { in: seedCustomerIds } };

      await run('通知', () => prisma.notification.deleteMany({ where: cid }));
      await run('任务', () => prisma.task.deleteMany({ where: cid }));
      await run('沟通记录', () => prisma.communication.deleteMany({ where: cid }));
      await run('语音笔记', () => prisma.voiceNote.deleteMany({ where: cid }));
      await run('分享链接', () => prisma.customerShareLink.deleteMany({ where: cid }));
      await run('意向分历史', () => prisma.intentScoreHistory.deleteMany({ where: cid }));
      await run('带看记录', () => prisma.viewing.deleteMany({ where: cid }));
      await run('客户-房源匹配', () => prisma.customerPropertyMatch.deleteMany({ where: cid }));
      await run('行为事件', () => prisma.customerBehaviorEvent.deleteMany({ where: cid }));
      await run('收藏', () => prisma.favorite.deleteMany({ where: cid }));
      await run('对比', () => prisma.comparison.deleteMany({ where: cid }));
      await run('行为画像', () => prisma.customerBehavioralProfile.deleteMany({ where: cid }));
      await run('客户画像', () => prisma.customerProfile.deleteMany({ where: cid }));
    }

    // ---- 3.3 主表 ----
    if (demoPropertyIds.length > 0) {
      await run(
        '演示房源',
        () => prisma.property.deleteMany({ where: { externalProvider: 'MOCK' } }),
      );
    }

    if (seedCustomerIds.length > 0) {
      await run(
        '种子客户',
        () => prisma.customer.deleteMany({ where: { id: { in: seedCustomerIds } } }),
      );
    }

    // ========================================================================
    // 4. 验证结果
    // ========================================================================
    console.log('\n' + '='.repeat(72));
    console.log('\n【清理后状态】');

    const remaining = {
      '房源总数': await prisma.property.count(),
      '  其中真实来源': await prisma.property.count({ where: { externalProvider: { not: 'MOCK' } } }),
      '  其中演示数据': await prisma.property.count({ where: { externalProvider: 'MOCK' } }),
      '客户总数': await prisma.customer.count(),
      '组织': await prisma.organization.count(),
      '登录账号': await prisma.user.count(),
      '微信消息导入': await prisma.customerMessageImport.count(),
      '需求快照': await prisma.customerRequirementSnapshot.count(),
      '推荐批次': await prisma.recommendationBatch.count(),
    };

    for (const [name, count] of Object.entries(remaining)) {
      console.log(`  ${name.padEnd(18)} ${count}`);
    }

    const demoLeft = remaining['  其中演示数据'];
    console.log(
      demoLeft === 0
        ? '\n  ✓ 演示数据已全部清除'
        : `\n  ✗ 仍有 ${demoLeft} 条演示数据`,
    );

    console.log('\n完成。现在系统里只剩真实数据 —— 可以开始实测了。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('清理失败：', error);
  process.exit(1);
});
