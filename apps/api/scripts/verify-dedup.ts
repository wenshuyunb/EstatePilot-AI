/**
 * 去重引擎验证。
 *
 * 核心用例直接取自需求文档 §8：
 *   贝壳：  XX花园  105㎡  568万
 *   安居客：XX花园  105㎡  565万
 *   → 必须判定为同一套，不能产生两条推荐。
 *
 * 同时验证**反向能力**：看起来相似但不是同一套的房源，必须**不**被误合并。
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/verify-dedup.ts
 */

import {
  ListingStatus,
  PropertyProviderKind,
  PropertyType,
  type NormalizedProperty,
} from '@estatepilot/types';
import { CommunityNormalizerService } from '../dist/modules/property/dedup/community-normalizer.service.js';
import {
  PropertyDeduplicationService,
  DeduplicationVerdict,
} from '../dist/modules/property/dedup/property-deduplication.service.js';

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

/** 构造测试房源（只填必要字段，其余用合理默认值） */
function makeProperty(overrides: Partial<NormalizedProperty> & {
  externalProvider: PropertyProviderKind;
  externalId: string;
  community: string;
  area: number;
  totalPrice: number;
}): NormalizedProperty {
  return {
    city: '上海',
    district: '浦东新区',
    subDistrict: '张江',
    title: `${overrides.community} ${overrides.area}㎡`,
    address: null,
    longitude: null,
    latitude: null,
    unitPrice: Math.round(overrides.totalPrice / overrides.area),
    bedrooms: 3,
    livingRooms: 2,
    bathrooms: 1,
    floor: 5,
    totalFloors: 6,
    orientation: null,
    buildYear: 2010,
    propertyType: PropertyType.APARTMENT,
    ownershipType: null,
    decoration: null,
    elevator: true,
    subwayDistance: null,
    subway: null,
    schoolInfo: null,
    tags: [],
    images: [],
    floorPlan: [],
    description: null,
    listingStatus: ListingStatus.ACTIVE,
    listingDate: null,
    lastPriceChange: null,
    rawData: null,
    ...overrides,
  } as NormalizedProperty;
}

const normalizer = new CommunityNormalizerService();
const dedup = new PropertyDeduplicationService(normalizer);

console.log('去重引擎验证\n');

// ============================================================================
// 1. 小区名归一化（跨源匹配的基础）
// ============================================================================
console.log('【1】小区名归一化');

const normalizeCases: Array<{ a: string; b: string; same: boolean; why: string }> = [
  { a: '玉兰香苑(四期)', b: '玉兰香苑', same: true, why: '括号内是分期信息' },
  { a: '玉兰香苑（四期）', b: '玉兰香苑(四期)', same: true, why: '全角/半角括号' },
  { a: '浦东XX花园', b: 'XX花园', same: true, why: '需求 §8 的例子：行政区前缀' },
  { a: 'XX花园', b: 'XX花园 ', same: true, why: '尾部空格' },
  // 同一小区的不同写法（平台间常见）—— 应当判为同一小区
  { a: '汤臣一品', b: '汤臣一品花园', same: true, why: '同小区不同写法（差 2 字）' },
  // 以下才是真正的"不能误合并"边界
  { a: '浦东花园', b: '浦西花园', same: false, why: '不同小区，不能因为都叫"花园"就合并' },
  { a: '阳光花园', b: '月光花园', same: false, why: '仅一字之差但是不同小区' },
  { a: '花园', b: '汤臣一品花园', same: false, why: '过短的名字不应被当作子串匹配（防误合并）' },
];

for (const testCase of normalizeCases) {
  const result = normalizer.isSameCommunity(
    { community: testCase.a, district: '浦东新区' },
    { community: testCase.b, district: '浦东新区' },
  );
  check(
    `"${testCase.a}" vs "${testCase.b}" → ${testCase.same ? '同一小区' : '不同小区'}（${testCase.why}）`,
    result === testCase.same,
    `实际判定为 ${result ? '同一小区' : '不同小区'}`,
  );
}

// ============================================================================
// 2. 需求 §8 的核心用例
// ============================================================================
console.log('\n【2】需求 §8 核心用例：跨平台同一套房');

const beikeHouse = makeProperty({
  externalProvider: PropertyProviderKind.BEIKE,
  externalId: '123456',
  community: 'XX花园',
  area: 105,
  totalPrice: 5_680_000,
});

