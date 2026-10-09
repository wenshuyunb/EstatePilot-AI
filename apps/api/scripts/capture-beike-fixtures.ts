/**
 * 抓取贝壳真实响应并保存为 fixture。
 *
 * 用途：让详情解析器的测试**不依赖网络**，避免被限流打断
 * （贝壳密集调用后会返回 `service temporarily unavailable`）。
 *
 * 保存的是**未经修改的原始响应**，因此可以放心用它验证解析逻辑。
 *
 * 用法：node --experimental-strip-types scripts/capture-beike-fixtures.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BeikeDirectClient } from '../dist/modules/property/providers/beike/beike-direct-client.js';
import { BeikeResponseParser } from '../dist/modules/property/providers/beike/beike-response-parser.js';

const FIXTURE_DIR = path.resolve(process.cwd(), 'scripts', 'fixtures');

async function main(): Promise<void> {
  const apiKey = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
  if (!apiKey) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });

  const client = new BeikeDirectClient({ apiKey }, new BeikeResponseParser());

  console.log('1) 搜索房源…');
  const search = await client.callTool('house_search', {
    city_name: '厦门',
    query: '集美区 三房',
  });

  if (!search.ok) {
    console.error(`   搜索失败：${String(search.error).slice(0, 160)}`);
    console.error('   可能被限流，请等 1-2 分钟后重试');
    process.exit(1);
  }

  // 房源 ID 格式是 `<105121510498>`（尖括号，无引号）
  const ids = [...search.text.matchAll(/<(\d{9,})>/g)].map((m) => m[1]).slice(0, 1);
  if (ids.length === 0) {
    console.error('   未提取到房源 ID');
    process.exit(1);
  }
  console.log(`   房源 ID: ${ids[0]}`);

  console.log('2) 抓取详情…');
  const detail = await client.callTool('entity_detail', {
    city_name: '厦门',
    entity_ids: ids[0]!,
    entity_type: 'house',
  });

  if (!detail.ok) {
    console.error(`   详情失败：${String(detail.error).slice(0, 160)}`);
    process.exit(1);
  }

  writeFileSync(path.join(FIXTURE_DIR, 'beike-entity-detail.txt'), detail.text, 'utf8');
  console.log(`   已保存（${detail.text.length} 字符）`);

  // 间隔，避免限流
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log('3) 抓取图片…');
  const material = await client.callTool('entity_material', {
    city_name: '厦门',
    entity_ids: ids[0]!,
    entity_type: 'house',
    fields: ['房源图片'],
  });

  if (!material.ok) {
    console.error(`   图片失败：${String(material.error).slice(0, 160)}`);
    process.exit(1);
  }

  writeFileSync(path.join(FIXTURE_DIR, 'beike-entity-material.txt'), material.text, 'utf8');
  console.log(`   已保存（${material.text.length} 字符）`);

  console.log('');
  console.log(`完成。fixture 目录：${FIXTURE_DIR}`);
  console.log('现在可以离线运行：node --experimental-strip-types scripts/test-detail-parser-offline.ts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
