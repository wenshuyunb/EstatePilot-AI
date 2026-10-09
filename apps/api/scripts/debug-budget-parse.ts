/**
 * 调试：预算表达解析。
 *
 * 问题：客户说"张江更好，550也可以"时，regular budget 的最高上限没有设置。
 * 需要确认 extractBudget 对"550也可以"这类表达的处理。
 */

import { extractBudget, extractBedrooms } from '../dist/modules/requirement/chinese-expression-parser.js';

const cases = [
  '想看浦东三房，500左右',
  '张江更好，550也可以',
  '600以内也可以',
  '600封顶',
  '不超过600',
  '最多520，超过不看',
  '特别好的600也能考虑',
  '预算550',
  '500左右，550也行',
  '可以加一点',
  '550上下',
  '600以内，特别好的650也能考虑',
];

console.log('=== 预算表达解析测试 ===\n');
console.log('表达'.padEnd(28) + '｜ target'.padEnd(12) + '｜ normalMax'.padEnd(12) + '｜ stretchMax'.padEnd(12) + '｜ strict');
console.log('─'.repeat(90));

for (const text of cases) {
  const budget = extractBudget(text);
  const fmt = (value: number | null): string => (value === null ? '—' : `${value / 10000}万`);

  console.log(
    text.padEnd(26) +
      '｜ ' +
      fmt(budget.target).padEnd(10) +
      '｜ ' +
      fmt(budget.normalMax).padEnd(10) +
      '｜ ' +
      fmt(budget.stretchMax).padEnd(10) +
      '｜ ' +
      String(budget.strictMax),
  );
}

console.log('\n=== 户型解析 ===');
for (const text of ['三房', '三室', '只要三房', '三房最好', '三房两厅']) {
  console.log(`  ${text} → ${JSON.stringify(extractBedrooms(text))}`);
}