const anjukeHouse = makeProperty({
  externalProvider: PropertyProviderKind.ANJUKE,
  externalId: '998877',
  community: '浦东XX花园',
  area: 105,
  totalPrice: 5_650_000,
});

const decision = dedup.compare(beikeHouse, anjukeHouse);
check(
  `贝壳 105㎡ 568万 vs 安居客 105㎡ 565万 → 判定为同一套`,
  decision.verdict === DeduplicationVerdict.SAME,
  `实际：${decision.verdict}（${decision.reason}）`,
);
check(`判定依据可解释`, decision.reason.length > 0, decision.reason);

// ============================================================================
// 3. 反向能力：不能误合并
// ============================================================================
console.log('\n【3】反向能力：相似但不同的房源不能被误合并');

const reverseCases: Array<{
  name: string;
  a: Partial<NormalizedProperty> & { externalProvider: PropertyProviderKind; externalId: string; community: string; area: number; totalPrice: number };
  b: Partial<NormalizedProperty> & { externalProvider: PropertyProviderKind; externalId: string; community: string; area: number; totalPrice: number };
  expectNotSame: boolean;
}> = [
  {
    name: '不同小区',
    a: { externalProvider: PropertyProviderKind.BEIKE, externalId: '1', community: '阳光花园', area: 105, totalPrice: 5_680_000 },
    b: { externalProvider: PropertyProviderKind.ANJUKE, externalId: '2', community: '月光花园', area: 105, totalPrice: 5_680_000 },
    expectNotSame: true,
  },
  {
    name: '面积差异过大（105㎡ vs 135㎡）',
    a: { externalProvider: PropertyProviderKind.BEIKE, externalId: '3', community: 'XX花园', area: 105, totalPrice: 5_680_000 },
    b: { externalProvider: PropertyProviderKind.ANJUKE, externalId: '4', community: 'XX花园', area: 135, totalPrice: 5_680_000 },
    expectNotSame: true,
  },
  {
    name: '同小区但面积不同（105 vs 120）',
    a: { externalProvider: PropertyProviderKind.BEIKE, externalId: '5', community: 'XX花园', area: 105, totalPrice: 5_680_000 },
    b: { externalProvider: PropertyProviderKind.ANJUKE, externalId: '6', community: 'XX花园', area: 120, totalPrice: 5_680_000 },
    expectNotSame: true,
  },
];

for (const testCase of reverseCases) {
  const a = makeProperty(testCase.a as Parameters<typeof makeProperty>[0]);
  const b = makeProperty(testCase.b as Parameters<typeof makeProperty>[0]);
  const result = dedup.compare(a, b);

  check(
    `${testCase.name} → 不自动合并`,
    result.verdict !== DeduplicationVerdict.SAME,
    `实际：${result.verdict} —— ${result.reason}`,
  );
}

// ============================================================================
// 4. 同源不同 ID 必须判为不同房源（关键安全阀）
// ============================================================================
console.log('\n【4】同源不同 ID → 必须是两套（安全阀）');

const sameSource = dedup.compare(
  makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: '111', community: 'XX花园', area: 105, totalPrice: 5_680_000 }),
  makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: '222', community: 'XX花园', area: 105, totalPrice: 5_680_000 }),
);

check(
  '同源（贝壳）不同 externalId → DIFFERENT',
  sameSource.verdict === DeduplicationVerdict.DIFFERENT,
  `实际：${sameSource.verdict}`,
);

const sameExternalId = dedup.compare(
  makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: '333', community: 'XX花园', area: 105, totalPrice: 5_680_000 }),
  makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: '333', community: 'XX花园', area: 105, totalPrice: 5_680_000 }),
);

check(
  '同源同 externalId → SAME（幂等）',
  sameExternalId.verdict === DeduplicationVerdict.SAME,
  `实际：${sameExternalId.verdict}`,
);

// ============================================================================
// 5. 价格差异较大的情况归入"疑似"而非自动合并
// ============================================================================
console.log('\n【5】指纹一致但价格差异大 → 疑似（交人工确认）');

const priceConflict = dedup.compare(
  makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: '444', community: 'XX花园', area: 105, totalPrice: 5_680_000 }),
  makeProperty({ externalProvider: PropertyProviderKind.ANJUKE, externalId: '555', community: 'XX花园', area: 105, totalPrice: 6_500_000 }),
);

check(
  '同小区同户型同面积同楼层，价格差 13% → SUSPECTED（不自动合并）',
  priceConflict.verdict === DeduplicationVerdict.SUSPECTED,
  `实际：${priceConflict.verdict} —— ${priceConflict.reason}`,
);

