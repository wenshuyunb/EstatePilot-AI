/**
 * 诊断：数据库读回来的 Property 行，数值字段的真实 JS 类型是什么？
 *
 * ============================================================================
 * 为什么需要这个诊断
 * ============================================================================
 * 线上报错：切换文案模板时报 500
 *   `TypeError: Cannot convert a BigInt value to a number`
 *   at WeChatReplyGenerator.formatWan
 *
 * 原因是"重新生成文案"走的是**从数据库读房源**的路径，
 * 而首次生成走的是**内存里的对象** —— 同一个字段，两条路径类型不同。
 *
 * 本脚本确认数据库读回来的 `totalPrice` / `area` 到底是什么类型，
 * 以便写正确的映射。
 *
 * ⚠️ 只读本地数据库，不访问贝壳。
 *
 * 用法：node --experimental-strip-types scripts/diag-property-row-types.ts
 */

import { createPrismaClient } from '@estatepilot/database';

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  const prisma = createPrismaClient({
    connectionString,
    applicationName: 'diag-property-row-types',
  });

  console.log('数据库 Property 行字段类型诊断\n');
  console.log('='.repeat(74));

  const row = await prisma.property.findFirst({ orderBy: { createdAt: 'desc' } });

  if (!row) {
    console.log('\n  库中没有房源，无法诊断');
    await prisma.$disconnect();
    return;
  }

  console.log(`\n样本房源：${row.community}\n`);

  /** 需要关注的数值字段 */
  const NUMERIC_FIELDS = [
    'totalPrice',
    'unitPrice',
    'area',
    'bedrooms',
    'livingRooms',
    'bathrooms',
    'floor',
    'totalFloors',
    'buildYear',
    'subwayDistance',
    'longitude',
    'latitude',
  ] as const;

  console.log('  字段'.padEnd(20) + '值'.padEnd(22) + 'JS 类型');
  console.log('  ' + '-'.repeat(60));

  const problems: string[] = [];

  for (const field of NUMERIC_FIELDS) {
    const value = (row as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;

    const jsType = typeof value;
    const ctor = value === null ? 'null' : (value?.constructor?.name ?? '?');
    const display = value === null ? 'null' : String(value);

    console.log(`  ${field.padEnd(18)} ${display.slice(0, 20).padEnd(22)} ${jsType} / ${ctor}`);

    /**
     * ⚠️ 关键判定：BigInt 和 Decimal 都会让 `Math.abs()` 抛异常。
     *
     * `Number.isFinite()` 对 BigInt 返回 false（不抛错），
     * 而 `Math.abs(BigInt)` 直接抛 `TypeError`。这正是线上 500 的原因。
     */
    if (jsType === 'bigint') {
      problems.push(`${field} 是 BigInt —— Math.abs() 会抛异常`);
    } else if (ctor === 'Decimal' || ctor === 'Object' && value?.toString && !Number.isFinite(Number(value))) {
      problems.push(`${field} 是 Decimal 对象（${ctor}）—— 数值运算不可靠`);
    } else if (jsType === 'object' && value !== null) {
      problems.push(`${field} 是对象（${ctor}）—— 需要转换`);
    }
  }

  // ---- 实际验证会不会崩 ----
  console.log('');
  console.log('='.repeat(74));
  console.log('\n【实际运算验证】\n');

  const totalPrice = (row as unknown as Record<string, unknown>)['totalPrice'];

  try {
    const result = Math.abs(totalPrice as number);
    console.log(`  Math.abs(totalPrice) = ${result}  ✅ 未抛异常`);
  } catch (error) {
    console.log(
      `  Math.abs(totalPrice) → ❌ ${error instanceof Error ? error.name : 'Error'}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    problems.push('确认 Math.abs(totalPrice) 会抛异常（线上 500 的直接原因）');
  }

  try {
    const num = Number(totalPrice);
    console.log(`  Number(totalPrice) = ${num}  ${Number.isFinite(num) ? '✅ 可用' : '⚠️ 非有限数'}`);
  } catch (error) {
    console.log(`  Number(totalPrice) → ❌ ${String(error)}`);
  }

  // ---- 结论 ----
  console.log('');
  console.log('='.repeat(74));

  if (problems.length > 0) {
    console.log(`\n  发现 ${problems.length} 个类型问题：\n`);
    for (const problem of problems) console.log(`    · ${problem}`);
    console.log('');
    console.log('  → 需要在"数据库行 → NormalizedProperty"之间加一层**显式映射**，');
    console.log('    把所有数值字段用 Number() 归一化。');
  } else {
    console.log('\n  ✓ 所有数值字段都是原生 number，无需额外转换');
  }

  console.log('');
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
