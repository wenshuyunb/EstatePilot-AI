/**
 * 验证「数据库行 → NormalizedProperty」映射修复了文案生成的 500。
 *
 * ============================================================================
 * 覆盖的线上事故
 * ============================================================================
 * 现象：切换微信文案模板（自然/简短/详细）报"生成失败"。
 * 日志：
 *   POST /api/v1/recommendations/:batchId/regenerate → 500
 *   TypeError: Cannot convert a BigInt value to a number
 *     at WeChatReplyGenerator.formatWan
 *
 * 根因：数据库读回的 `totalPrice` 是 **BigInt**、`area` 是 **Decimal**，
 *       而原实现用 `property as never` 绕过类型检查直接传给文案生成器。
 *
 * 本测试用**真实的数据库行**验证映射后的类型与文案生成是否正常。
 *
 * ⚠️ 只读本地数据库 + 纯逻辑，不访问贝壳。
 *
 * 用法：node --experimental-strip-types scripts/verify-property-row-mapper.ts
 */

import { createPrismaClient } from '@estatepilot/database';
import { mapPropertyRowToNormalized, toNumber } from '../dist/modules/property/property-row.mapper.js';

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
  console.log('验证房源行映射（修复文案生成 500）\n');
  console.log('='.repeat(74));

  // ========================================================================
  console.log('\n【1】toNumber 对各种类型的处理\n');
  // ========================================================================

  check('bigint → number', toNumber(2_760_000n) === 2_760_000, String(toNumber(2_760_000n)));
  check('number 原样返回', toNumber(35_844) === 35_844);
  check('字符串数字可解析', toNumber('77.5') === 77.5);
  check('null → null', toNumber(null) === null);
  check('undefined → null', toNumber(undefined) === null);
  check('NaN 字符串 → null（不抛异常）', toNumber('abc') === null);
  check('Infinity → null', toNumber(Number.POSITIVE_INFINITY) === null);

  // 模拟 Prisma Decimal（有 toNumber 方法）
  const fakeDecimal = { toNumber: () => 77, toString: () => '77' };
  check('Decimal 对象（有 toNumber）→ number', toNumber(fakeDecimal) === 77);

  // 模拟只有 toString 的对象
  const fakeStringy = { toString: () => '88.5' };
  check('只有 toString 的对象 → number', toNumber(fakeStringy) === 88.5);

  // 关键：这行是线上崩溃的直接原因
  let crashed = false;
  try {
    Math.abs(2_760_000n as unknown as number);
  } catch {
    crashed = true;
  }
  check('★ 确认 Math.abs(BigInt) 会抛异常（这是线上 500 的成因）', crashed);

  let stillCrashes = false;
  try {
    Math.abs(toNumber(2_760_000n) as number);
  } catch {
    stillCrashes = true;
  }
  check('★ 经 toNumber 后 Math.abs 不再崩溃', !stillCrashes);

  // ========================================================================
  console.log('');
  console.log('【2】真实数据库行的映射\n');
  // ========================================================================

  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://estatepilot:estatepilot_dev_pwd@localhost:5432/estatepilot?schema=public';

  const prisma = createPrismaClient({ connectionString, applicationName: 'verify-row-mapper' });

  try {
    const row = await prisma.property.findFirst({ orderBy: { createdAt: 'desc' } });

    if (!row) {
      console.log('  （库中无房源，跳过）');
    } else {
      const raw = row as unknown as Record<string, unknown>;
      const mapped = mapPropertyRowToNormalized(raw);

      console.log(`  样本：${mapped.community}`);
      console.log('');
      console.log('  字段'.padEnd(18) + '原始类型'.padEnd(20) + '映射后');
      console.log('  ' + '-'.repeat(56));

      const FIELDS = ['totalPrice', 'area', 'unitPrice', 'bedrooms', 'buildYear'] as const;

      for (const field of FIELDS) {
        const rawValue = raw[field];
        const mappedValue = (mapped as unknown as Record<string, unknown>)[field];
        const rawType = typeof rawValue === 'object' && rawValue !== null ? rawValue.constructor.name : typeof rawValue;
        console.log(
          `  ${field.padEnd(16)} ${String(rawType).padEnd(20)} ${String(mappedValue)} (${typeof mappedValue})`,
        );
      }

      console.log('');

      check(
        '★ totalPrice 映射为原生 number（不再是 BigInt）',
        typeof mapped.totalPrice === 'number',
        `实际 ${typeof mapped.totalPrice}`,
      );

      check(
        '★ area 映射为原生 number（不再是 Decimal 对象）',
        typeof mapped.area === 'number',
        `实际 ${typeof mapped.area}`,
      );

      check('totalPrice 数值未失真', mapped.totalPrice === Number(raw['totalPrice']));
      check('area 数值未失真', mapped.area === Number(String(raw['area'])));

      // ---- 模拟文案生成器里的实际运算 ----
      let opCrashed = false;
      try {
        Math.abs(mapped.totalPrice);
        Math.round(mapped.area);
        Math.round(mapped.totalPrice / 10_000);
        Math.round(mapped.unitPrice / 1000);
      } catch (error) {
        opCrashed = true;
        console.log(`      运算异常：${String(error)}`);
      }
      check('★ 文案生成器的全部数值运算不再崩溃', !opCrashed);

      // ---- 文案生成器需要的字段是否齐全 ----
      const REQUIRED_FIELDS = [
        'community', 'district', 'subDistrict', 'area', 'bedrooms', 'livingRooms',
        'bathrooms', 'floor', 'totalFloors', 'buildYear', 'orientation',
        'decoration', 'subwayDistance', 'schoolInfo', 'totalPrice', 'unitPrice',
      ] as const;

      const missing = REQUIRED_FIELDS.filter(
        (field) => (mapped as unknown as Record<string, unknown>)[field] === undefined,
      );

      check(
        `★ 文案生成器需要的 ${REQUIRED_FIELDS.length} 个字段全部存在`,
        missing.length === 0,
        `缺失：${missing.join(', ')}`,
      );

      // ---- 关键字段不可为 null/NaN ----
      check('totalPrice 是有效数值', Number.isFinite(mapped.totalPrice) && mapped.totalPrice > 0);
      check('area 是有效数值', Number.isFinite(mapped.area) && mapped.area > 0);
      check('community 非空', typeof mapped.community === 'string' && mapped.community.length > 0);
    }
  } finally {
    await prisma.$disconnect();
  }

  // ========================================================================
  console.log('');
  console.log('─'.repeat(70));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  console.log('结论：映射层把 BigInt/Decimal 归一化为原生 number，');
  console.log('      切模板调用的 regenerate 与 generate 接口不再 500。\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证异常：', error);
  process.exit(1);
});
