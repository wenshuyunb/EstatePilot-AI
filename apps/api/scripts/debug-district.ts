/**
 * 调试：贝壳响应中的区域字段提取。
 *
 * 背景：推荐结果里 district 全为空（界面显示"区域待确认"）。
 * 需要确认 贝壳响应里到底有没有区域信息，以及提取失败在哪一步。
 */

import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';
import { BeikeResponseParser } from '../dist/modules/property/providers/beike/beike-response-parser.js';

const fakeConfig = {} as never;

async function main(): Promise<void> {
  const client = new BeikeMcpClient(fakeConfig);

  console.log('=== 搜索「张江 3居室 500万以内 较新小区」 ===');
  const result = await client.searchHouses({
    city: '上海',
    query: '张江 3居室 500万以内 较新小区',
    houseType: 'second',
  });

  const parser = new BeikeResponseParser();
  const houses = result.parsed.entities.filter((entity) => entity.kind === 'house');
  console.log(`house 实体: ${houses.length} 个\n`);

  for (const house of houses.slice(0, 3)) {
    console.log(`--- ${house.id} ---`);
    for (const [key, value] of Object.entries(house.fields)) {
      const text = JSON.stringify(value);
      console.log(`  ${key}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
    }
    console.log('');
  }

  // 单独检查区位交通字段的实际内容
  console.log('=== 「区位交通」字段原文 ===');
  for (const house of houses.slice(0, 5)) {
    const location = house.fields['区位交通'];
    console.log(`  ${house.id}: ${JSON.stringify(location)}`);
  }

  // 验证区域提取正则
  console.log('\n=== 区域提取正则测试 ===');
  const samples = [
    '位于浦东张江板块张江汤臣豪园(四期)小区，距离张江高科(地铁站)地铁站步行距离884米',
    '位于浦东唐镇板块张江公馆小区，距离高科中路地铁站步行距离662米',
    '位于浦东张江板块川杨新苑(六期)小区',
    '位于浦东新区南码头上海市浦东新区雪野路999号',
  ];

  for (const sample of samples) {
    const m = /位于\s*([\u4e00-\u9fff]{2,4}?)([\u4e00-\u9fff]{2,6}?)板块/.exec(sample);
    const fallback = /位于\s*([\u4e00-\u9fff]{2,4}(?:新区|区|县))/.exec(sample);
    console.log(`  ${sample.slice(0, 30)}…`);
    console.log(`    板块正则 → district=${JSON.stringify(m?.[1])} businessArea=${JSON.stringify(m?.[2])}`);
    console.log(`    兜底正则 → ${JSON.stringify(fallback?.[1])}`);
  }
}

main().catch(console.error);
