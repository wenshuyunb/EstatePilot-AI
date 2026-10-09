/**
 * 户型解析验证。
 *
 * 覆盖中文数字、阿拉伯数字、以及不同口语表达。
 */

import { extractBedrooms, parseRequirementByRules } from '../dist/modules/requirement/chinese-expression-parser.js';

const cases = [
  '只要两房',
  '两房',
  '两室',
  '二房',
  '2房',
  '三房',
  '三室',
  '3居',
  '只要三房',
  '两房一厅',
  '4居',
  '三个房间',
  '一居室',
];

console.log('=== 户型解析 ===\n');
for (const text of cases) {
  const result = extractBedrooms(text);
  const ok = result.preferred !== null;
  console.log(
    `${JSON.stringify(text).padEnd(16)} → preferred=${String(result.preferred).padEnd(5)} strict=${String(result.strict).padEnd(6)} ${ok ? '✓' : '✗ 未识别'}`,
  );
}

console.log('\n=== 完整句子 ===\n');
for (const text of ['只要两房，预算500万', '想看浦东两房', '两房最好，三房也可以']) {
  const result = parseRequirementByRules(text);
  console.log(`${JSON.stringify(text)} → bedrooms=${JSON.stringify(result.bedrooms)}`);
}
