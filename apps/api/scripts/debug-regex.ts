/**
 * 解析器调试：逐条打印关键正则的匹配结果。
 * 用法：node --experimental-strip-types scripts/debug-regex.ts
 */

const FIELD_LABELS: Record<string, string[]> = {
  totalFloors: ['总楼层', '楼层总数', '总层数', '楼高'],
  floor: ['所在楼层', '楼层', '当前楼层'],
};

function buildLabelRegex(labels: string[]): RegExp {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:${escaped.join('|')})\\s*[:：=＝]?\\s*([^\\n\\r]{1,120})`, 'i');
}

const text = `小区名称：大宁金茂府
户型：4室2厅2卫
建筑面积：186平米
总价：2280万
所在楼层：低楼层
总楼层：26层
朝向：南北
装修：豪华装修
所在区域：静安区`;

console.log('=== 测试文本 ===');
console.log(text);
console.log('\n=== 逐字段正则匹配 ===');

for (const [key, labels] of Object.entries(FIELD_LABELS)) {
  const regex = buildLabelRegex(labels);
  const match = regex.exec(text);
  console.log(`${key.padEnd(14)} → ${match?.[1] ? JSON.stringify(match[1]) : '未匹配'}`);
}

console.log('\n=== 楼层相关正则 ===');
const patterns: Array<[string, RegExp]> = [
  ['数字斜杠楼层', /(\d{1,3})\s*\/\s*(\d{1,3})\s*层/],
  ['中文斜杠楼层', /(低|中|高|顶)楼?层\s*\/\s*(\d{1,3})\s*层/],
  ['共N层', /共\s*(\d{1,3})\s*层/],
  ['中文楼层(单独)', /(低|中|高|顶)楼?层/],
];

for (const [label, regex] of patterns) {
  const match = regex.exec(text);
  console.log(`${label.padEnd(16)} → ${match ? JSON.stringify(match.slice(1)) : '未匹配'}`);
}

console.log('\n=== 关键：正则是否带 g 标志会影响 lastIndex ===');
console.log('（FIELD_LABELS 的正则不带 g，因此不会出现 lastIndex 问题）');

console.log('\n=== 模拟字段处理循环的执行顺序 ===');
// 复现 parseBlock 里的顺序
const totalFloorsRegex = buildLabelRegex(FIELD_LABELS.totalFloors!);
const floorRegex = buildLabelRegex(FIELD_LABELS.floor!);

console.log('1. 先跑 totalFloors 正则:', JSON.stringify(totalFloorsRegex.exec(text)?.[1]));
console.log('2. 再跑 floor 正则   :', JSON.stringify(floorRegex.exec(text)?.[1]));
console.log('3. 再跑 totalFloors 正则:', JSON.stringify(totalFloorsRegex.exec(text)?.[1]));
