/**
 * 「标签」字段解析验证。
 *
 * 背景：推荐卡片上出现过「月」这个无意义标签，并且因为多个房源都有它，
 * React 报了 key 重复错误。
 *
 * 根因（看真实原文才搞清）：「标签」字段不是纯标签列表，而是
 * 「小区基础信息 + 房源标签」的合并文本，**顶层分隔符是中文逗号 `，`**，
 * `/` 只是同一信息块内部的分隔符。无脑按 `/` 切分就会切出 "月"、"年)" 这类碎片。
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/debug-tags.ts
 */

import { BeikeFieldMapper } from '../dist/modules/property/providers/beike/beike-response-parser.js';

interface TagCase {
  name: string;
  raw: string;
  /** 必须出现的标签 */
  mustInclude: string[];
  /** 必须不出现的碎片 */
  mustExclude: string[];
}

const cases: TagCase[] = [
  {
    name: '真实数据：玉兰香苑(四期)',
    raw:
      '玉兰香苑(四期)(小区ID:5011102207585)，2008年建成(楼龄18年)，板楼/塔楼，2232户，' +
      '容积率4.0，绿化率35%，物业费0.45元/平米/月，租售比2.43%，' +
      '车位配比1:0.5(租车位车位600元/年)，刷卡门禁/有监控/封闭式小区/非人车分流/' +
      '小区门禁/单元门禁/卧室带卫生间/带飘窗/厨房带窗/卫生间带窗/客卫/客厅带阳台/' +
      '带阳台/南北通透/客厅朝南/主卧朝南/不带车位/有抵押/有单元门禁/无钥匙/有学位，' +
      '唐镇捡漏榜-第2名',
    mustInclude: [
      '2008年建成(楼龄18年)',
      '2232户',
      '容积率4.0',
      '绿化率35%',
      '物业费0.45元/平米/月',
      '租售比2.43%',
      '车位配比1:0.5(租车位车位600元/年)',
      '南北通透',
      '客厅朝南',
      '有学位',
      '唐镇捡漏榜-第2名',
    ],
    // 注意：板楼/塔楼是**合法建筑类型标签**，不是碎片，因此不列入排除项。
    // 真正的碎片是"月"、"年)"、"平米"这类被切断的计量单位。
    mustExclude: ['月', '年)', '平米', '元'],
  },
  {
    name: '真实数据：川杨新苑(二期)',
    raw:
      '川杨新苑(二期)(小区ID:5011102207586)，2008年建成(楼龄18年)，板楼/平房，1122户，' +
      '容积率1.9，绿化率30%，物业费2.0元/平米/月，车位配比1:0.4(租车位车位50元/月)，' +
      '有监控/封闭式小区/非人车分流/小区门禁/单元门禁/朝向好/不带车位/高性价比/适合刚改',
    mustInclude: [
      '2008年建成(楼龄18年)',
      '1122户',
      '物业费2.0元/平米/月',
      '车位配比1:0.4(租车位车位50元/月)',
      '高性价比',
      '适合刚改',
    ],
    mustExclude: ['月', '月)', '平米'],
  },
  {
    name: '只有标签（无小区信息）',
    raw: '带落地窗/厨房带窗/南北通透/客厅朝南',
    mustInclude: ['带落地窗', '厨房带窗', '南北通透', '客厅朝南'],
    mustExclude: [],
  },
  {
    name: '重复标签要去重',
    raw: '南北通透/南北通透，客厅朝南，月/月',
    mustInclude: ['南北通透', '客厅朝南'],
    mustExclude: ['月'],
  },
];

console.log('「标签」字段解析验证\n');

// parseTags 是私有方法，用类型断言访问（仅测试脚本使用）
const mapper = new BeikeFieldMapper() as unknown as {
  parseTags: (value: unknown) => string[];
};

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  const actual = mapper.parseTags(testCase.raw);

  const missing = testCase.mustInclude.filter((tag) => !actual.includes(tag));
  const leaked = testCase.mustExclude.filter((tag) => actual.includes(tag));
  const ok = missing.length === 0 && leaked.length === 0;

  if (ok) passed += 1;
  else failed += 1;

  console.log(`${ok ? '✓' : '✗'} ${testCase.name}`);
  console.log(`   解析出 ${actual.length} 个标签: ${JSON.stringify(actual)}`);
  if (missing.length > 0) console.log(`   ✗ 缺少: ${JSON.stringify(missing)}`);
  if (leaked.length > 0) console.log(`   ✗ 出现碎片: ${JSON.stringify(leaked)}`);
  console.log('');
}

console.log(`通过 ${passed} 项，失败 ${failed} 项`);

// 额外检查：不应有任何单字标签（单字标签基本都是碎片）
console.log('\n=== 单字标签检查 ===');
let singleCharTotal = 0;
for (const testCase of cases) {
  const single = mapper.parseTags(testCase.raw).filter((tag) => tag.length === 1);
  if (single.length > 0) {
    console.log(`  ✗ ${testCase.name}: ${JSON.stringify(single)}`);
    singleCharTotal += single.length;
  }
}
console.log(singleCharTotal === 0 ? '  ✓ 无单字碎片' : `  ✗ 共 ${singleCharTotal} 个`);

process.exit(failed > 0 || singleCharTotal > 0 ? 1 : 0);
