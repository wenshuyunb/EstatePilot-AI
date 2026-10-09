/**
 * 详情解析器离线测试。
 *
 * ============================================================================
 * 为什么用固定 fixture 而不是实时抓取
 * ============================================================================
 * 贝壳有**限流**（实测：密集调用后所有工具返回 `service temporarily
 * unavailable`，耗时约 220ms）。在线测试容易被限流打断，导致：
 *   · 排查时误判成"解析器有 bug"
 *   · CI 里结果不稳定
 *
 * 因此解析逻辑用**真实抓取保存的响应**做离线测试；
 * 在线验证单独放在 `verify-beike-detail.ts`（依赖网络，需限流允许）。
 *
 * fixture 全部来自贝壳真实返回，未做任何修改。
 *
 * 用法：node --experimental-strip-types scripts/test-detail-parser-offline.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { BeikeDetailParser } from '../dist/modules/property/providers/beike/beike-detail-parser.service.js';

const FIXTURE_DIR = path.resolve(process.cwd(), 'scripts', 'fixtures');

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

function main(): void {
  const detailPath = path.join(FIXTURE_DIR, 'beike-entity-detail.txt');
  const materialPath = path.join(FIXTURE_DIR, 'beike-entity-material.txt');

  if (!existsSync(detailPath) || !existsSync(materialPath)) {
    console.error('缺少 fixture 文件，请先运行 scripts/capture-beike-fixtures.ts');
    process.exit(1);
  }

  const detailText = readFileSync(detailPath, 'utf8');
  const materialText = readFileSync(materialPath, 'utf8');

  const parser = new BeikeDetailParser();

  // ========================================================================
  console.log('【详情解析】\n');

  const detail = parser.parseDetail(detailText);

  console.log(`  基础信息: ${detail.base ? Object.keys(detail.base).length : 0} 个字段`);
  console.log(`  小区信息: ${detail.community ? Object.keys(detail.community).length : 0} 个字段`);
  console.log(
    `  周边配套: ${detail.nearby ? Object.values(detail.nearby).reduce((s, l) => s + l.length, 0) : 0} 条`,
  );
  console.log('');

  // 基础信息
  check('解析出基础信息', detail.base !== null);
  check('含建筑面积', Boolean(detail.base?.buildingArea), String(detail.base?.buildingArea));
  check('含单价', Boolean(detail.base?.unitPrice));
  check('含总价', Boolean(detail.base?.totalPrice));
  check('含房屋年限', Boolean(detail.base?.houseAge), String(detail.base?.houseAge));
  check('含电梯', Boolean(detail.base?.hasElevator));
  check('含梯户比例', Boolean(detail.base?.elevatorHouseholdRatio));
  check('含楼型', Boolean(detail.base?.buildingType));
  check('含首付', Boolean(detail.base?.downPayment));
  check('含房源标题', Boolean(detail.base?.title));
  check('标签是数组且已拆分', Array.isArray(detail.base?.tags) && (detail.base?.tags.length ?? 0) > 0);

  // 小区信息
  check('解析出小区信息', detail.community !== null);
  check('含小区名', Boolean(detail.community?.name));
  check('含容积率', Boolean(detail.community?.floorAreaRatio));
  check('含绿化率', Boolean(detail.community?.greeningRate));
  check('含物业费', Boolean(detail.community?.propertyFee));
  check('含物业公司', Boolean(detail.community?.propertyCompany));
  check('含车位配比', Boolean(detail.community?.parkingRatio));
  check('含总户数', detail.community?.totalHouseholds !== null);

  // 周边配套
  check('解析出周边配套', detail.nearby !== null);
  check('有地铁信息', (detail.nearby?.subway.length ?? 0) > 0, `实际 ${detail.nearby?.subway.length ?? 0} 条`);
  check('有公交信息', (detail.nearby?.bus.length ?? 0) > 0);
  check('有学校信息', (detail.nearby?.school.length ?? 0) > 0);
  check('学校带距离', (detail.nearby?.school ?? []).every((s) => s.distanceMeters !== null));
  check('学校带品类（幼儿园/小学/中学）', (detail.nearby?.school ?? []).some((s) => s.category !== null));

  // 排序与去重
  const subway = detail.nearby?.subway ?? [];
  check(
    '地铁按距离升序',
    subway.every(
      (item, index) =>
        index === 0 ||
        item.distanceMeters === null ||
        subway[index - 1]!.distanceMeters === null ||
        subway[index - 1]!.distanceMeters! <= item.distanceMeters,
    ),
  );

  const hospital = detail.nearby?.hospital ?? [];
  const hospitalKeys = hospital.map((h) => `${h.name}|${h.category ?? ''}`);
  check('医院列表已去重', hospitalKeys.length === new Set(hospitalKeys).size);

  const park = detail.nearby?.park ?? [];
  check(
    '公园休闲已过滤非休闲类噪音（如店铺）',
    park.every((p) => p.category !== null),
    `未分类项: ${park.filter((p) => p.category === null).map((p) => p.name).join('、')}`,
  );

  // ========================================================================
  console.log('');
  console.log('【图片解析】\n');

  const material = parser.parseMaterial(materialText);

  console.log(`  图片: ${material.images.length} 张`);
  for (const image of material.images) {
    console.log(`    · [${image.kind}] ${image.roomName ?? '-'}`);
  }
  console.log('');

  check('解析出图片', material.images.length > 0, `实际 ${material.images.length} 张`);
  check('含房间实景图', material.images.some((i) => i.kind === 'ROOM'));
  check('房间实景图带房间名', material.images.some((i) => i.kind === 'ROOM' && i.roomName !== null));
  check('含户型图', material.images.some((i) => i.kind === 'FLOOR_PLAN'));
  check('含 VR 封面', material.images.some((i) => i.kind === 'VR'));
  check('有 VR 跳转地址', Boolean(material.vrUrl));
  check(
    '图片 URL 已按去重',
    material.images.length === new Set(material.images.map((i) => i.url.split('?')[0])).size,
  );
  check('图片 URL 都是 http(s)', material.images.every((i) => i.url.startsWith('http')));

  // ========================================================================
  console.log('');
  console.log('─'.repeat(70));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
