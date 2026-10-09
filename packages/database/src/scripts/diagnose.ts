/**
 * 数据诊断脚本。
 *
 * 用途：seed 之后快速核对数据库里的真实数据分布，
 * 确认「Dashboard 一打开就有内容」这个目标达成，
 * 并发现种子数据是否符合预期（而不是靠肉眼看日志猜）。
 *
 * 用法：pnpm --filter @estatepilot/database exec tsx src/scripts/diagnose.ts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

const { createPrismaClient } = await import('../client.js');

const prisma = createPrismaClient({
  connectionString: process.env.DATABASE_URL as string,
  applicationName: 'estatepilot-diagnose',
});

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** 简单表格输出 */
function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log('  （无数据）');
    return;
  }
  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...rows.map((row) => String(row[column] ?? '').length),
    ),
  );
  console.log(`  ${columns.map((column, i) => column.padEnd(widths[i]!)).join('  ')}`);
  console.log(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
  for (const row of rows) {
    console.log(
      `  ${columns.map((column, i) => String(row[column] ?? '').padEnd(widths[i]!)).join('  ')}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('EstatePilot AI 数据诊断');

  // ---- 组织 ----
  section('组织');
  const organizations = await prisma.organization.findMany({
    select: {
      id: true,
      name: true,
      shortName: true,
      createdAt: true,
      _count: { select: { stores: true, users: true, customers: true, properties: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  table(
    organizations.map((org) => ({
      组织: org.shortName ?? org.name,
      门店: org._count.stores,
      用户: org._count.users,
      客户: org._count.customers,
      房源: org._count.properties,
      创建时间: org.createdAt.toISOString().slice(0, 19),
    })),
  );

  // ---- 各表总量 ----
  section('数据总量');
  const counts = {
    organizations: await prisma.organization.count(),
    stores: await prisma.store.count(),
    teams: await prisma.team.count(),
    users: await prisma.user.count(),
    subscriptions: await prisma.subscription.count(),
    customers: await prisma.customer.count(),
    customerProfiles: await prisma.customerProfile.count(),
    behavioralProfiles: await prisma.customerBehavioralProfile.count(),
    behaviorEvents: await prisma.customerBehaviorEvent.count(),
    shareLinks: await prisma.customerShareLink.count(),
    properties: await prisma.property.count(),
    propertyImages: await prisma.propertyImage.count(),
    priceHistory: await prisma.propertyPriceHistory.count(),
    matches: await prisma.customerPropertyMatch.count(),
    favorites: await prisma.favorite.count(),
    comparisons: await prisma.comparison.count(),
    viewings: await prisma.viewing.count(),
    viewingProperties: await prisma.viewingProperty.count(),
    communications: await prisma.communication.count(),
    opportunities: await prisma.opportunity.count(),
    notifications: await prisma.notification.count(),
    scoringRules: await prisma.behaviorScoringRule.count(),
    featureFlags: await prisma.featureFlag.count(),
    auditLogs: await prisma.auditLog.count(),
  };
  table(Object.entries(counts).map(([表, 数量]) => ({ 表, 数量 })));

  // ---- 房源分布 ----
  section('房源区域分布');
  const byDistrict = await prisma.property.groupBy({
    by: ['district'],
    _count: { _all: true },
    _avg: { unitPrice: true },
    orderBy: { _count: { district: 'desc' } },
  });
  table(
    byDistrict.map((row) => ({
      区域: row.district,
      房源数: row._count._all,
      平均单价: Math.round(row._avg.unitPrice ?? 0).toLocaleString('zh-CN'),
    })),
  );

  const communityCount = await prisma.property.findMany({
    select: { community: true },
    distinct: ['community'],
  });
  console.log(`  小区数：${communityCount.length}`);

  // ---- 房源价格区间 ----
  section('房源价格区间（万元）');
  const priceStats = await prisma.property.aggregate({
    _min: { totalPrice: true },
    _max: { totalPrice: true },
    _avg: { totalPrice: true },
  });
  console.log(
    `  最低 ${Number(priceStats._min.totalPrice ?? 0) / 10000} 万 ｜ ` +
      `最高 ${Number(priceStats._max.totalPrice ?? 0) / 10000} 万 ｜ ` +
      `平均 ${Math.round(Number(priceStats._avg.totalPrice ?? 0) / 10000)} 万`,
  );

  // ---- 行为事件类型分布 ----
  section('行为事件类型分布');
  const byEventType = await prisma.customerBehaviorEvent.groupBy({
    by: ['eventType'],
    _count: { _all: true },
    orderBy: { _count: { eventType: 'desc' } },
  });
  table(
    byEventType.slice(0, 12).map((row) => ({
      事件类型: row.eventType,
      次数: row._count._all,
    })),
  );
  console.log(`  （共 ${byEventType.length} 种事件类型）`);

  // ---- 客户状态分布 ----
  section('客户状态分布');
  const byStatus = await prisma.customer.groupBy({
    by: ['status'],
    _count: { _all: true },
    orderBy: { _count: { status: 'desc' } },
  });
  table(byStatus.map((row) => ({ 状态: row.status, 客户数: row._count._all })));

  // ---- 机会分布 ----
  section('销售机会');
  const byOpportunityType = await prisma.opportunity.groupBy({
    by: ['type'],
    _count: { _all: true },
    _avg: { valueScore: true },
    orderBy: { _count: { type: 'desc' } },
  });
  table(
    byOpportunityType.map((row) => ({
      类型: row.type,
      数量: row._count._all,
      平均价值分: Math.round(row._avg.valueScore ?? 0),
    })),
  );

  const opportunityStatus = await prisma.opportunity.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  table(opportunityStatus.map((row) => ({ 状态: row.status, 数量: row._count._all })));

  // ---- 有真实行为轨迹的客户（用于验证「点进去有内容」）----
  section('数据完整性抽查');
  const customersWithBehavior = await prisma.customer.count({
    where: { behaviorEventCount: { gt: 0 } },
  });
  const customersWithProfile = await prisma.customerBehavioralProfile.count();
  const customersWithMatches = await prisma.customerPropertyMatch.findMany({
    select: { customerId: true },
    distinct: ['customerId'],
  });
  const customersWithViewings = await prisma.viewing.findMany({
    select: { customerId: true },
    distinct: ['customerId'],
  });

  console.log(`  客户总数：              ${counts.customers}`);
  console.log(`  有行为事件的客户：      ${customersWithBehavior}`);
  console.log(`  有行为画像的客户：      ${customersWithProfile}`);
  console.log(`  有匹配记录的客户：      ${customersWithMatches.length}`);
  console.log(`  有带看记录的客户：      ${customersWithViewings.length}`);

  // ---- 经纪人负载 ----
  section('经纪人客户负载（前 8）');
  const agentLoad = await prisma.user.findMany({
    where: { role: 'AGENT' },
    select: {
      name: true,
      _count: { select: { customers: true, viewings: true } },
    },
    orderBy: { customers: { _count: 'desc' } },
    take: 8,
  });
  table(
    agentLoad.map((agent) => ({
      经纪人: agent.name,
      负责客户: agent._count.customers,
      带看次数: agent._count.viewings,
    })),
  );

  // ---- 演示账号 ----
  section('演示账号');
  const demoAccounts = await prisma.user.findMany({
    where: { email: { endsWith: '@estatepilot.demo' } },
    select: { email: true, name: true, role: true, organization: { select: { shortName: true } } },
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
    take: 12,
  });
  table(
    demoAccounts.map((user) => ({
      邮箱: user.email,
      姓名: user.name,
      角色: user.role,
      组织: user.organization.shortName ?? '',
    })),
  );
  console.log(`  （共 ${await prisma.user.count({ where: { email: { endsWith: '@estatepilot.demo' } } })} 个演示账号）`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('诊断失败：', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
