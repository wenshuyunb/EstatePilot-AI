/**
 * 清理房源数据中的占位符脏值。
 *
 * 背景：早期实现用 "待补充" 作为 district 的缺省值，
 * 导致大量房源的区域字段被写成这个字符串（而不是留空）。
 * 这会让"区域待确认"的判断失效，也污染按区域统计的数据。
 *
 * 处理：把 "待补充" 一律改为空字符串，让界面走"区域待确认"分支。
 * 下次从贝壳同步时会自动补回真实区域（upsert 的空值保护会保留新写入的真实值）。
 *
 * 用法：node --experimental-strip-types scripts/clean-placeholder-values.ts -- --yes
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes('--yes')) {
    console.error('这会修改数据库中的房源记录。确认请加 --yes');
    process.exit(1);
  }

  const { createPrismaClient } = await import('@estatepilot/database');

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-clean-placeholders',
  });

  try {
    console.log('清理占位符脏值…\n');

    // 统计现状
    const affected = await prisma.property.count({ where: { district: '待补充' } });
    console.log(`  district = "待补充" 的房源：${affected} 条`);

    if (affected > 0) {
      const updated = await prisma.property.updateMany({
        where: { district: '待补充' },
        data: { district: '' },
      });
      console.log(`  已清理：${updated.count} 条`);
    }

    // 说明：district 为空的记录**保留为空**，不做任何填充。
    //   空值让界面走"区域待确认"分支（诚实），
    //   而塞入占位符会污染按区域统计与区域匹配打分。
    //   下次从贝壳同步（微信助手或房源同步）时会自动补回真实区域。
    const stillEmpty = await prisma.property.count({ where: { district: '' } });
    console.log(`\n  district 为空（等待下次同步补全）的房源：${stillEmpty} 条`);

    if (stillEmpty > 0) {
      const withSubDistrict = await prisma.property.count({
        where: { district: '', NOT: { subDistrict: null } },
      });
      console.log(`  其中 ${withSubDistrict} 条有板块信息（界面会显示板块而非"待确认"）`);

      const noInfo = await prisma.property.count({
        where: { district: '', subDistrict: null },
      });
      console.log(`  剩 ${noInfo} 条完全没有区域信息（界面显示"区域待确认"）`);
    }

    console.log('\n完成。下次运行微信助手或房源同步时会自动补回真实区域。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('清理失败：', error);
  process.exit(1);
});