// ============================================================================
// 6. 批量归并
// ============================================================================
console.log('\n【6】批量归并（多源混合）');

const batch = [
  makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'A1', community: '玉兰香苑(四期)', area: 105, totalPrice: 5_680_000 }),
  makeProperty({ externalProvider: PropertyProviderKind.ANJUKE, externalId: 'B1', community: '玉兰香苑', area: 105, totalPrice: 5_650_000 }),
  makeProperty({ externalProvider: PropertyProviderKind.INTERNAL, externalId: 'C1', community: '玉兰香苑', area: 105, totalPrice: 5_600_000 }),
  makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'A2', community: '玉兰香苑(四期)', area: 130, totalPrice: 7_200_000 }),
];

const merged = dedup.merge(batch);

check(
  `4 条输入（3 条同一套房 + 1 条不同户型）→ 归并为 2 条`,
  merged.merged.length === 2,
  `实际归并为 ${merged.merged.length} 条`,
);

const biggestGroup = merged.merged.reduce(
  (max, group) => (group.duplicates.length > max.duplicates.length ? group : max),
  merged.merged[0]!,
);

check(
  `最大分组含 1 条主记录 + ${biggestGroup.duplicates.length} 条重复`,
  biggestGroup.duplicates.length === 2,
  `实际 ${biggestGroup.duplicates.length} 条`,
);

const providers = new Set([
  biggestGroup.primary.externalProvider,
  ...biggestGroup.duplicates.map((item) => item.externalProvider),
]);
check(
  `该分组覆盖 3 个来源（${[...providers].join(', ')}）`,
  providers.size === 3,
  `实际 ${providers.size} 个来源`,
);

// ============================================================================
// 7. 指纹构成可解释
// ============================================================================
console.log('\n【7】指纹构成');

const fingerprint = dedup.buildFingerprint(beikeHouse);
check('指纹含哈希', fingerprint.hash.length === 32, `长度 ${fingerprint.hash.length}`);
check('面积归到 5㎡ 档', fingerprint.parts.areaBucket === 105, `实际 ${fingerprint.parts.areaBucket}（105 → 105）`);
check('楼层分档为 mid（5/6 层）', fingerprint.parts.floorBucket === 'mid', `实际 ${fingerprint.parts.floorBucket}`);
check('小区名已归一化', fingerprint.parts.communityNormalized === 'xx花园', `实际 ${fingerprint.parts.communityNormalized}`);

// 跨源面积误差必须落进同一档（104.8 与 105.2 是同一套房）
const area104 = dedup.buildFingerprint(makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'x', community: 'X', area: 104.8, totalPrice: 5_000_000 }));
const area105 = dedup.buildFingerprint(makeProperty({ externalProvider: PropertyProviderKind.ANJUKE, externalId: 'y', community: 'X', area: 105.2, totalPrice: 5_000_000 }));
check(
  '104.8㎡ 与 105.2㎡ 得到相同面积档（跨源容错）',
  area104.parts.areaBucket === area105.parts.areaBucket,
  `${area104.parts.areaBucket} vs ${area105.parts.areaBucket}`,
);

// 反向：不同户型不能被归进同档
const area135 = dedup.buildFingerprint(makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'z', community: 'X', area: 135, totalPrice: 7_000_000 }));
check(
  '105㎡ 与 135㎡ 分属不同面积档（不误合并）',
  area105.parts.areaBucket !== area135.parts.areaBucket,
  `${area105.parts.areaBucket} vs ${area135.parts.areaBucket}`,
);

// 低层建筑的楼层分档（踩过的坑：5/6 层曾被判为"高层"）
const lowRise = dedup.buildFingerprint(makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'lr', community: 'X', area: 60, totalPrice: 3_000_000, floor: 5, totalFloors: 6 }));
const highRise = dedup.buildFingerprint(makeProperty({ externalProvider: PropertyProviderKind.BEIKE, externalId: 'hr', community: 'X', area: 60, totalPrice: 3_000_000, floor: 28, totalFloors: 32 }));
check('5/6 层 → mid（低层建筑不设高层档）', lowRise.parts.floorBucket === 'mid', `实际 ${lowRise.parts.floorBucket}`);
check('28/32 层 → high', highRise.parts.floorBucket === 'high', `实际 ${highRise.parts.floorBucket}`);

console.log('\n' + '─'.repeat(70));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

process.exit(failed > 0 ? 1 : 0);
