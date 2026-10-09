/**
 * 探测 entity_material 能返回哪些图片资源。
 *
 * 用途：决定房源卡片能展示多少图片（目前只拿到户型图）。
 * 贝壳详情里已经带了「户型图片」URL，本脚本试不同 fields 看能否拿到
 * 实景图 / 小区图 / VR。
 */

import { BeikeDirectClient } from '../dist/modules/property/providers/beike/beike-direct-client.js';
import { BeikeResponseParser } from '../dist/modules/property/providers/beike/beike-response-parser.js';

async function main(): Promise<void> {
  const apiKey = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
  if (!apiKey) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  const client = new BeikeDirectClient({ apiKey }, new BeikeResponseParser());

  // 先搜一套房源
  const search = await client.callTool('house_search', {
    city_name: '厦门',
    query: '集美区 三房',
  });

  // 房源 ID 的格式是 `<105121510498>`（尖括号，无引号）
  const ids = [...search.text.matchAll(/<(\d{9,})>/g)].map((m) => m[1]).slice(0, 1);
  console.log(`房源 ID: ${ids[0] ?? '(未找到)'}\n`);

  if (ids.length === 0) return;

  const fieldVariants: string[][] = [
    ['房源图片'],
    ['小区图片'],
    ['房屋图片'],
    ['实景图'],
    ['全部'],
    ['图片'],
  ];

  for (const fields of fieldVariants) {
    const result = await client.callTool('entity_material', {
      city_name: '厦门',
      entity_ids: ids[0]!,
      entity_type: 'house',
      fields,
    });

    console.log(`fields=${JSON.stringify(fields)}`);
    console.log(`  ok=${result.ok} | ${result.text.length} 字符`);

    if (!result.ok) {
      console.log(`  错误: ${String(result.error).slice(0, 160)}`);
      console.log('');
      continue;
    }

    const urls = [...result.text.matchAll(/https?:\/\/[^\s"',)]+/g)].map((m) => m[0]);
    console.log(`  图片 URL: ${urls.length} 个`);
    for (const url of urls.slice(0, 5)) {
      console.log(`    ${url.slice(0, 120)}`);
    }

    // 打印前 400 字看结构
    if (urls.length === 0) {
      console.log(`  内容: ${result.text.slice(0, 400).replace(/\n/g, ' ')}`);
    }
    console.log('');

    // 避免触发限流
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
