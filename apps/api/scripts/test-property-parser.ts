/**
 * 测试房源文本解析器的真实能力。
 *
 * 用经纪人日常真实会遇到的房源文案格式，验证能解析出多少字段。
 * 这是"手动录入住"方案可行性的关键验证 —— 如果解析器不可用，
 * 录入界面就得退化成纯手工表单（体验差很多）。
 */

import { PropertyTextParserService } from '../dist/modules/property/property-text-parser.service.js';

/** 经纪人真实会粘贴的几种格式 */
const SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'A. 微信群转发格式（最常见）',
    text: `【小区】建发央玺
【户型】3室2厅
【面积】118平
【总价】530万
【楼层】中层/33层
【朝向】南北
【装修】精装
【建成】2018年

【小区】中骏天峰
【户型】4室2厅
【面积】143平
【总价】780万
【楼层】高层/45层
【装修】豪装
【建成】2020年`,
  },
  {
    label: 'B. 无标签紧凑格式',
    text: `国贸天琴湾 3室2厅 128平 620万 中层 精装
世茂湖滨首府 4室2厅 165平 950万 高层 豪装
禹洲世贸商城 2室1厅 89平 380万 低层 简装`,
  },
  {
    label: 'C. 混合格式（带小区描述与配套）',
    text: `五缘湾 建发央玺 118平 3房 530万 精装修 满五唯一
位于五缘湾核心区，双地铁口，学区房

湖里 中骏天峰 143平 4房 780万 豪华装修
2020年交房，物业好，看海景`,
  },
  {
    label: 'D. JSON 格式（系统对接用）',
    text: JSON.stringify([
      {
        community: '万科湖心岛',
        bedrooms: 3,
        area: 118,
        totalPrice: 5300000,
        floor: '中层',
        decoration: '精装',
        city: '厦门',
        district: '湖里区',
      },
    ]),
  },
];

function main(): void {
  const parser = new PropertyTextParserService();

  console.log('房源文本解析器能力测试\n');

  for (const sample of SAMPLES) {
    console.log('='.repeat(74));
    console.log(sample.label);
    console.log('='.repeat(74));

    const result = parser.parse(sample.text, { city: '厦门' });

    console.log(`  总块数: ${result.summary.totalBlocks} | 解析出: ${result.summary.parsedBlocks} | 可导入: ${result.summary.importable}`);
    console.log('');

    for (const [index, draft] of result.drafts.entries()) {
      const f = draft.fields;
      console.log(`  第 ${index + 1} 条${draft.importable ? '' : '  ⚠ 不可导入'}`);
      console.log(`    小区:   ${f.community ?? '—'}`);
      console.log(`    户型:   ${f.bedrooms ?? '—'} 室 ${f.livingRooms ?? '—'} 厅`);
      console.log(`    面积:   ${f.area ?? '—'} ㎡`);
      console.log(`    总价:   ${f.totalPrice ? `${Number(f.totalPrice) / 10000}万` : '—'}`);
      console.log(`    楼层:   ${f.floor ?? '—'}   朝向: ${f.orientation ?? '—'}`);
      console.log(`    装修:   ${f.decoration ?? '—'}   建成: ${f.builtYear ?? '—'}`);
      console.log(`    区域:   ${f.district ?? '—'} / ${f.subDistrict ?? '—'}`);
      if (draft.missingFields.length > 0) {
        console.log(`    缺失:   ${draft.missingFields.join('、')}`);
      }
      if (draft.warnings.length > 0) {
        console.log(`    警告:   ${draft.warnings.join('；')}`);
      }
      console.log('');
    }
    console.log('');
  }
}

main();
