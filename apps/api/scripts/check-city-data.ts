/**
 * 最小化排查：Prisma groupBy 在城市字段上的行为。
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-minimal',
  });

  try {
    console.log('=== 房源总数 ===');
    console.log('  ' + (await prisma.property.count()));

    console.log('');
    console.log('=== 按 city 分组 ===');
    const byCity = await prisma.property.groupBy({
      by: ['city'],
      _count: { id: true },
    });
    for (const row of byCity) {
      console.log(`  city=${row.city} count=${row._count.id}`);
    }

    console.log('');
    console.log('=== 按 city + externalProvider 分组 ===');
    const byCityProvider = await prisma.property.groupBy({
      by: ['city', 'externalProvider'],
      _count: { id: true },
    });
    for (const row of byCityProvider) {
      console.log(`  city=${row.city} provider=${row.externalProvider} count=${row._count.id}`);
    }

    console.log('');
    console.log('=== 按 city + district 分组（只看真实来源）===');
    const byDistrict = await prisma.property.groupBy({
      by: ['city', 'district'],
      where: { externalProvider: { not: 'MOCK' } },
      _count: { id: true },
    });
    for (const row of byDistrict) {
      console.log(`  city=${row.city} district=${row.district} count=${row._count.id}`);
    }

    console.log('');
    console.log('=== 客户需求画像 ===');
    const profiles = await prisma.customerRequirementProfile.findMany({
      select: { customerId: true, city: true, districts: true },
    });
    for (const profile of profiles) {
      const customer = await prisma.customer.findUnique({
        where: { id: profile.customerId },
        select: { name: true },
      });
      console.log(
        `  ${customer?.name} city=${profile.city} districts=${JSON.stringify(profile.districts)}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
