/**
 * 调试：贝壳实体 → 领域模型的映射结果。
 *
 * 目的：确认 district / subDistrict 在映射后是否保留。
 */

import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';
import { BeikeFieldMapper } from '../dist/modules/property/providers/beike/beike-response-parser.js';

const fakeConfig = {} as never;

async function main(): Promise<void> {
  const client = new BeikeMcpClient(fakeConfig);
  const mapper = new BeikeFieldMapper();

  const result = await client.searchHouses({
    city: '上海',
    query: '张江 3居室 500万以内 较新小区',
    houseType: 'second',
  });

  const houses = result.parsed.entities.filter((entity) => entity.kind === 'house');
  console.log(`house 实体 ${houses.length} 个\n`);

  for (const house of houses.slice(0, 5)) {
    const rawDistrict = house.fields['所属城区'];
    const rawBusiness = house.fields['所属商圈'];

    const mapped = mapper.mapEntity(house, { city: '上海' });

    console.log(`--- ${house.fields['小区名称'] ?? house.id} ---`);
    console.log(`  原始: 所属城区=${JSON.stringify(rawDistrict)} 所属商圈=${JSON.stringify(rawBusiness)}`);
    if (mapped) {
      console.log(
        `  映射: district=${JSON.stringify(mapped.district)} subDistrict=${JSON.stringify(mapped.subDistrict)} city=${JSON.stringify(mapped.city)}`,
      );
      console.log(`        总价=${mapped.totalPrice} 面积=${mapped.area} 状态=${mapped.listingStatus}`);
    } else {
      console.log('  映射: 失败（返回 null）');
    }
    console.log('');
  }

  // 统计
  const mappedAll = houses.map((house) => mapper.mapEntity(house, { city: '上海' })).filter(Boolean);
  const withDistrict = mappedAll.filter((item) => item && item.district && item.district.length > 0);
  console.log(`映射成功 ${mappedAll.length}/${houses.length}，其中 district 非空 ${withDistrict.length} 个`);
}

main().catch(console.error);
