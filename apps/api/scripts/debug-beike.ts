/**
 * 贝壳响应解析器验证（用真实 CLI 输出，不依赖 API 与数据库）。
 *
 * 用途：定位「CLI 有结果但 API 返回 0 条」这类问题。
 * 用法：node --experimental-strip-types --experimental-transform-types scripts/debug-beike.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BeikeResponseParser, BeikeFieldMapper } from '../dist/modules/property/providers/beike/beike-response-parser.js';

const execFileAsync = promisify(execFile);

const CLI = 'D:/Projects/EstatePilot-AI/infrastructure/beike/bin/beike.exe';
const KEY = process.env.BEIKE_MCP_API_KEY ?? '';

async function runCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(CLI, args, {
    timeout: 60_000,
    maxBuffer: 40 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, BEIKE_MCP_API_KEY: KEY },
  });
  return stdout;
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error('请设置 BEIKE_MCP_API_KEY 环境变量');
    process.exit(1);
  }

  const scenarios = [
    { label: '浦东三房 500万以内', args: ['buy', 'search', '-c', '上海', '-q', '浦东三房 500万以内', '--house-type', 'second', '--json'] },
    { label: '浦东三房（无价格）', args: ['buy', 'search', '-c', '上海', '-q', '浦东三房', '--house-type', 'second', '--json'] },
    { label: '自然语言查询', args: ['buy', 'search', '-c', '上海', '-q', '浦东 3居室 500万以内', '--house-type', 'second', '--json'] },
  ];

  const parser = new BeikeResponseParser();
  const mapper = new BeikeFieldMapper();

  for (const scenario of scenarios) {
    console.log(`\n${'='.repeat(78)}`);
    console.log(`场景：${scenario.label}`);
    console.log('='.repeat(78));

    try {
      const stdout = await runCli(scenario.args);
      console.log(`stdout 长度: ${stdout.length}`);

      const parsed = parser.parse(stdout);
      console.log(`解析结果：实体 ${parsed.entities.length} 个`);
      console.log(`  总召回: ${parsed.overview.totalRecalled}`);
      console.log(`  展示数: ${parsed.overview.displayedCount}`);
      console.log(`  命中条件: ${parsed.overview.matchedConditions.length} 条`);

      // 按类型统计
      const byKind = new Map<string, number>();
      for (const entity of parsed.entities) {
        byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1);
      }
      console.log(`  实体类型分布: ${[...byKind.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

      // 映射测试
      let mapped = 0;
      let mappingFailed = 0;
      const houses = parsed.entities.filter((e) => e.kind === 'house');

      if (houses.length === 0 && parsed.entities.length > 0) {
        console.log(`\n  ⚠️ 没有识别出 house 类型实体。前 3 个实体的字段键：`);
        for (const entity of parsed.entities.slice(0, 3)) {
          console.log(`    [${entity.kind}] ${entity.id}: ${Object.keys(entity.fields).slice(0, 15).join(', ')}`);
        }
      }

      for (const entity of houses) {
        const property = mapper.mapEntity(entity, { city: '上海' });
        if (property) {
          mapped += 1;
          if (mapped <= 2) {
            console.log(`\n  ✓ ${property.title}`);
            console.log(`    ${property.community} | ${property.district}/${property.subDistrict}`);
            console.log(`    ${property.totalPrice / 10000}万 | ${property.unitPrice}元/㎡ | ${property.bedrooms}室${property.livingRooms}厅${property.bathrooms}卫 | ${property.area}㎡`);
            console.log(`    楼层 ${property.floor}/${property.totalFloors} | ${property.orientation} | ${property.decoration} | ${property.buildYear}年`);
            console.log(`    地铁 ${property.subwayDistance}米 | 图片 ${property.images.length} 张`);
            if (property.schoolInfo) console.log(`    学区 ${JSON.stringify(property.schoolInfo)}`);
          }
        } else {
          mappingFailed += 1;
        }
      }

      console.log(`\n  映射成功 ${mapped} 套，失败 ${mappingFailed} 套`);

      if (mapped === 0 && houses.length > 0) {
        console.log(`\n  ⚠️ 映射全部失败。第一个实体的原始字段：`);
        const first = houses[0];
        if (first) {
          for (const [k, v] of Object.entries(first.fields).slice(0, 30)) {
            console.log(`    ${k}: ${JSON.stringify(v).slice(0, 100)}`);
          }
        }
      }
    } catch (error) {
      console.error(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error('脚本异常：', error);
  process.exit(1);
});
