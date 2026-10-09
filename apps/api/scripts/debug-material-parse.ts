/**
 * 调试：为什么 parseMaterial 返回 0 张图片。
 */

import { BeikeDirectClient } from '../dist/modules/property/providers/beike/beike-direct-client.js';
import { BeikeResponseParser } from '../dist/modules/property/providers/beike/beike-response-parser.js';
import { BeikeDetailParser } from '../dist/modules/property/providers/beike/beike-detail-parser.service.js';

async function main(): Promise<void> {
  const apiKey = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
  const client = new BeikeDirectClient({ apiKey }, new BeikeResponseParser());
  const parser = new BeikeDetailParser();

  const search = await client.callTool('house_search', { city_name: '厦门', query: '集美区 三房' });
  console.log(`search.ok = ${search.ok} | text 长度 = ${search.text.length}`);

  /**
   * ⚠️ 房源 ID 在响应里的格式是 `<105121510498>`（尖括号包裹），
   * **不带引号**。
   *
   * 之前用 `/'(\d{9,})'/g` （带引号）提取 → 全部匹配不到 →
   * externalId 为 undefined → 后续详情/图片全查不到。
   * 这正是"图片 0 张"的真实原因 —— 不是解析器的问题。
   */
  const ids = [...search.text.matchAll(/<(\d{9,})>/g)].map((m) => m[1]).slice(0, 1);

  if (ids.length === 0) {
    console.log('未提取到房源 ID，响应前 600 字：');
    console.log(search.text.slice(0, 600));
    return;
  }

  console.log(`房源 ID: ${ids[0]}`);

  const material = await client.callTool('entity_material', {
    city_name: '厦门',
    entity_ids: ids[0]!,
    entity_type: 'house',
    fields: ['房源图片'],
  });

  console.log(`\nmaterialResult.ok = ${material.ok}`);
  console.log(`materialResult.text 长度 = ${material.text.length}`);
  console.log(`前 200 字: ${material.text.slice(0, 200)}`);

  // 手写 walk 看能否提取到
  const blocks: Array<Record<string, unknown>> = [];
  let index = 0;
  while (index < material.text.length) {
    const start = material.text.indexOf('{', index);
    if (start < 0) break;

    // 简单配对
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < material.text.length; i += 1) {
      const ch = material.text[i]!;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end <= start) { index = start + 1; continue; }

    const candidate = material.text.slice(start, end + 1);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        blocks.push(parsed as Record<string, unknown>);
      }
    } catch (error) {
      console.log(`\n  JSON.parse 失败（长度 ${candidate.length}）: ${String(error).slice(0, 120)}`);
      console.log(`  片段前 200 字: ${candidate.slice(0, 200)}`);
    }
    index = end + 1;
  }

  console.log(`\n提取到 ${blocks.length} 个 JSON 块`);
  for (const block of blocks) {
    console.log(`  顶层键: ${Object.keys(block).join(', ')}`);
  }

  // 用解析器
  const result = parser.parseMaterial(material.text);
  console.log(`\nparseMaterial → ${result.images.length} 张图片, vrUrl=${result.vrUrl ? '有' : '无'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
