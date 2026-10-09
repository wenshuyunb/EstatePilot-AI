/**
 * 从原始响应重新解析并刷新所有房源的标签。
 *
 * 为什么不用"修补旧标签"：早期解析器把「标签」字段（实为
 * "小区基础信息 + 房源标签" 的合并文本）按 `/` 无脑切分，
 * 产生了 "月"、"年)"、"平米" 这类碎片；
 * 而后续的修补脚本只是在碎片上打补丁，改不出正确结果
 * （例如把 "物业费0.8元" + "月" 合并成 "物业费0.8元/月"，仍然丢了"平米"）。
 *
 * 正确做法：**rawData 里保存着贝壳的原始响应**，
 * 用修复后的解析器重新解析一遍即可得到正确标签。
 *
 * 用法：node --experimental-strip-types scripts/reparse-tags.ts -- --yes
 */

import { BeikeFieldMapper } from '../dist/modules/property/providers/beike/beike-response-parser.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes('--yes')) {
    console.error('这会重写数据库中的房源标签。确认请加 --yes');
    process.exit(1);
  }

  const { createPrismaClient } = await import('@estatepilot/database');

  const prisma = createPrismaClient({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public',
    applicationName: 'estatepilot-reparse-tags',
  });

  try {
    const mapper = new BeikeFieldMapper() as unknown as {
      parseTags: (value: unknown) => string[];
    };

    console.log('从原始响应重新解析房源标签…\n');

    const total = await prisma.property.count({
      where: { externalProvider: 'BEIKE' },
    });
    console.log(`  贝壳房源：${total} 条\n`);

    let scanned = 0;
    let updated = 0;
    let noRawTags = 0;
    const samples: Array<{ community: string; before: string[]; after: string[] }> = [];

    const batchSize = 300;
    for (let skip = 0; skip < total; skip += batchSize) {
      const rows = await prisma.property.findMany({
        where: { externalProvider: 'BEIKE' },
        select: { id: true, community: true, tags: true, rawData: true },
        skip,
        take: batchSize,
      });

      for (const row of rows) {
        scanned += 1;

        // 从 rawData 取回「标签」原文
        const raw = row.rawData as { fields?: Record<string, unknown> } | null;
        const rawTags = raw?.fields?.['标签'];

        if (rawTags === undefined || rawTags === null || rawTags === '') {
          noRawTags += 1;
          continue;
        }

        const parsed = mapper.parseTags(rawTags);

        // 解析不出任何标签时保留原值（宁可留着旧数据，也不要清空）
        if (parsed.length === 0) continue;

        const changed =
          parsed.length !== row.tags.length ||
          parsed.some((tag, index) => tag !== row.tags[index]);

        if (changed) {
          await prisma.property.update({
            where: { id: row.id },
            data: { tags: parsed },
          });
          updated += 1;

          if (samples.length < 4) {
            samples.push({
              community: row.community,
              before: row.tags,
              after: parsed,
            });
          }
        }
      }
    }

    console.log('=== 修复样例 ===\n');
    for (const sample of samples) {
      console.log(`${sample.community}`);
      console.log(`  修复前 (${sample.before.length}): ${JSON.stringify(sample.before.slice(0, 12))}`);
      console.log(`  修复后 (${sample.after.length}): ${JSON.stringify(sample.after.slice(0, 12))}`);
      console.log('');
    }

    console.log(`  扫描：${scanned} 条`);
    console.log(`  更新：${updated} 条`);
    console.log(`  无原始标签数据：${noRawTags} 条`);

    // ---- 验证：不应再有单字碎片或含孤立单位的标签 ----
    const all = await prisma.property.findMany({
      where: { externalProvider: 'BEIKE' },
      select: { tags: true },
    });

    const fragmentPattern = /^(?:月|年|平米|平方米|平|元|户|个|层|位|套|栋|人|天|次|月\)|年\))$/;
    let fragments = 0;
    let totalTags = 0;
    let duplicates = 0;

    for (const row of all) {
      totalTags += row.tags.length;

      for (const tag of row.tags) {
        if (fragmentPattern.test(tag) || (tag.length === 1 && !'东南西北中'.includes(tag))) {
          fragments += 1;
        }
      }

      if (new Set(row.tags).size !== row.tags.length) duplicates += 1;
    }

    console.log(`\n=== 验证 ===`);
    console.log(`  标签总数：${totalTags}`);
    console.log(`  碎片标签：${fragments} ${fragments === 0 ? '✓' : '✗'}`);
    console.log(`  含重复标签的房源：${duplicates} ${duplicates === 0 ? '✓' : '✗'}`);

    console.log('\n完成。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('重新解析失败：', error);
  process.exit(1);
});
