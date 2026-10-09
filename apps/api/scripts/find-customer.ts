/**
 * 查询指定姓名的客户 ID（供端到端测试使用）。
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const name = process.argv[2] ?? '';

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-find-customer',
  });

  try {
    const customers = await prisma.customer.findMany({
      where: name ? { name } : {},
      select: { id: true, name: true, preferredCity: true, phone: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    for (const c of customers) {
      console.log(`${c.id}|${c.name}|${c.preferredCity}|${c.phone}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
