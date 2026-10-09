/**
 * 检查贝壳房源在数据库中的字段完整度。
 *
 * 用法：node --experimental-strip-types scripts/check-property-data.ts
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-check-properties',
  });

  try {
    const rows = await prisma.property.findMany({
      where: { externalProvider: 'BEIKE' },
      select: {
        community: true,
        district: true,
        subDistrict: true,
        totalPrice: true,
        buildYear: true,
        subwayDistance: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 12,
    });

    console.log('最近更新的贝壳房源：\n');
    for (const row of rows) {
      console.log(
        `  ${(row.community ?? '?').padEnd(20)} ` +
          `district=${JSON.stringify(row.district)} ` +
          `sub=${JSON.stringify(row.subDistrict)} ` +
          `${Number(row.totalPrice) / 10000}万 ` +
          `${row.buildYear ?? '?'}年 ` +
          `地铁${row.subwayDistance ?? '—'}米`,
      );
    }

    const total = await prisma.property.count({ where: { externalProvider: 'BEIKE' } });
    const emptyDistrict = await prisma.property.count({
      where: { externalProvider: 'BEIKE', district: '' },
    });
    const emptySub = await prisma.property.count({
      where: { externalProvider: 'BEIKE', subDistrict: null },
    });

    console.log(`\n贝壳房源总数：${total}`);
    console.log(`  district 为空：${emptyDistrict}`);
    console.log(`  subDistrict 为空：${emptySub}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
