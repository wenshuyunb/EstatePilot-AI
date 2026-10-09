/**
 * 验证房源详情解析器 —— 用真实贝壳数据检查能解析出多少字段。
 *
 * 目的：确认"展示与贝壳 App 同等详细"这个目标达成度。
 *
 * 用法：node --experimental-strip-types scripts/verify-beike-detail.ts
 */

import { BeikeDirectClient } from '../dist/modules/property/providers/beike/beike-direct-client.js';
import { BeikeResponseParser } from '../dist/modules/property/providers/beike/beike-response-parser.js';
import { BeikeDetailParser } from '../dist/modules/property/providers/beike/beike-detail-parser.service.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
  if (!apiKey) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  const client = new BeikeDirectClient({ apiKey }, new BeikeResponseParser());
  const parser = new BeikeDetailParser();

  // 1) 搜一套房源
  const search = await client.callTool('house_search', {
    city_name: '厦门',
    query: '集美区 三房',
  });
  /**
   * ⚠️ 房源 ID 在搜索响应里的格式是 `<105121510498>`（**尖括号包裹，无引号**）。
   *
   * 之前用 `/'(\d{9,})'/g`（要求引号）提取 → 全部匹配不到 →
   * externalId 为 undefined → 详情与图片查询全部落空，
   * 表现为"图片 0 张"。排查时容易误以为是解析器的问题。
   */
  const ids = [...search.text.matchAll(/<(\d{9,})>/g)].map((m) => m[1]).slice(0, 1);

  if (ids.length === 0) {
    console.error('未搜到房源');
    process.exit(1);
  }

  console.log(`房源 ID: ${ids[0]}\n`);

  // 2) 取详情
  const detailResult = await client.callTool('entity_detail', {
    city_name: '厦门',
    entity_ids: ids[0]!,
    entity_type: 'house',
  });

  const detail = parser.parseDetail(detailResult.text);

  console.log('='.repeat(74));
  console.log('【基础信息】');
  console.log('='.repeat(74));
  if (detail.base) {
    for (const [key, value] of Object.entries(detail.base)) {
      if (value === null || (Array.isArray(value) && value.length === 0)) continue;
      console.log(`  ${key.padEnd(24)} ${Array.isArray(value) ? value.join('、') : String(value)}`);
    }
  } else {
    console.log('  (未解析到)');
  }

  console.log('');
  console.log('='.repeat(74));
  console.log('【小区信息】');
  console.log('='.repeat(74));
  if (detail.community) {
    for (const [key, value] of Object.entries(detail.community)) {
      if (value === null || (Array.isArray(value) && value.length === 0)) continue;
      console.log(`  ${key.padEnd(24)} ${Array.isArray(value) ? value.join('、') : String(value)}`);
    }
  } else {
    console.log('  (未解析到)');
  }

  console.log('');
  console.log('='.repeat(74));
  console.log('【周边配套】（按距离排序，只展示最近 3 条）');
  console.log('='.repeat(74));
  if (detail.nearby) {
    for (const [key, list] of Object.entries(detail.nearby)) {
      if (list.length === 0) continue;
      console.log(`  ${key}（共 ${list.length} 条）:`);
      for (const item of list.slice(0, 3)) {
        const distance = item.distanceMeters !== null ? `${item.distanceMeters}米` : '距离未知';
        console.log(`    · ${item.name}  ${distance}  [${item.category ?? '未分类'}]`);
      }
    }
  } else {
    console.log('  (未解析到)');
  }

  // 3) 取图片
  console.log('');
  console.log('='.repeat(74));
  console.log('【图片】');
  console.log('='.repeat(74));

  const materialResult = await client.callTool('entity_material', {
    city_name: '厦门',
    entity_ids: ids[0]!,
    entity_type: 'house',
    fields: ['房源图片'],
  });

  const material = parser.parseMaterial(materialResult.text);

  console.log(`  共 ${material.images.length} 张`);
  for (const image of material.images) {
    const label = image.roomName ?? image.kind;
    console.log(`    · [${image.kind}] ${label.padEnd(10)} ${image.url.slice(0, 80)}`);
  }
  if (material.vrUrl) console.log(`  VR: ${material.vrUrl.slice(0, 80)}`);

  // ========================================================================
  console.log('');
  console.log('='.repeat(74));
  console.log('【验证】');
  console.log('='.repeat(74));

  check('解析到基础信息', detail.base !== null);
  check('基础信息含建筑面积', Boolean(detail.base?.buildingArea));
  check('基础信息含单价', Boolean(detail.base?.unitPrice));
  check('基础信息含房屋年限（满五/满二）', Boolean(detail.base?.houseAge));
  check('基础信息含电梯信息', Boolean(detail.base?.hasElevator));
  check('基础信息含梯户比例', Boolean(detail.base?.elevatorHouseholdRatio));
  check('基础信息含楼型', Boolean(detail.base?.buildingType));
  check('基础信息含首付', Boolean(detail.base?.downPayment));
  check('标签已拆成数组（不是一整串）', Array.isArray(detail.base?.tags));

  check('解析到小区信息', detail.community !== null);
  check('小区含容积率', Boolean(detail.community?.floorAreaRatio));
  check('小区含绿化率', Boolean(detail.community?.greeningRate));
  check('小区含物业费', Boolean(detail.community?.propertyFee));
  check('小区含物业公司', Boolean(detail.community?.propertyCompany));
  check('小区含车位配比', Boolean(detail.community?.parkingRatio));

  check('解析到周边配套', detail.nearby !== null);
  check(
    '周边配套有内容（至少一类非空）',
    detail.nearby
      ? Object.values(detail.nearby).some((list) => list.length > 0)
      : false,
  );
  check(
    '周边配套已按距离排序',
    detail.nearby?.subway
      ? detail.nearby.subway.every(
          (item, index, arr) =>
            index === 0 ||
            item.distanceMeters === null ||
            arr[index - 1]!.distanceMeters === null ||
            arr[index - 1]!.distanceMeters! <= item.distanceMeters,
        )
      : true,
  );

  check('解析到图片', material.images.length > 0, `实际 ${material.images.length} 张`);
  check('图片含房间实景图', material.images.some((i) => i.kind === 'ROOM'));
  check('房间实景图带房间名', material.images.some((i) => i.kind === 'ROOM' && i.roomName !== null));

  console.log('');
  console.log('─'.repeat(70));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  // 统计覆盖度
  const baseCount = detail.base
    ? Object.values(detail.base).filter((v) => v !== null && (!Array.isArray(v) || v.length > 0)).length
    : 0;
  const communityCount = detail.community
    ? Object.values(detail.community).filter((v) => v !== null && (!Array.isArray(v) || v.length > 0)).length
    : 0;
  const nearbyCount = detail.nearby
    ? Object.values(detail.nearby).reduce((sum, list) => sum + list.length, 0)
    : 0;

  console.log('覆盖度统计：');
  console.log(`  基础信息字段: ${baseCount} 个`);
  console.log(`  小区信息字段: ${communityCount} 个`);
  console.log(`  周边配套条目: ${nearbyCount} 条`);
  console.log(`  图片:         ${material.images.length} 张`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证异常：', error);
  process.exit(1);
});
