/**
 * 修复历史房源的标签碎片。
 *
 * 背景：19 条早期入库的房源，其 rawData 已被后续同步覆盖
 * （只剩下 {source, cachedAt, propertyDbId}），原始文本丢失，无法重新解析。
 * 而它们的标签是旧解析器产生的，含 "月)"、"年)" 这类孤立碎片 ——
 * 来源是 `车位配比1:1.2(租车位地下车位300元/月)` 被按 `/` 切断后丢了开括号。
 *
 * 修复方式：把孤立碎片拼回带未闭合左括号的上一段。
 * 如果找不到可拼的父标签，就丢弃该碎片（它单独存在没有意义）。
 *
 * 用法：node --experimental-strip-types scripts/fix-legacy-tags.ts -- --yes
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes('--yes')) {
    console.error('这会修改数据库中的房源标签。确认请加 --yes');
    process.exit(1);
  }

  const { createPrismaClient } = await import('@estatepilot/database');

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-fix-legacy-tags',
  });

  try {
    /** 需要修复的碎片特征：以右括号结尾但没有左括号，或纯计量单位 */
    const orphanFragmentPattern = /^(?:月\)|年\)|平米\)|元\)|月|年|平米|平方米|平|元|户|个|层|位|套|栋)$/;

    const rows = await prisma.property.findMany({
      select: { id: true, community: true, tags: true },
    });

    console.log(`扫描 ${rows.length} 条房源的标签…\n`);

    let fixed = 0;
    let fragmentsMerged = 0;
    let fragmentsDropped = 0;

    for (const row of rows) {
      if (!row.tags.some((tag) => orphanFragmentPattern.test(tag))) continue;

      const repaired: string[] = [];

      for (const tag of row.tags) {
        if (!orphanFragmentPattern.test(tag)) {
          repaired.push(tag);
          continue;
        }

        // 尝试拼回带未闭合左括号的上一段
        const previous = repaired[repaired.length - 1];
        const previousOpen = previous?.match(/\(/g)?.length ?? 0;
        const previousClose = previous?.match(/\)/g)?.length ?? 0;

        if (previous !== undefined && previousOpen > previousClose) {
          repaired[repaired.length - 1] = `${previous}/${tag}`;
          fragmentsMerged += 1;
        } else {
          // 没有可拼的父标签 → 丢弃（单独一个 "月)" 没有任何意义）
          fragmentsDropped += 1;
        }
      }

      // 去重
      const deduped = [...new Set(repaired)];
      if (deduped.length === 0) continue;

      await prisma.property.update({
        where: { id: row.id },
        data: { tags: deduped },
      });
      fixed += 1;

      if (fixed <= 5) {
        console.log(`${row.community}`);
        console.log(`  修复前: ${JSON.stringify(row.tags.slice(-6))}`);
        console.log(`  修复后: ${JSON.stringify(deduped.slice(-6))}`);
        console.log('');
      }
    }

    console.log(`  修复房源：${fixed} 条`);
    console.log(`  拼接碎片：${fragmentsMerged} 个`);
    console.log(`  丢弃碎片：${fragmentsDropped} 个`);

    // ---- 验证 ----
    const all = await prisma.property.findMany({ select: { tags: true } });
    let remaining = 0;
    let totalTags = 0;

    for (const row of all) {
      totalTags += row.tags.length;
      for (const tag of row.tags) {
        if (orphanFragmentPattern.test(tag)) remaining += 1;
      }
    }

    console.log(`\n=== 验证 ===`);
    console.log(`  标签总数：${totalTags}`);
    console.log(`  残留碎片：${remaining} ${remaining === 0 ? '✓' : '✗'}`);

    console.log('\n完成。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('修复失败：', error);
  process.exit(1);
});
