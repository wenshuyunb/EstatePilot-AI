/**
 * 调试：规则解析器对城市/区域的识别。
 *
 * 目的：确认 extractCity / extractLocations 是否可靠，
 * 以及"上海"这类字符在脚本内是否正确。
 */

import { parseRequirementByRules, extractCity, extractLocations } from '../dist/modules/requirement/chinese-expression-parser.js';

const cases = [
  '想看浦东三房，500左右',
  '还是想看张江附近吧，三房最好，550左右',
  '上海浦东三房',
  '浦东三房',
  '张江 三房 600万以内',
];

console.log('=== 逐条测试城市与区域识别 ===\n');

for (const text of cases) {
  const points = [...text].slice(0, 12).map((c) => c.codePointAt(0)?.toString(16)).join(',');

  const city = extractCity(text);
  const locations = extractLocations(text);
  const full = parseRequirementByRules(text);

  console.log(`输入: ${JSON.stringify(text)}`);
  console.log(`  码点: [${points}]`);
  console.log(`  extractCity → ${JSON.stringify(city)}`);
  console.log(`  districts → ${JSON.stringify(locations.districts)}`);
  console.log(`  subDistricts → ${JSON.stringify(locations.subDistricts)}`);
  console.log(`  parseRequirementByRules.city → ${JSON.stringify(full.city)}`);
  console.log(`  summary → ${full.summary}`);
  console.log('');
}

console.log('=== 直接检查「上海」是否在已知城市列表中 ===');
const shanghai = '上海';
console.log(`"上海" 码点: [${[...shanghai].map((c) => c.codePointAt(0)?.toString(16)).join(',')}]`);
console.log(`"上海浦东三房".includes("上海") = ${'上海浦东三房'.includes('上海')}`);
console.log(`extractCity("上海浦东三房") = ${JSON.stringify(extractCity('上海浦东三房'))}`);
