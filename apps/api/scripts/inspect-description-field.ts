/** 查看 description 字段的真实格式，判断能提取出哪些结构化信息。 */

import { createPrismaClient } from '@estatepilot/database';

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

const prisma = createPrismaClient({ connectionString, applicationName: 'inspect-description' });

async function main(): Promise<void> {
  const rows = await prisma.property.findMany({
    take: 6,
    where: { city: '厦门' },
    select: {
      community: true,
      description: true,
      decoration: true,
      floor: true,
      totalFloors: true,
      tags: true,
    },
  });

  console.log('=== description 字段的真实格式 ===\n');

  for (const row of rows) {
    console.log(`小区：${row.community}`);
    console.log(`  decoration=${row.decoration}  floor=${row.floor}  totalFloors=${row.totalFloors}`);
    console.log(`  tags=${JSON.stringify(row.tags)}`);
    console.log('  description:');
    for (const line of String(row.description ?? '').split('\n')) {
      console.log(`    | ${line}`);
    }
    console.log('');
  }

  // 统计所有房源的 description 覆盖率
  const total = await prisma.property.count();
  const withDesc = await prisma.property.count({
    where: { NOT: { description: null } },
  });

  console.log('='.repeat(74));
  console.log(`\ndescription 覆盖率：${withDesc} / ${total}`);

  // 统计 decoration / floor 的填充率
  const withDecoration = await prisma.property.count({ where: { NOT: { decoration: null } } });
  const withFloor = await prisma.property.count({ where: { NOT: { floor: null } } });
  const withTags = await prisma.property.count({ where: { tags: { isEmpty: false } } });
  const withCover = await prisma.property.count({ where: { NOT: { coverImage: null } } });

  console.log(`decoration 覆盖率：${withDecoration} / ${total}`);
  console.log(`floor      覆盖率：${withFloor} / ${total}`);
  console.log(`tags       覆盖率：${withTags} / ${total}`);
  console.log(`coverImage 覆盖率：${withCover} / ${total}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
