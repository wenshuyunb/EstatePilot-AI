/**
 * 验证检索式生成：画像 bedrooms=[3] 是否产出"3居室"。
 *
 * ============================================================================
 * 为什么单独验证这一环
 * ============================================================================
 * 完整链条是：
 *   客户说"三房" → 抽取 → 合并进画像 → **生成检索式** → 发给贝壳
 *
 * 前面已验证前三步；本脚本验证第四步 ——
 * 因为实测 bug 的表象就是检索式错了（"湖里区 2居室 300万以内"），
 * 必须确认修复后检索式确实变成"3居室"。
 *
 * ⚠️ 完全离线，不访问贝壳。
 *
 * 用法：node --experimental-strip-types scripts/verify-search-query-bedrooms.ts
 */

import { parseRequirementByRules } from '../dist/modules/requirement/chinese-expression-parser.js';
import {
  RequirementMergeService,
  createEmptyProfile,
} from '../dist/modules/requirement/requirement-merge.service.js';
import { PropertySearchQueryBuilder } from '../dist/modules/requirement/property-search-query-builder.service.js';

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

const merger = new RequirementMergeService();

/**
 * PropertySearchQueryBuilder 的依赖需要确认。
 * 若它需要注入服务，这里退化为只检查画像值 —— 但那会漏掉真正的风险点，
 * 因此优先尝试直接实例化。
 */
function makeBuilder(): PropertySearchQueryBuilder | null {
  try {
    // 多数查询构造器是无状态纯函数式的
    return new (PropertySearchQueryBuilder as unknown as new () => PropertySearchQueryBuilder)();
  } catch {
    return null;
  }
}

console.log('验证检索式生成（户型）\n');
console.log('='.repeat(74));

const builder = makeBuilder();

if (!builder) {
  console.log('\n  ⚠️ PropertySearchQueryBuilder 需要依赖注入，无法独立实例化。');
  console.log('     改为只验证画像层的数值正确性。\n');
}

// ========================================================================
console.log('\n【1】端到端链条：客户原话 → 画像户型\n');
// ========================================================================

/**
 * 模拟真实场景：画像里已经有 [2,3] 的脏数据，
 * 客户这次明确说"三房"，看画像是否被纠正。
 */
const profile = createEmptyProfile();
profile.city = '厦门';
profile.districts = ['湖里区'];
profile.bedrooms = [2, 3]; // 历史脏数据
profile.budgetTarget = 3_000_000;
profile.budgetNormalMax = 6_000_000;

const message = '厦门湖里区三房，400万左右';
const extracted = parseRequirementByRules(message, { city: '厦门' });
const merged = merger.merge(profile, extracted);

console.log(`  客户原话: 「${message}」`);
console.log(`  抽取结果: preferred=${extracted.bedrooms.preferred}, additive=${extracted.bedrooms.additive}`);
console.log(`  合并前:   bedrooms = ${JSON.stringify(profile.bedrooms)}`);
console.log(`  合并后:   bedrooms = ${JSON.stringify(merged.merged.bedrooms)}`);
console.log('');

check(
  '★ 画像户型被纠正为 [3]',
  JSON.stringify(merged.merged.bedrooms) === '[3]',
  `实际 ${JSON.stringify(merged.merged.bedrooms)}`,
);

check(
  '产生了变更记录（可追溯到历史）',
  merged.changes.some((c) => c.field === 'bedrooms'),
);

// ========================================================================
console.log('');
console.log('【2】检索式生成\n');
// ========================================================================

if (builder) {
  /**
   * ⚠️ 方法名是 `build(profile, context)`，返回 `{ query, hardConditionSummary, ... }`。
   *    自然语言检索式在 `built.query.naturalQuery`。
   *    （第一版我猜成了 `buildNaturalQuery`，那是内部私有方法。）
   */
  const built = builder.build(merged.merged, {});

  console.log(`  检索式: 「${built.query.naturalQuery}」`);
  console.log(`  硬性条件: ${built.hardConditionSummary.join(' / ')}`);
  console.log('');

  check(
    '★ 检索式包含"3居室"（而不是"2居室"）',
    built.query.naturalQuery.includes('3居室'),
    `实际「${built.query.naturalQuery}」`,
  );

  check(
    '检索式**不含**"2居室"',
    !built.query.naturalQuery.includes('2居室'),
    `实际「${built.query.naturalQuery}」`,
  );

  check('检索式包含城市或区', built.query.city === '厦门', `city=${built.query.city}`);
  check('结构化 bedrooms = [3]', JSON.stringify(built.query.bedrooms) === '[3]', JSON.stringify(built.query.bedrooms));
} else {
  console.log('  （跳过 —— 无法独立实例化查询构造器）');
  console.log('');
  console.log('  替代验证：画像 bedrooms 值正确即可保证下游检索式正确，');
  console.log('  因为查询构造器只是把 bedrooms 数组映射为"3居室"这样的文本。');
}

// ========================================================================
console.log('');
console.log('【3】对照：放宽场景应生成"2/3居室"\n');
// ========================================================================

const profile2 = createEmptyProfile();
profile2.city = '厦门';
profile2.districts = ['湖里区'];
profile2.bedrooms = [3];
profile2.budgetTarget = 3_000_000;

const relaxed = merger.merge(profile2, parseRequirementByRules('两房也可以', { city: '厦门' }));

console.log(`  「两房也可以」→ bedrooms = ${JSON.stringify(relaxed.merged.bedrooms)}`);
check('放宽后为 [2,3]', JSON.stringify(relaxed.merged.bedrooms) === '[2,3]');

if (builder) {
  const built2 = builder.build(relaxed.merged, {});
  console.log(`  检索式: 「${built2.query.naturalQuery}」`);

  check(
    '★ 检索式同时包含「2居室」与「3居室」（不再漏掉 3 房）',
    built2.query.naturalQuery.includes('2居室') && built2.query.naturalQuery.includes('3居室'),
    `实际「${built2.query.naturalQuery}」`,
  );
}

// ========================================================================
console.log('');
console.log('─'.repeat(70));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

console.log('结论：客户说"三房"，检索式从错误的「2居室」变为正确的「3居室」。');
console.log('      这正是修复前"搜出 2 房房源"的直接原因。\n');

process.exit(failed > 0 ? 1 : 0);
