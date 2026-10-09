/**
 * 对比「搜索」与「详情」两种响应的字段结构差异。
 *
 * 背景：搜索能解析出总价，详情解析不出 —— 说明两者字段结构不同。
 * 用法：node --experimental-strip-types --no-warnings scripts/debug-detail-fields.ts
 */

import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';

const fakeConfig = {} as never;

async function main(): Promise<void> {
  const client = new BeikeMcpClient(fakeConfig);

  const ids = ['107000000927', '107000002201'];

  console.log('=== 详情响应：原始 data（前 2500 字符）===');
  const detail = await client.fetchDetails({ city: '上海', ids, entityType: 'house' });

  console.log(`实体数: ${detail.parsed.entities.length}`);
  for (const entity of detail.parsed.entities) {
    console.log(`\n[${entity.kind}] ${entity.id}`);
    console.log(`字段数: ${Object.keys(entity.fields).length}`);
    for (const [k, v] of Object.entries(entity.fields)) {
      const text = JSON.stringify(v);
      console.log(`  ${k}: ${text.length > 150 ? `${text.slice(0, 150)}...` : text}`);
    }
  }

  console.log(`\n\n=== 详情 rawData 中与价格相关的片段 ===`);
  const data = detail.parsed.rawData;
  const priceMatches = [...data.matchAll(/[^"\\]{0,30}(?:价格|总价|万)[^"\\]{0,40}/g)];
  const seen = new Set<string>();
  for (const match of priceMatches) {
    const text = match[0];
    if (seen.has(text)) continue;
    seen.add(text);
    console.log(`  ${JSON.stringify(text)}`);
    if (seen.size >= 25) break;
  }
}

main().catch(console.error);
