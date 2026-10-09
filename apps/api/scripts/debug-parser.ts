/**
 * 解析器单元验证（直接调用已编译的解析服务，不依赖 API 与数据库）。
 *
 * 为什么用编译产物而不是源码：NestJS 使用 TypeScript 装饰器，
 * Node 24 的原生类型剥离不支持装饰器语法（需要 tsc/swc 编译）。
 * 因此这里 import dist 里的编译结果。
 *
 * 用法：
 *   node --experimental-strip-types scripts/debug-parser.ts
 *   前置：pnpm --filter @estatepilot/api build
 */

import { PropertyTextParserService } from '../dist/modules/property/property-text-parser.service.js';

const parser = new PropertyTextParserService();

const samples: Array<{ label: string; text: string }> = [
  {
    label: 'A. 带标签逐行（贝壳后台复制）',
    text: `小区名称：碧云国际社区
户型：3室2厅1卫
建筑面积：128.5平米
总价：1250万
单价：97276元/平
所在楼层：中层/18层
朝向：南北
装修：精装修
建筑年代：2012年
所在区域：浦东新区
板块：金桥
地铁：9号线 金桥站 约650米
学校：福山外国语小学 / 建平中学西校
标签：满五唯一，南北通透，精装`,
  },
  {
    label: 'B. 紧凑单行（列表页复制）',
    text: `徐家汇花园 3室2厅 128.5㎡ 1580万 精装 中层/18层
春申景城 2室1厅 88㎡ 520万 简装 高楼层/11层`,
  },
  {
    label: 'C. 中文楼层（无斜杠）',
    text: `小区名称：大宁金茂府
户型：4室2厅2卫
建筑面积：186平米
总价：2280万
所在楼层：低楼层
总楼层：26层
朝向：南北
装修：豪华装修
所在区域：静安区`,
  },
];

for (const sample of samples) {
  console.log(`\n${'='.repeat(76)}`);
  console.log(sample.label);
  console.log('='.repeat(76));

  const result = parser.parse(sample.text, { city: '上海' });
  console.log(`解析出 ${result.drafts.length} 条\n`);

  for (const [index, draft] of result.drafts.entries()) {
    const f = draft.fields;
    console.log(`── 第 ${index + 1} 条（置信度 ${Math.round(draft.confidence * 100)}%）──`);
    console.log(`  小区       ${f.community ?? '(未解析)'}  [${f.district ?? '?'} / ${f.subDistrict ?? '?'}]`);
    console.log(`  户型       ${f.bedrooms ?? '?'}室 ${f.livingRooms ?? '?'}厅 ${f.bathrooms ?? '?'}卫`);
    console.log(`  面积       ${f.area ?? '?'}㎡`);
    console.log(`  总价       ${f.totalPrice ? `${f.totalPrice / 10000}万` : '?'}`);
    console.log(`  单价       ${f.unitPrice ?? '?'}元/㎡`);
    console.log(`  楼层       ${f.floor ?? '?'} / 总 ${f.totalFloors ?? '?'} 层`);
    console.log(`  朝向       ${f.orientation ?? '?'}`);
    console.log(`  装修       ${f.decoration ?? '?'}`);
    console.log(`  建成年份   ${f.buildYear ?? '?'}`);
    console.log(`  地铁距离   ${f.subwayDistance ?? '?'}米`);
    console.log(`  标签       ${f.tags.length > 0 ? f.tags.join('、') : '?'}`);
    if (draft.missingFields.length > 0) console.log(`  ⚠️ 缺失   ${draft.missingFields.join('、')}`);
    if (draft.warnings.length > 0) console.log(`  ⚠️ 告警   ${draft.warnings.join('；')}`);
    console.log('');
  }
}
