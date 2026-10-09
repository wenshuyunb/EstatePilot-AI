/**
 * 厦门（及福建）需求解析验证
 *
 * 为什么需要：系统原先只覆盖上海，用户的主战场是厦门。
 * 如果"思明区三房"解析不出厦门，即使贝壳恢复也搜不到厦门的房子。
 *
 * 验证四件事：
 *   1. 厦门各区/板块能被识别，且能补全所属行政区
 *   2. 客户的真实说话方式能被理解
 *   3. 歧义防护：不会把其他城市的同名区域误判成厦门
 *   4. 上海原有行为**没有回归**（这是最重要的）**
 *
 * 用法：node --experimental-strip-types scripts/verify-xiamen.ts
 */

import {
  parseRequirementByRules,
  extractCityWithSource,
  extractLocations,
} from '../dist/modules/requirement/chinese-expression-parser.js';
import { RequirementExtractorService } from '../dist/modules/requirement/requirement-extractor.service.js';
import { RequirementMergeService, createEmptyProfile } from '../dist/modules/requirement/requirement-merge.service.js';
import { AiService } from '../dist/modules/ai/ai.service.js';
import {
  CITY_BY_SUB_DISTRICT,
  CITY_BY_DISTRICT,
  listCitiesWithAreas,
  districtsBelongingToCity,
} from '../dist/modules/requirement/city-locations.js';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
  }
}

function checkIncludes(name: string, actual: readonly string[], expected: string): void {
  if (actual.includes(expected)) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      期望包含: ${expected}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
  }
}

