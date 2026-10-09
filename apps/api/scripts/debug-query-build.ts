/**
 * 调试：搜索条件生成与贝壳检索。
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/debug-query-build.ts
 */

import { parseRequirementByRules } from '../dist/modules/requirement/chinese-expression-parser.js';
import { PropertySearchQueryBuilder } from '../dist/modules/requirement/property-search-query-builder.service.js';
import { RequirementMergeService, createEmptyProfile } from '../dist/modules/requirement/requirement-merge.service.js';
import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';
import { BeikePropertyProvider } from '../dist/modules/property/providers/beike/beike-property.provider.js';

const fakeConfig = {} as never;

async function main(): Promise<void> {
  const message = '想看浦东三房，500左右';

  console.log('=== 1. 规则解析 ===');
  const extraction = parseRequirementByRules(message);
  console.log(`city: ${JSON.stringify(extraction.city)}`);
  console.log(`districts: ${JSON.stringify(extraction.districts)}`);
  console.log(`bedrooms: ${JSON.stringify(extraction.bedrooms)}`);
  console.log(`budget: ${JSON.stringify(extraction.budget)}`);
  console.log(`summary: ${extraction.summary}`);

  console.log('\n=== 2. 合并 ===');
  const merger = new RequirementMergeService();
  const mergeResult = merger.merge(createEmptyProfile(), extraction);
  console.log(`merged.city: ${JSON.stringify(mergeResult.merged.city)}`);
  console.log(`merged.districts: ${JSON.stringify(mergeResult.merged.districts)}`);
  console.log(`merged.budgetTarget: ${mergeResult.merged.budgetTarget}`);
  console.log(`merged.budgetNormalMax: ${mergeResult.merged.budgetNormalMax}`);
  console.log(`merged.bedrooms: ${JSON.stringify(mergeResult.merged.bedrooms)}`);

  console.log('\n=== 3. 生成搜索条件 ===');
  const builder = new PropertySearchQueryBuilder();
  const built = builder.build(mergeResult.merged);
  console.log(`naturalQuery: ${JSON.stringify(built.query.naturalQuery)}`);
  console.log(`naturalQuery 码点: [${[...built.query.naturalQuery].map((c) => c.codePointAt(0)?.toString(16)).join(',')}]`);
  console.log(`city: ${JSON.stringify(built.query.city)}`);
  console.log(`budgetMax: ${built.query.budgetMax}`);
  console.log(`bedrooms: ${JSON.stringify(built.query.bedrooms)}`);
  console.log(`hardConditions: ${JSON.stringify(built.hardConditionSummary)}`);
  console.log(`rationale: ${built.query.rationale}`);

  console.log('\n=== 4. 直接调用贝壳（用生成的 query）===');
  const client = new BeikeMcpClient(fakeConfig);

  for (const query of [built.query.naturalQuery, '浦东 3居室 550万以内', '浦东三房', '上海 浦东 三居室']) {
    try {
      const result = await client.searchHouses({ city: built.query.city, query, houseType: 'second' });
      const houses = result.parsed.entities.filter((entity) => entity.kind === 'house');
      console.log(
        `  query=${JSON.stringify(query)} → 召回 ${result.parsed.overview.totalRecalled}，实体 ${result.parsed.entities.length}，house ${houses.length}`,
      );
      if (houses.length > 0) {
        const provider = new BeikePropertyProvider(client);
        const mapped = await provider.mapEntitiesForReuse(houses.slice(0, 3), built.query.city);
        for (const property of mapped) {
          console.log(
            `     · ${property.community} ${property.bedrooms}室 ${property.area}㎡ ` +
              `${property.totalPrice / 10000}万 | ${property.district}/${property.subDistrict} | 状态 ${property.listingStatus}`,
          );
        }
      }
    } catch (error) {
      console.log(`  query=${JSON.stringify(query)} → 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch(console.error);
