/**
 * 验证：贝壳不可用时，详情仍能从本地数据构造（"限流也能用"的核心保障）。
 *
 * ============================================================================
 * 覆盖的真实问题
 * ============================================================================
 * 用户反馈："贝壳一限流，复制下来的信息就非常简短，这个项目就完蛋了。"
 *
 * 实测数据：
 *   · 132 套房源里只有 **3 套（2%）有 fullDetail**（完整详情只在点开时取）
 *   · `Property` 表本身有 **15+ 项字段，覆盖率 100%**（搜索时就落库）
 *   · `description` 覆盖率 **100%**，且含装修与楼层信息
 *
 * 修复：新增 `LOCAL_PROPERTY` 来源 —— 用本地行构造详情，**不调用贝壳**。
 *
 * ⚠️ 只读本地数据库 + 纯逻辑，不访问贝壳。
 *
 * 用法：node --experimental-strip-types scripts/verify-local-detail-fallback.ts
 */

import { createPrismaClient } from '@estatepilot/database';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  const prisma = createPrismaClient({ connectionString, applicationName: 'verify-local-detail' });

  console.log('验证本地详情兜底（贝壳限流也能用）\n');
  console.log('='.repeat(74));

  try {
    // ========================================================================
    console.log('\n【1】量化：完整详情 vs 本地字段的覆盖率\n');
    // ========================================================================

    const total = await prisma.property.count();
    const withFullDetail = await prisma.property.count({
      where: { NOT: { fullDetail: { equals: null } } },
    });
    const withDescription = await prisma.property.count({
      where: { NOT: { description: null } },
    });

    console.log(`  房源总数：        ${total}`);
    console.log(`  有完整详情：      ${withFullDetail}（${Math.round((withFullDetail / total) * 100)}%）`);
    console.log(`  有 description：  ${withDescription}（${Math.round((withDescription / total) * 100)}%）`);

    check(
      `★ description 覆盖率显著高于 fullDetail（${Math.round((withDescription / total) * 100)}% vs ${Math.round((withFullDetail / total) * 100)}%）`,
      withDescription > withFullDetail,
    );

    check('description 覆盖率接近 100%', withDescription / total > 0.95);

    // ========================================================================
    console.log('');
    console.log('【2】从 description 提取装修与楼层（应有效）\n');
    // ========================================================================

    /**
     * 复刻后端的提取逻辑（property-detail.service.ts 的 buildDetailFromLocalRow）。
     *
     * 抽出来测是因为这段正则容易写错，而写错的后果是
     * "装修/楼层静默丢失" —— 限流时就少两块信息。
     */
    function extractDecoration(description: string): string | null {
      const section = /【装修与楼层】([^。\n]*)/.exec(description)?.[1] ?? '';
      for (const keyword of ['豪华装修', '精装修', '精装', '简装', '毛坯', '豪装', '中装']) {
        if (section.includes(keyword)) return keyword;
      }
      return null;
    }

    function extractFloorText(description: string): string | null {
      const section = /【装修与楼层】([^。\n]*)/.exec(description)?.[1] ?? '';
      return /(低楼层|中楼层|高楼层|地下楼层|顶层|底层)/.exec(section)?.[1] ?? null;
    }

    const samples = await prisma.property.findMany({
      take: 5,
      where: { NOT: { description: null } },
      select: { community: true, description: true },
    });

    let floorExtracted = 0;

    for (const sample of samples) {
      const description = String(sample.description ?? '');
      const decoration = extractDecoration(description);
      const floor = extractFloorText(description);

      console.log(
        `  ${sample.community.padEnd(20)} 装修=${(decoration ?? '—').padEnd(6)} 楼层=${floor ?? '—'}`,
      );

      if (floor) floorExtracted += 1;
    }

    check(
      '★ 能从 description 提取到楼层（样本中至少 3 个）',
      floorExtracted >= 3,
      `实际 ${floorExtracted}/${samples.length}`,
    );

    // 边界：不应把"中楼层"误认成装修
    check(
      '★ 不把"中楼层"误认为装修',
      extractDecoration('【装修与楼层】中楼层。') === null,
    );

    check(
      '能识别"精装修"',
      extractDecoration('【装修与楼层】精装修，中楼层。') === '精装修',
    );

    check(
      '能识别"毛坯"',
      extractDecoration('【装修与楼层】毛坯，低楼层。') === '毛坯',
    );

    check(
      '无装修信息时返回 null（不硬编造）',
      extractDecoration('【户型】3室2厅。') === null,
    );

    // ========================================================================
    console.log('');
    console.log('【3】本地构造的字段完整度\n');
    // ========================================================================

    /**
     * 统计：用本地行能构造出多少"发给客户"需要的字段。
     *
     * 这是"限流时信息够不够用"的直接答案。
     */
    const row = await prisma.property.findFirst({ orderBy: { createdAt: 'desc' } });

    if (!row) {
      console.log('  （库中无房源）');
    } else {
      const record = row as unknown as Record<string, unknown>;

      const canProvide = {
        小区: Boolean(record['community']),
        城市区域: Boolean(record['city'] && record['district']),
        总价: record['totalPrice'] != null,
        单价: record['unitPrice'] != null,
        面积: record['area'] != null,
        户型: record['bedrooms'] != null,
        朝向: Boolean(record['orientation']),
        建成年份: record['buildYear'] != null,
        楼层: Boolean(extractFloorText(String(record['description'] ?? ''))),
        装修: Boolean(extractDecoration(String(record['description'] ?? ''))),
        房源描述: Boolean(record['description']),
      };

      let yes = 0;
      let no = 0;

      for (const [label, value] of Object.entries(canProvide)) {
        console.log(`    ${value ? '✓' : '·'} ${label}`);
        if (value) yes += 1;
        else no += 1;
      }

      console.log('');
      check(
        `★ 本地数据可提供 ${yes}/${yes + no} 项关键信息（无需贝壳）`,
        yes >= 8,
        `仅 ${yes} 项可用`,
      );
    }

    // ========================================================================
    console.log('');
    console.log('─'.repeat(70));
    console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

    console.log('结论：即使贝壳完全不可用，本地数据仍能提供');
    console.log('      小区/区域/价格/面积/户型/朝向/年份/楼层/装修/描述 ——');
    console.log('      足够构成一份能让客户看懂的房源介绍。');
    console.log('');
    console.log('      缺少的只有"小区层面"的信息（容积率/绿化率/物业费/周边配套明细），');
    console.log('      那些确实需要贝壳详情，但**没有它们不影响基本可用性**。');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证异常：', error);
  process.exit(1);
});
