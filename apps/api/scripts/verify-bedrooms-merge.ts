/**
 * 验证「说三房却搜两房」bug 的修复。
 *
 * ============================================================================
 * 背景
 * ============================================================================
 * 实测现象：客户说「厦门湖里区三房，400万左右」
 *   · 抽取正确：摘要「厦门，湖里区，3房，理想400万」
 *   · 最终却存成 bedrooms = [2, 3]
 *   · 检索式变成「湖里区 2居室 300万以内」
 *   · 搜出来的全是 2 房房源 —— 答非所问
 *
 * 根因：合并逻辑默认**追加**，把"三房"当成了"在原有基础上再加一个户型"。
 *
 * 修复：新增 additive 语义 —— 只有客户明确放宽（"两房也可以"）时才追加，
 *       否则替换。
 *
 * ⚠️ 本测试**完全离线**，不访问贝壳，不消耗任何 API 配额。
 *
 * 用法：node --experimental-strip-types scripts/verify-bedrooms-merge.ts
 */

import { parseRequirementByRules } from '../dist/modules/requirement/chinese-expression-parser.js';
import {
  RequirementMergeService,
  createEmptyProfile,
} from '../dist/modules/requirement/requirement-merge.service.js';

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

/** 构造一个已有指定户型的画像 */
function profileWith(bedrooms: number[]) {
  const profile = createEmptyProfile();
  profile.city = '厦门';
  profile.districts = ['湖里区'];
  profile.bedrooms = [...bedrooms];
  profile.budgetTarget = 3_000_000;
  profile.budgetNormalMax = 6_000_000;
  return profile;
}

/** 走一遍"解析 → 合并"，返回最终户型 */
function mergeMessage(message: string, existingBedrooms: number[]) {
  const extracted = parseRequirementByRules(message, { city: '厦门' });
  const result = merger.merge(profileWith(existingBedrooms), extracted);
  return {
    extracted,
    bedrooms: result.merged.bedrooms,
    changes: result.changes,
  };
}

console.log('验证户型合并 bug 修复\n');
console.log('='.repeat(74));

// ========================================================================
console.log('\n【1】抽取阶段：是否正确识别"放宽"语义\n');
// ========================================================================

const cases: Array<{ message: string; expectAdditive: boolean; why: string }> = [
  { message: '厦门湖里区三房，400万左右', expectAdditive: false, why: '裸的户型词 = 指定' },
  { message: '想看三房', expectAdditive: false, why: '指定' },
  { message: '就要三房', expectAdditive: false, why: '指定（且硬性）' },
  { message: '三房最好，两房也可以', expectAdditive: true, why: '明确放宽' },
  { message: '两房也行', expectAdditive: true, why: '明确放宽' },
  { message: '两房三房都能接受', expectAdditive: true, why: '明确放宽' },
  { message: '三房左右', expectAdditive: true, why: '模糊范围' },
];

for (const testCase of cases) {
  const extracted = parseRequirementByRules(testCase.message, { city: '厦门' });
  const actual = extracted.bedrooms.additive;

  check(
    `「${testCase.message}」→ additive=${actual}（${testCase.why}）`,
    actual === testCase.expectAdditive,
    `期望 ${testCase.expectAdditive}，实际 ${actual}`,
  );
}

// ========================================================================
console.log('');
console.log('【2】合并阶段：核心 bug 场景\n');
// ========================================================================

console.log('  场景：画像已有 [2,3]，客户这次说「三房」\n');

const bugCase = mergeMessage('厦门湖里区三房，400万左右', [2, 3]);
console.log(`    抽取: preferred=${bugCase.extracted.bedrooms.preferred} additive=${bugCase.extracted.bedrooms.additive}`);
console.log(`    结果: bedrooms = ${JSON.stringify(bugCase.bedrooms)}`);
console.log(`    变更: ${bugCase.changes.map((c) => `${c.label} ${c.previousDisplay}→${c.newDisplay}`).join(' | ') || '（无）'}`);

check(
  '★ 核心修复：「三房」应替换为 [3]，而不是累加成 [2,3]',
  JSON.stringify(bugCase.bedrooms) === '[3]',
  `实际 ${JSON.stringify(bugCase.bedrooms)}`,
);

// ========================================================================
console.log('');
console.log('【3】放宽场景：应保留追加行为\n');
// ========================================================================

console.log('  场景：画像已有 [3]，客户说「两房也可以」\n');

const additiveCase = mergeMessage('三房最好，两房也可以', [3]);
console.log(`    抽取: preferred=${additiveCase.extracted.bedrooms.preferred} additive=${additiveCase.extracted.bedrooms.additive}`);
console.log(`    结果: bedrooms = ${JSON.stringify(additiveCase.bedrooms)}`);

check(
  '放宽时保留追加（"[3]" + "两房也可以" → [2,3]）',
  JSON.stringify(additiveCase.bedrooms) === '[2,3]',
  `实际 ${JSON.stringify(additiveCase.bedrooms)}`,
);

// ========================================================================
console.log('');
console.log('【4】其它场景\n');
// ========================================================================

// 首次沟通（画像为空）
const first = mergeMessage('厦门湖里区三房', []);
check('首次沟通：空画像 → [3]', JSON.stringify(first.bedrooms) === '[3]', JSON.stringify(first.bedrooms));

// 明确改口
const override = mergeMessage('现在只要两房了', [3]);
check(
  '明确改口：「现在只要两房了」→ [2]',
  JSON.stringify(override.bedrooms) === '[2]',
  JSON.stringify(override.bedrooms),
);

// 硬性要求
const strict = mergeMessage('必须三房', [2]);
check('硬性要求：「必须三房」→ [3]', JSON.stringify(strict.bedrooms) === '[3]', JSON.stringify(strict.bedrooms));

// 同户型重复说明（不应产生噪音变更）
const same = mergeMessage('还是三房', [3]);
check(
  '重复说同户型：不产生变更记录（避免噪音）',
  same.changes.filter((c) => c.field === 'bedrooms').length === 0,
  `实际变更 ${same.changes.filter((c) => c.field === 'bedrooms').length} 条`,
);

// ========================================================================
console.log('');
console.log('【5】回归：预算与城市的合并不受影响\n');
// ========================================================================

const budget = mergeMessage('预算500万，两房也行', [3]);
check('预算仍能识别', budget.extracted.budget.target !== null || budget.extracted.budget.normalMax !== null);
check(
  '同时说"两房也行" → 追加为 [2,3]',
  JSON.stringify(budget.bedrooms) === '[2,3]',
  JSON.stringify(budget.bedrooms),
);

// 城市不被画像污染
const city = mergeMessage('厦门岛内的房子', []);
check('城市识别正确（厦门）', city.extracted.city === '厦门', String(city.extracted.city));

// ========================================================================
console.log('');
console.log('─'.repeat(70));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

console.log('说明：修复的核心是**默认替换而非追加**。');
console.log('      「客户说出了想要的户型」是常态；「放宽」需要额外的让步语气词。');
console.log('      旧逻辑恰好相反，这是 bug 的根源。\n');

process.exit(failed > 0 ? 1 : 0);
