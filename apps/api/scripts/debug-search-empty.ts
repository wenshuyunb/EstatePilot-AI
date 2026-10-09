/**
 * 诊断：为什么 /beike/search 与 /properties/import/preview 返回空。
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/debug-search-empty.ts
 */

import { BeikeResponseParser } from '../dist/modules/property/providers/beike/beike-response-parser.js';
import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';
import { BeikePropertyProvider } from '../dist/modules/property/providers/beike/beike-property.provider.js';

const fakeConfig = {} as never;

async function main(): Promise<void> {
  const client = new BeikeMcpClient(fakeConfig);
  const provider = new BeikePropertyProvider(client);

  console.log('=== 1. 直接调用 CLI 搜索「张江 三房」 ===');
  const result = await client.searchHouses({ city: '上海', query: '张江 三房', houseType: 'second' });

  console.log(`实体数: ${result.parsed.entities.length}`);
  for (const entity of result.parsed.entities) {
    console.log(`  [${entity.kind}] ${entity.id}  字段数=${Object.keys(entity.fields).length}`);
    console.log(`    字段键: ${Object.keys(entity.fields).slice(0, 12).join(', ')}`);
  }
  console.log(`总召回: ${result.parsed.overview.totalRecalled}`);
  console.log(`命中条件: ${result.parsed.overview.matchedConditions.length} 条`);

  // 检查原始响应的标签结构
  const data = result.parsed.rawData;
  console.log(`\n原始数据长度: ${data.length}`);
  const tags = [...new Set([...data.matchAll(/<([^<>\n/][^<>\n]{0,60}?)>/g)].map((m) => m[1]))];
  console.log(`标签: ${tags.join(' | ')}`);
  const hasHouseContainer = data.includes('<房源>');
  console.log(`含 <房源> 容器: ${hasHouseContainer}`);

  // 打印房源容器区域
  const houseStart = data.indexOf('<房源>');
  if (houseStart >= 0) {
    const houseEnd = data.indexOf('</房源>');
    const section = data.slice(houseStart, houseEnd > 0 ? houseEnd + 8 : houseStart + 800);
    console.log(`\n<房源> 区域（前 700 字符）：`);
    console.log(JSON.stringify(section.slice(0, 700)));
  }

  console.log('\n=== 2. 走 Provider.searchForCustomer（与 API 相同路径）===');
  try {
    const properties = await provider.searchForCustomer({
      city: '上海',
      keywords: '张江 三房',
    });
    console.log(`返回 ${properties.length} 套`);
    for (const p of properties.slice(0, 5)) {
      console.log(`  · ${p.community} ${p.bedrooms}室 ${p.area}㎡ ${p.totalPrice / 10000}万`);
    }
  } catch (error) {
    console.log(`抛错: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('\n=== 3. 对比：用 BuildNaturalQuery 生成的 query ===');
  const providerAny = provider as unknown as {
    buildNaturalQuery: (q: Record<string, unknown>) => string;
  };
  try {
    const q1 = providerAny.buildNaturalQuery({ city: '上海', district: '浦东' });
    console.log(`  district=浦东 → "${q1}"`);
  } catch {
    console.log('  buildNaturalQuery 不可直接调用');
  }
}

main().catch(console.error);
