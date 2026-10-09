/**
 * 项目全景数据统计（用于生成项目报告）。
 *
 * 用法：node --experimental-strip-types scripts/stats-overview.ts
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-stats',
  });

  const count = async (label: string, fn: () => Promise<number>): Promise<void> => {
    try {
      const value = await fn();
      console.log(`  ${label.padEnd(30, '.')} ${value}`);
    } catch (error) {
      console.log(`  ${label.padEnd(30, '.')} 查询失败`);
    }
  };

  try {
    console.log('=== 组织与用户 ===');
    await count('组织', () => prisma.organization.count());
    await count('门店', () => prisma.store.count());
    await count('团队', () => prisma.team.count());
    await count('用户', () => prisma.user.count());

    console.log('\n=== 客户域 ===');
    await count('客户', () => prisma.customer.count());
    await count('客户画像', () => prisma.customerProfile.count());
    await count('行为事件', () => prisma.customerBehaviorEvent.count());
    await count('行为画像', () => prisma.customerBehavioralProfile.count());
    await count('意向分历史', () => prisma.intentScoreHistory.count());
    await count('客户-房源匹配', () => prisma.customerPropertyMatch.count());

    console.log('\n=== 房源域 ===');
    await count('房源总数', () => prisma.property.count());
    await count('  贝壳来源', () =>
      prisma.property.count({ where: { externalProvider: 'BEIKE' } }),
    );
    await count('  在售状态', () =>
      prisma.property.count({ where: { listingStatus: 'ACTIVE' } }),
    );
    await count('  有图片', () =>
      prisma.property.count({ where: { images: { some: {} } } }),
    );
    await count('房源图片', () => prisma.propertyImage.count());
    await count('价格历史', () => prisma.propertyPriceHistory.count());

    console.log('\n=== 交易域 ===');
    await count('销售机会', () => prisma.opportunity.count());
    await count('带看记录', () => prisma.viewing.count());
    await count('带看-房源关联', () => prisma.viewingProperty.count());
    await count('收藏', () => prisma.favorite.count());
    await count('对比', () => prisma.comparison.count());
    await count('任务', () => prisma.task.count());
    await count('沟通记录', () => prisma.communication.count());
    await count('通知', () => prisma.notification.count());

    console.log('\n=== 微信闭环（Phase 11）===');
    await count('消息导入', () => prisma.customerMessageImport.count());
    await count('需求画像', () => prisma.customerRequirementProfile.count());
    await count('需求快照(版本历史)', () => prisma.customerRequirementSnapshot.count());
    await count('推荐批次', () => prisma.recommendationBatch.count());
    await count('生成的微信文案', () => prisma.generatedCustomerReply.count());
    await count('房源反馈', () => prisma.customerPropertyFeedback.count());

    console.log('\n=== 多源架构（新增能力）===');
    await count('多源快照记录', () => prisma.propertyProviderRecord.count());
    await count('数据源配置', () => prisma.propertyProviderConfig.count());

    console.log('\n=== AI 调用 ===');
    await count('AI 会话', () => prisma.aiConversation.count());
    await count('AI 消息', () => prisma.aiMessage.count());
    await count('AI 运行记录', () => prisma.aiRun.count());

    console.log('\n=== 系统与安全 ===');
    await count('功能开关', () => prisma.featureFlag.count());
    await count('系统设置', () => prisma.systemSetting.count());
    await count('审计日志', () => prisma.auditLog.count());
    await count('同意记录', () => prisma.consentLog.count());
    await count('刷新令牌', () => prisma.refreshToken.count());

    // 房源来源分布
    console.log('\n=== 房源来源分布 ===');
    const byProvider = await prisma.property.groupBy({
      by: ['externalProvider'],
      _count: { _all: true },
    });
    for (const item of byProvider) {
      console.log(`  ${item.externalProvider.padEnd(30, '.')} ${item._count._all}`);
    }

    // 房源状态分布
    console.log('\n=== 房源状态分布 ===');
    const byStatus = await prisma.property.groupBy({
      by: ['listingStatus'],
      _count: { _all: true },
    });
    for (const item of byStatus) {
      console.log(`  ${item.listingStatus.padEnd(30, '.')} ${item._count._all}`);
    }

    // 行政区分布
    console.log('\n=== 房源行政区分布 ===');
    const byDistrict = await prisma.property.groupBy({
      by: ['district'],
      _count: { _all: true },
    });
    for (const item of byDistrict) {
      console.log(`  ${(item.district || '(空)').padEnd(30, '.')} ${item._count._all}`);
    }

    // 意向等级分布
    console.log('\n=== 客户意向等级分布 ===');
    const byIntent = await prisma.customer.groupBy({
      by: ['intentLevel'],
      _count: { _all: true },
    });
    for (const item of byIntent) {
      console.log(`  ${(item.intentLevel ?? '(未评分)').padEnd(30, '.')} ${item._count._all}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
