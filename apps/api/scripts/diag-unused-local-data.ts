/**
 * 盘点：数据库里还有哪些"已存但未展示"的信息。
 *
 * ============================================================================
 * 为什么要区分"没有数据"与"有数据没展示"
 * ============================================================================
 * 用户反馈"还是不够"。但"不够"有两种可能：
 *   A. 贝壳确实不返回这个字段（需要换数据源，短期无解）
 *   B. **有数据但没展示**（纯浪费，能立刻修）
 *
 * 只有 B 值得投入。本脚本给出两者的明确分界。
 *
 * ⚠️ 实现说明：不用 Prisma 的 `count({ where: { NOT: { field: null } } })` ——
 *    JSON 字段不接受那种写法（会因 null 语义报错）。
 *    改为**读取样本后在 JS 里统计**，对所有字段类型都可靠。
 *
 * 用法：node --experimental-strip-types scripts/diag-unused-local-data.ts
 */

import { createPrismaClient } from '@estatepilot/database';

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

const prisma = createPrismaClient({ connectionString, applicationName: 'diag-unused-data' });

/** 判断字段是否"有内容" */
function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

async function main(): Promise<void> {
  const total = await prisma.property.count();

  console.log('「已存但未展示」的信息盘点\n');
  console.log('='.repeat(74));
  console.log(`\n总计 ${total} 套房源\n`);

  const rows = await prisma.property.findMany();

  /** ---- 1. 字段填充率 ---- */
  console.log('【字段填充率】\n');

  const FIELDS = [
    'community', 'city', 'district', 'subDistrict', 'address',
    'totalPrice', 'unitPrice', 'area', 'bedrooms', 'livingRooms', 'bathrooms',
    'floor', 'totalFloors', 'orientation', 'buildYear', 'decoration', 'elevator',
    'propertyType', 'ownershipType', 'listingStatus', 'listingDate',
    'subwayDistance', 'subwayInfo', 'schoolInfo',
    'tags', 'coverImage', 'floorPlan', 'description',
    'propertyManagementCompany', 'propertyFee',
    'longitude', 'latitude', 'lastPriceChange', 'lastSyncedAt',
    'rawData', 'fullDetail',
  ];

  for (const field of FIELDS) {
    const filled = rows.filter((row) => hasContent((row as unknown as Record<string, unknown>)[field])).length;
    const percent = total > 0 ? Math.round((filled / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(percent / 5)).padEnd(20, '·');

    console.log(`  ${field.padEnd(28)} ${bar} ${String(percent).padStart(3)}%  (${filled})`);
  }

  /** ---- 2. rawData 里有什么（搜索时的原始响应） ---- */
  console.log('');
  console.log('【rawData 里保存的原始字段】（搜索时就落库，**不需要再调贝壳**）\n');

  const withRaw = rows.find((row) => hasContent(row.rawData));

  if (withRaw?.rawData) {
    const raw = withRaw.rawData as Record<string, unknown>;
    console.log(`  样本：${withRaw.community}`);
    console.log(`  字段数：${Object.keys(raw).length}\n`);

    for (const [key, value] of Object.entries(raw).slice(0, 40)) {
      const display = Array.isArray(value)
        ? `[数组 ${value.length} 项]`
        : typeof value === 'object' && value !== null
          ? `{${Object.keys(value as object).slice(0, 3).join(', ')}…}`
          : String(value).slice(0, 46);
      console.log(`    ${key.padEnd(26)} ${display}`);
    }
  } else {
    console.log('  （无 rawData）');
  }

  /** ---- 3. 价格历史 ---- */
  console.log('');
  console.log('【价格历史 PropertyPriceHistory】\n');

  try {
    const priceCount = await prisma.propertyPriceHistory.count();
    console.log(`  记录数：${priceCount}`);

    if (priceCount > 0) {
      const latest = await prisma.propertyPriceHistory.findMany({
        take: 3,
        orderBy: { id: 'desc' },
        select: { propertyId: true, price: true, changedAt: true },
      });

      for (const entry of latest) {
        console.log(`    ${entry.changedAt?.toISOString() ?? '-'}  ${Number(entry.price) / 10_000}万`);
      }
    }
  } catch (error) {
    console.log(`  查询失败：${String(error).slice(0, 80)}`);
  }

  /** ---- 4. 结论 ---- */
  console.log('');
  console.log('='.repeat(74));
  console.log('\n【结论】\n');

  const zeroFields = FIELDS.filter(
    (field) => rows.filter((row) => hasContent((row as unknown as Record<string, unknown>)[field])).length === 0,
  );

  console.log('  填充率 0% 的字段（贝壳搜索时就不返回，短期无解）：');
  for (const field of zeroFields) console.log(`    · ${field}`);
  console.log('');
  console.log('  → 这些**不是"没展示"，而是"确实没有"** ——');
  console.log('    要向贝壳详情/其他数据源要，或让经纪人手工补充。');

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
