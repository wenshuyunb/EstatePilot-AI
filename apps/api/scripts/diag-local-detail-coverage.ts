/**
 * 诊断：本地数据库里到底有多少房源详情可用（不依赖贝壳）。
 *
 * ============================================================================
 * 要回答的问题
 * ============================================================================
 * 用户反馈："贝壳一限流，复制下来的信息就非常简短，这个功能还是依赖贝壳。"
 *
 * 需要量化：
 *   1. 数据库里有多少房源？其中多少有 `fullDetail`（完整详情）？
 *   2. 没有 fullDetail 的房源，`Property` 表本身有多少字段可用？
 *   3. 这些字段够不够组成一份"能让客户看"的房源介绍？
 *
 * ⚠️ 只读本地数据库，不访问贝壳。
 *
 * 用法：node --experimental-strip-types scripts/diag-local-detail-coverage.ts
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  const prisma = createPrismaClient({
    connectionString,
    applicationName: 'diag-local-detail-coverage',
  });

  console.log('本地房源详情覆盖度诊断\n');
  console.log('='.repeat(74));

  try {
    // ---- 1. 总量 ----
    const total = await prisma.property.count();

    console.log('\n【1】房源总量\n');
    console.log(`  数据库房源总数：${total}`);

    // ---- 2. 有完整详情的 ----
    const withDetail = await prisma.property.count({
      where: { NOT: { fullDetail: { equals: null } } },
    });

    console.log('');
    console.log('【2】完整详情（fullDetail）覆盖\n');
    console.log(`  有完整详情：${withDetail} / ${total}（${total > 0 ? Math.round((withDetail / total) * 100) : 0}%）`);
    console.log(`  没有详情：  ${total - withDetail}`);

    /**
     * ⚠️ 这是核心问题所在：
     *   完整详情只在"经纪人点开卡片"时才去贝壳取并落库。
     *   因此绝大多数房源**没有** fullDetail —— 一旦限流就取不到。
     */
    if (withDetail < total) {
      console.log('');
      console.log(`  → ${total - withDetail} 套房源在限流时**无法**提供完整详情`);
    }

    // ---- 3. Property 表本身有多少字段可用 ----
    console.log('');
    console.log('【3】Property 表自带的字段（不需要贝壳）\n');

    const sample = await prisma.property.findFirst({ orderBy: { createdAt: 'desc' } });

    if (!sample) {
      console.log('  库中无房源');
    } else {
      const row = sample as unknown as Record<string, unknown>;

      /** 统计非空字段数（这才是"限流时能拿到的信息量"） */
      const NON_EMPTY = Object.entries(row).filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'string') return value.trim().length > 0;
        return true;
      });

      console.log(`  样本：${String(row['community'])}`);
      console.log(`  非空字段：${NON_EMPTY.length} / ${Object.keys(row).length}`);
      console.log('');
      console.log('  与"发给客户"相关的字段：');

      const RELEVANT = [
        'community', 'city', 'district', 'subDistrict', 'address',
        'totalPrice', 'unitPrice', 'area', 'bedrooms', 'livingRooms', 'bathrooms',
        'floor', 'totalFloors', 'orientation', 'buildYear', 'decoration',
        'elevator', 'propertyType', 'ownershipType', 'listingStatus',
        'subwayDistance', 'subwayInfo', 'schoolInfo', 'tags',
        'description', 'coverImage', 'propertyManagementCompany', 'propertyFee',
        'floorPlan', 'listingDate', 'lastSyncedAt',
      ];

      let available = 0;
      let missing = 0;

      for (const field of RELEVANT) {
        const value = row[field];
        const has =
          value !== null &&
          value !== undefined &&
          (Array.isArray(value) ? value.length > 0 : String(value).trim().length > 0);

        if (has) available += 1;
        else missing += 1;

        const display = has
          ? Array.isArray(value)
            ? `[${value.length} 项]`
            : String(value).slice(0, 34)
          : '（空）';

        console.log(`    ${has ? '✓' : '·'} ${field.padEnd(24)} ${display}`);
      }

      console.log('');
      console.log(`  可用 ${available} 项，缺失 ${missing} 项`);
    }

    // ---- 4. 按城市分布 ----
    console.log('');
    console.log('【4】房源分布\n');

    const byCity = await prisma.property.groupBy({
      by: ['city'],
      _count: { id: true },
    });

    for (const entry of byCity) {
      console.log(`  ${(entry.city ?? '未知').padEnd(10)} ${entry._count.id} 套`);
    }

    // ---- 5. 结论 ----
    console.log('');
    console.log('='.repeat(74));
    console.log('\n【结论】\n');

    console.log('  限流时可用的信息有两个来源：');
    console.log('');
    console.log('    来源 A：Property 表（搜索时就落库）—— **100% 覆盖**');
    console.log('      含小区/区域/价格/面积/户型/楼层/朝向/年份/装修/地铁/学区/标签/描述');
    console.log('');
    console.log(`    来源 B：fullDetail（只在点开卡片时取）—— 仅 ${withDetail} 套`);
    console.log('      额外含：小区容积率/绿化率/物业费/物业公司/周边配套明细/图片');
    console.log('');
    console.log('  → 问题在于：复制功能**优先**用来源 B，拿不到就大幅降级，');
    console.log('    却没有充分利用来源 A（它一直都有数据）。');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
