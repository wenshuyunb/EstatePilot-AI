/**
 * 调试：用真实 detail 响应测试解析与映射。
 * 用法：node --experimental-strip-types scripts/debug-detail.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { BeikeResponseParser, BeikeFieldMapper } from '../dist/modules/property/providers/beike/beike-response-parser.js';

const execFileAsync = promisify(execFile);
const CLI = 'D:/Projects/EstatePilot-AI/infrastructure/beike/bin/beike.exe';
const KEY = process.env.BEIKE_MCP_API_KEY ?? '';

async function main(): Promise<void> {
  const { stdout } = await execFileAsync(
    CLI,
    ['buy', 'detail', '-c', '上海', '-t', 'house', '--id', '107112596630', '--json'],
    {
      timeout: 60_000,
      maxBuffer: 40 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, BEIKE_MCP_API_KEY: KEY },
    },
  );

  writeFileSync('D:/Projects/EstatePilot-AI/.tmp-beike/detail-raw.txt', stdout, 'utf8');

  const parser = new BeikeResponseParser();
  const parsed = parser.parse(stdout);

  console.log(`实体数: ${parsed.entities.length}`);
  for (const entity of parsed.entities) {
    console.log(`\n--- [${entity.kind}] ${entity.id} ---`);
    console.log(`字段数: ${Object.keys(entity.fields).length}`);
    console.log(`字段键: ${Object.keys(entity.fields).join(', ')}`);
  }

  const houses = parsed.entities.filter((e) => e.kind === 'house');
  console.log(`\nhouses: ${houses.length}`);

  const mapper = new BeikeFieldMapper();
  for (const house of houses) {
    const mapped = mapper.mapEntity(house, { city: '上海' });
    if (mapped) {
      console.log(`\n✓ 映射成功:`);
      console.log(`  标题: ${mapped.title}`);
      console.log(`  小区: ${mapped.community} | ${mapped.district}/${mapped.subDistrict}`);
      console.log(`  价格: ${mapped.totalPrice}元 (${mapped.totalPrice / 10000}万) | 单价 ${mapped.unitPrice}`);
      console.log(`  户型: ${mapped.bedrooms}室${mapped.livingRooms}厅${mapped.bathrooms}卫 | ${mapped.area}㎡`);
      console.log(`  楼层: ${mapped.floor}/${mapped.totalFloors} | 朝向 ${mapped.orientation} | 装修 ${mapped.decoration}`);
      console.log(`  建成年份: ${mapped.buildYear}`);
      console.log(`  地铁: ${mapped.subwayDistance}米`);
      console.log(`  学区: ${JSON.stringify(mapped.schoolInfo)}`);
      console.log(`  图片: ${mapped.images.length} 张 | 户型图: ${mapped.floorPlan.length} 张`);
      console.log(`  标签: ${mapped.tags.slice(0, 8).join('、')}`);
      console.log(`  经纬度: ${mapped.longitude}, ${mapped.latitude}`);
    } else {
      console.log(`\n✗ 映射失败 (${house.id})`);
      console.log(`  关键字段检查:`);
      console.log(`    总价: ${JSON.stringify(house.fields['总价'])}`);
      console.log(`    建筑面积: ${JSON.stringify(house.fields['建筑面积'])}`);
      console.log(`  全部字段:`);
      for (const [k, v] of Object.entries(house.fields)) {
        console.log(`    ${k}: ${JSON.stringify(v).slice(0, 120)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
