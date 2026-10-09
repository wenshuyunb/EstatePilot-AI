/**
 * 检查本地缓存的贝壳房源（用于本地降级检索）。
 *
 * 用法：node --experimental-strip-types scripts/check-cached-properties.ts
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-check-cache',
  });

  try {
    const total = await prisma.property.count({ where: { externalProvider: 'BEIKE' } });
    console.log(`本地缓存的贝壳房源：${total} 套\n`);

    const rows = await prisma.property.findMany({
      where: { externalProvider: 'BEIKE' },
      select: {
        community: true,
        district: true,
        subDistrict: true,
        bedrooms: true,
        totalPrice: true,
        area: true,
        buildYear: true,
        subwayDistance: true,
        listingStatus: true,
        lastSyncedAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });

    console.log('最近更新的房源：\n');
    for (const row of rows) {
      console.log(
        `  ${(row.community ?? '?').padEnd(18)} ` +
          `${row.district || '?'}/${row.subDistrict || '?'} ` +
          `${row.bedrooms}房 ${row.area}㎡ ${Number(row.totalPrice) / 10000}万 ` +
          `${row.buildYear ?? '?'}年 地铁${row.subwayDistance ?? '—'}米 ` +
          `状态=${row.listingStatus} ` +
          `同步=${row.lastSyncedAt ? row.lastSyncedAt.toISOString().slice(0, 16) : '未记录'}`,
      );
    }

    // 检查可用的筛选条件覆盖度（决定本地检索能力）
    const withDistrict = await prisma.property.count({
      where: { externalProvider: 'BEIKE', NOT: { district: '' } },
    });
    const withSubway = await prisma.property.count({
      where: { externalProvider: 'BEIKE', NOT: { subwayDistance: null } },
    });
    const withImages = await prisma.property.count({
      where: { externalProvider: 'BEIKE', images: { some: {} } },
    });
    const active = await prisma.property.count({
      where: { externalProvider: 'BEIKE', listingStatus: 'ACTIVE' },
    });

    console.log('\n字段完整度（本地检索能力）：');
    console.log(`  有行政区：${withDistrict}/${total}`);
    console.log(`  有地铁距离：${withSubway}/${total}`);
    console.log(`  有图片：${withImages}/${total}`);
    console.log(`  在售状态：${active}/${total}`);

    // 行政区分布
    const byDistrict = await prisma.property.groupBy({
      by: ['district'],
      where: { externalProvider: 'BEIKE' },
      _count: { _all: true },
    });
    console.log('\n行政区分布：');
    for (const item of byDistrict) {
      console.log(`  ${item.district || '(空)'}：${item._count._all} 套`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
