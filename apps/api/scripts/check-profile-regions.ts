/**
 * 查看客户画像的完整区域字段（排查跨城市残留）。
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-profile-check',
  });

  try {
    const profiles = await prisma.customerRequirementProfile.findMany();

    for (const profile of profiles) {
      const customer = await prisma.customer.findUnique({
        where: { id: profile.customerId },
        select: { name: true },
      });

      console.log('='.repeat(70));
      console.log(`客户: ${customer?.name}  (${profile.customerId})`);
      console.log('='.repeat(70));
      console.log(`  city         = ${profile.city}`);
      console.log(`  districts    = ${JSON.stringify(profile.districts)}`);
      console.log(`  subDistricts = ${JSON.stringify(profile.subDistricts)}`);
      console.log(`  communities  = ${JSON.stringify(profile.communities)}`);
      console.log(`  来源消息数    = ${profile.sourceMessageCount}`);
    }

    console.log('');
    console.log('=== 房源侧的城市/板块分布 ===');
    const props = await prisma.property.groupBy({
      by: ['city', 'district', 'subDistrict'],
      _count: { id: true },
    });
    for (const p of props) {
      console.log(
        `  city=${p.city} district=${String(p.district)} subDistrict=${String(p.subDistrict)} count=${p._count.id}`,
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