function checkNotIncludes(name: string, actual: readonly string[], unexpected: string): void {
  if (!actual.includes(unexpected)) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} —— 不应包含 ${unexpected}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  console.log('厦门（及福建）需求解析验证\n');

  // ========================================================================
  console.log('【1】厦门行政区识别 + 城市推断');
  // ========================================================================

  const districts: Array<[string, string]> = [
    ['想看思明区的三房', '思明区'],
    ['湖里区有没有便宜点的', '湖里区'],
    ['集美新城的房子', '集美区'],
    ['海沧区的房子怎么样', '海沧区'],
    ['同安区的房源', '同安区'],
    ['翔安区的房子', '翔安区'],
  ];

  for (const [text, expectedDistrict] of districts) {
    const city = extractCityWithSource(text);
    check(`「${text}」→ 城市=厦门`, city.city, '厦门');

    const loc = extractLocations(text, '厦门');
    checkIncludes(`  ↳ 行政区`, loc.districts, expectedDistrict);
  }

  // ========================================================================
  console.log('');
  console.log('【2】厦门板块识别 + 自动补全行政区');
  // ========================================================================

  const plates: Array<[string, string, string]> = [
    ['五缘湾那边的房子', '五缘湾', '湖里区'],
    ['莲前一带300万左右', '莲前', '思明区'],
    ['观音山附近上班方便', '观音山', '思明区'],
    ['软件园二期附近', '软件园', '思明区'],
    ['杏林湾的盘', '杏林湾', '集美区'],
    ['马巷的房子便宜', '马巷', '翔安区'],
    ['鼓浪屿就不考虑了', '鼓浪屿', '思明区'],
  ];

  for (const [text, plate, district] of plates) {
    const loc = extractLocations(text, '厦门');

    checkIncludes(`「${text}」→ 板块`, loc.subDistricts, plate);
    // 关键：只说了板块，系统要能补出行政区（硬筛需要）
    checkIncludes(`  ↳ 自动补全行政区`, loc.districts, district);
  }

  // ========================================================================
  console.log('');
  console.log('【3】客户真实说话方式（完整句子）');
  // ========================================================================

  const sentences: Array<{ text: string; city: string; districts: string[] }> = [
    {
      text: '我在厦门软件园上班，想找思明区或者湖里区的三房，总价500万左右',
      city: '厦门',
      districts: ['思明区', '湖里区'],
    },
    { text: '厦门岛内两房，400万以内，最好近地铁', city: '厦门', districts: ['思明区', '湖里区'] },
    { text: '集美区的房子，总价300万', city: '厦门', districts: ['集美区'] },
    { text: '五缘湾那边有没有四房，预算800万', city: '厦门', districts: ['湖里区'] },
    { text: '海沧这边有什么推荐', city: '厦门', districts: ['海沧区'] },
  ];

  for (const sentence of sentences) {
    const result = parseRequirementByRules(sentence.text);
    const preview = sentence.text.length > 26 ? `${sentence.text.slice(0, 26)}…` : sentence.text;
    console.log(`  「${preview}」`);
    console.log(`      城市=${result.city} 区=${JSON.stringify(result.districts)}`);

    check(`  ↳ 城市`, result.city, sentence.city);
    for (const district of sentence.districts) {
      checkIncludes(`  ↳ 行政区`, result.districts, district);
    }
  }

  // ========================================================================
  console.log('');
  console.log('【4】歧义防护（不能把别的城市误判成厦门）');
  // ========================================================================

  // 金山：上海与厦门都有 → 必须标记为歧义，两边都不猜
  check('「金山」被识别为跨城市歧义（不在映射表里）', CITY_BY_SUB_DISTRICT.has('金山'), false);
  check('「鼓楼区」被识别为跨城市歧义（不在映射表里）', CITY_BY_DISTRICT.has('鼓楼区'), false);

  const noFalsePositive: Array<[string, string | null]> = [
    ['南京鼓楼区的房子', '南京'],
    ['北京朝阳区的房子', '北京'],
    ['上海浦东新区的房子', '上海'],
    ['厦门思明区', '厦门'],
  ];

  for (const [text, expectedCity] of noFalsePositive) {
    const result = extractCityWithSource(text);
    check(`「${text}」→ ${expectedCity ?? '不推断'}`, result.city, expectedCity);
  }

  // ========================================================================
  console.log('');
  console.log('【5】上海原有行为无回归（最重要）');
  // ========================================================================

  const shanghaiRegression: Array<[string, string, string]> = [
    ['浦东三房', '上海', '浦东新区'],
    ['张江的房子', '上海', '浦东新区'],
    ['徐家汇两房', '上海', '徐汇区'],
    ['静安区三房', '上海', '静安区'],
    ['五角场附近', '上海', '杨浦区'],
  ];

  for (const [text, city, district] of shanghaiRegression) {
    const result = parseRequirementByRules(text);
    check(`「${text}」→ 城市=${city}`, result.city, city);
    checkIncludes(`  ↳ 行政区`, result.districts, district);
  }

  // 上海的板块不应因为地址库兜底而重复或错乱
  const shanghaiSub = extractLocations('张江金桥都看看', '上海');
  check('上海板块识别正常', shanghaiSub.subDistricts.sort(), ['张江', '金桥'].sort());

  // ========================================================================
  console.log('');
  console.log('【6】福建其他城市');
  // ========================================================================

  const fujian: Array<[string, string]> = [
    ['福州仓山区的房子', '福州'],
    ['泉州丰泽区', '泉州'],
    ['漳州角美', '漳州'],
    ['厦门湖里区', '厦门'],
  ];

  for (const [text, expectedCity] of fujian) {
    const result = extractCityWithSource(text);
    check(`「${text}」→ ${expectedCity}`, result.city, expectedCity);
  }

  // ========================================================================
  console.log('');
  console.log('【7】区域清洗（跨城市残留条件必须被丢弃）');
  // ========================================================================
  //
  // 实测踩到的真实 bug：客户先聊过厦门、后聊上海，画像里同时存在
  // "浦东新区"和"思明区"。经纪人把城市切到"上海"却不指定具体区时，
  // 厦门的区名仍参与硬筛，把上海房源全部筛掉 → 报"没有可用房源"。

  // 选上海 → 厦门的区必须被丢掉，上海的区保留
  check(
    '选上海：丢弃厦门区名、保留上海区名',
    districtsBelongingToCity(['浦东新区', '思明区', '湖里区'], '上海'),
    ['浦东新区'],
  );

  // 反向：选厦门 → 上海的区被丢掉
  check(
    '选厦门：丢弃上海区名、保留厦门区名',
    districtsBelongingToCity(['浦东新区', '思明区'], '厦门'),
    ['思明区'],
  );

  // 简称也要认（画像里可能存"浦东"而不是"浦东新区"）
  check('简称"浦东"在上海名下保留', districtsBelongingToCity(['浦东'], '上海'), ['浦东']);

  // 板块名也算该城市的合法区域标识
  check(
    '板块"五缘湾"在厦门名下保留',
    districtsBelongingToCity(['五缘湾'], '厦门'),
    ['五缘湾'],
  );

  // 城市未知 → 保守原样保留（贝壳支持但我们没收录的城市）
  check(
    '城市未知时原样保留（不贸然清空）',
    districtsBelongingToCity(['某某区'], '未知城市'),
    ['某某区'],
  );

  // 全部不属于该城市 → 清空（这样后续按"不限区域"处理，而不是筛出 0 条）
  check('全不属于该城市则清空', districtsBelongingToCity(['思明区'], '上海'), []);

  // 空输入
  check('空数组返回空', districtsBelongingToCity([], '上海'), []);

  // ========================================================================
  console.log('');
  console.log('【8】地址筛选数据（供前端下拉使用）');
  // ========================================================================

  const cities = listCitiesWithAreas();
  console.log(`  可选城市: ${cities.map((c) => c.city).join('、')}`);

  check('厦门在可选城市里', cities.some((c) => c.city === '厦门'), true);

  const xiamen = cities.find((c) => c.city === '厦门');
  check('厦门有 6 个行政区', xiamen?.districts.length, 6);
  check('厦门有板块数据', (xiamen?.subDistricts.length ?? 0) > 40, true);
  console.log(`  厦门: ${xiamen?.districts.join('、')}`);
  console.log(`  厦门板块数: ${xiamen?.subDistricts.length}`);

  // ========================================================================
  console.log('');
  console.log('【9】客户原话优先于历史画像（这个 bug 犯过两次，必须锁住）');
  console.log('='.repeat(70));
  //
  // 真实事故：客户画像记着"上海"，客户这次说"厦门岛外的房子"，
  // 系统却推荐了 5 套浦东新区的房源。
  //
  // 根因是**两层**"画像城市覆盖客户原话"的兜底：
  //   1. 编排器把画像城市当 cityHint 传进去（已修）
  //   2. 抽取器内部又用 existingProfile.city 兜底（已修）
  // 堵了一层漏了另一层 —— 所以这里对**抽取器**做端到端断言。

  const config = {
    env: 'development',
    isDevelopment: true,
    log: { level: 'info' },
    ai: { provider: 'mock', apiKey: null },
  };
  const extractor = new RequirementExtractorService(new AiService(config as never));

  const shanghaiProfile = {
    city: '上海',
    districts: ['浦东新区'],
    subDistricts: ['张江'],
  };

  const precedence: Array<{ text: string; expectCity: string; expectDistrict?: string }> = [
    { text: '厦门岛外的房子', expectCity: '厦门', expectDistrict: '集美区' },
    { text: '厦门岛内两房', expectCity: '厦门', expectDistrict: '思明区' },
    { text: '五缘湾的房子', expectCity: '厦门', expectDistrict: '湖里区' },
    { text: '上海浦东的房子', expectCity: '上海', expectDistrict: '浦东新区' },
  ];

  for (const item of precedence) {
    const result = await extractor.extract(item.text, {
      customerName: '测试客户',
      existingProfile: shanghaiProfile,
      cityHint: null,
    });

    const city = result.extraction.city;
    check(`画像=上海，消息「${item.text}」→ 城市应为${item.expectCity}`, city, item.expectCity);

    if (item.expectDistrict) {
      checkIncludes(
        `  ↳ 行政区`,
        result.extraction.districts,
        item.expectDistrict,
      );
    }
  }

  // 反向保护：消息里没提城市时，不能凭空造一个城市出来
  const noCity = await extractor.extract('三房五百万', {
    customerName: '测试客户',
    existingProfile: shanghaiProfile,
    cityHint: null,
  });
  check(
    '消息无城市且不传 hint → 城市应为 null（由调用方决定兜底）',
    noCity.extraction.city,
    null,
  );

  // 显式 hint 仍然生效（编排器用它做兜底）
  const withHint = await extractor.extract('三房五百万', {
    customerName: '测试客户',
    existingProfile: null,
    cityHint: '厦门',
  });
  check('显式传 hint=厦门 → 城市为厦门', withHint.extraction.city, '厦门');

  // ========================================================================
  console.log('');
  console.log('【10】跨城市区域污染必须在合并层被清理');
  console.log('='.repeat(70));
  //
  // 真实事故：客户先聊上海（画像记住 浦东新区/张江），后改口厦门。
  // `districts` 是追加语义，于是画像里同时存在两地的区域。
  //
  // 后果（实测）：
  //   · 生成的检索式变成「厦门 张江 2或3房」—— 厦门没有张江，App 里搜不到
  //   · 硬筛用厦门城市 + 上海区域，必然 0 条
  //   · 脏数据永久留在画像里，持续污染后续所有检索

  const merger = new RequirementMergeService();

  /**
   * 用**真实解析器**构造抽取结果，只覆盖本用例关心的字段。
   *
   * 为什么不用手写 fixture：`RequirementExtraction` 有几十个字段，
   * 手写既脆弱（类型一变就挂）又容易漏（第一次就漏了
   * `otherRequirements` / `budget` / `buildingAge`）。
   * 用真实解析器产出完整对象，再覆盖测试关注的字段 ——
   * 这样测试永远跟得上类型变化。
   */
  const makeExtraction = (city: string, districts: string[], subDistricts: string[]): never => {
    const base = parseRequirementByRules('三房500万', { city: null });
    return { ...base, city, citySource: 'explicit', districts, subDistricts } as never;
  };

  /** 画像：用官方空画像构造，只覆盖本用例关心的字段 */
  const makeProfile = (city: string, districts: string[], subDistricts: string[]): never =>
    ({
      ...createEmptyProfile(),
      city,
      districts,
      subDistricts,
      sourceMessageCount: 1,
      updatedAt: new Date(),
    }) as never;

  // 上海画像 + 改口厦门 → 上海的区域必须被清掉
  const switched = merger.merge(
    makeProfile('上海', ['浦东新区'], ['张江']),
    makeExtraction('厦门', ['集美区'], []),
  );

  check('改口厦门后，城市变为厦门', switched.merged.city, '厦门');
  check('上海的行政区被清理（浦东新区）', switched.merged.districts.includes('浦东新区'), false);
  check('上海的板块被清理（张江）', switched.merged.subDistricts.includes('张江'), false);
  checkIncludes('厦门的新区域被保留', switched.merged.districts, '集美区');

  // 同城市内追加区域必须仍然生效（不能把正常累积也清掉）
  const sameCity = merger.merge(
    makeProfile('厦门', ['思明区'], []),
    makeExtraction('厦门', ['湖里区'], []),
  );
  checkIncludes('同城市内追加区域仍生效（思明区）', sameCity.merged.districts, '思明区');
  checkIncludes('同城市内追加区域仍生效（湖里区）', sameCity.merged.districts, '湖里区');

  // 城市未知时不应误删（保守原则）
  const unknownCity = merger.merge(
    makeProfile('某未知城市', ['某某区'], []),
    makeExtraction('某未知城市', [], []),
  );
  checkIncludes('城市未知时保守保留区域', unknownCity.merged.districts, '某某区');

  // ========================================================================
  console.log('');
  console.log('─'.repeat(70));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error('验证异常：', error);
  process.exit(1);
});
