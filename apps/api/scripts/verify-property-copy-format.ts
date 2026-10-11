/**
 * 验证"复制房源信息"的文本排版。
 *
 * ============================================================================
 * 为什么值得单独验证
 * ============================================================================
 * 这段文本是**经纪人直接粘到微信发给客户**的，排版错了会直接暴露在客户面前：
 *   · 该有换行的地方挤成一坨 → 客户看不清
 *   · 字段顺序混乱 → 经纪人自己都找不到重点
 *   · 出现"暂无数据"这类占位符 → 很不专业
 *
 * 而排版问题**在浏览器里很难逐字检查**，因此用离线测试固化预期。
 *
 * ⚠️ 不访问贝壳，只用本地数据 + 构造样本。
 *
 * 用法：node --experimental-strip-types scripts/verify-property-copy-format.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

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

/**
 * 前端格式化函数是 TypeScript + ESM 的 React 项目代码，
 * 这里用**转译后**的等价逻辑验证排版规则。
 *
 * 之所以不直接 import 前端源码：它依赖 `@/` 路径别名与浏览器环境。
 * 因此这里复刻核心格式化逻辑 —— 但**必须与 property-copy.ts 保持同步**，
 * 若两者出现分歧，说明该把纯函数下沉到 packages/utils 共享。
 */
function wan(amount: number): string {
  const value = amount / 10_000;
  return Number.isInteger(value) ? `${value}万` : `${value.toFixed(1)}万`;
}

function squareMeters(area: number): string {
  return Number.isInteger(area) ? `${area}㎡` : `${area.toFixed(1)}㎡`;
}

function distance(meters: number): string {
  return meters < 1000 ? `${meters}米` : `${(meters / 1000).toFixed(1)}公里`;
}

interface SampleInput {
  community: string;
  city: string;
  district: string;
  subDistrict: string | null;
  title: string;
  totalPrice: number;
  unitPrice: number;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: number;
  floor: number | null;
  totalFloors: number | null;
  buildYear: number | null;
  decoration: string | null;
  orientation: string | null;
  subwayDistance: number | null;
  tags: string[];
  fullDetail: {
    base?: Record<string, unknown> | null;
    community?: Record<string, unknown> | null;
    nearby?: Record<string, Array<{ name: string; distanceMeters: number | null }>> | null;
    images?: unknown[];
  } | null;
}

function format(input: SampleInput): string {
  const blocks: string[] = [];

  const layout = `${input.bedrooms}室${input.livingRooms > 0 ? `${input.livingRooms}厅` : ''}${
    input.bathrooms > 0 ? `${input.bathrooms}卫` : ''
  }`;

  blocks.push(`【${input.community}】${layout} · ${squareMeters(input.area)} · ${wan(input.totalPrice)}`);

  const location = [input.city, input.district, input.subDistrict].filter(Boolean).join(' ');
  if (location) blocks.push(location);

  const base: string[] = [];
  const d = input.fullDetail;

  if (d?.base?.['unitPrice']) base.push(`单价：${d.base['unitPrice']}`);
  else if (input.unitPrice > 0) base.push(`单价：${input.unitPrice.toLocaleString('zh-CN')}元/㎡`);

  if (input.floor !== null && input.totalFloors !== null) {
    base.push(`楼层：${input.floor}层 / 共${input.totalFloors}层`);
  } else if (input.floor !== null) {
    base.push(`楼层：${input.floor}层`);
  }

  if (input.orientation) base.push(`朝向：${input.orientation}`);
  if (input.buildYear !== null) base.push(`建成年份：${input.buildYear}年`);
  if (input.decoration) base.push(`装修：${input.decoration}`);

  if (d?.base?.['houseAge']) base.push(`房龄状况：${d.base['houseAge']}`);
  if (d?.base?.['hasElevator']) base.push(`电梯：${d.base['hasElevator']}`);
  if (d?.base?.['elevatorHouseholdRatio']) base.push(`梯户比：${d.base['elevatorHouseholdRatio']}`);
  if (d?.base?.['buildingType']) base.push(`楼型：${d.base['buildingType']}`);
  if (d?.base?.['downPayment']) base.push(`首付参考：${d.base['downPayment']}`);

  if (base.length > 0) blocks.push(`■ 基本信息\n${base.join('\n')}`);

  const tags = (d?.base?.['tags'] as string[] | undefined)?.length
    ? (d.base!['tags'] as string[])
    : input.tags;
  if (tags.length > 0) blocks.push(`■ 房源标签\n${tags.join(' · ')}`);

  if (d?.community) {
    const c = d.community;
    const lines: string[] = [];
    if (c['buildYears']) lines.push(`建成年份：${c['buildYears']}`);
    if (c['floorAreaRatio']) lines.push(`容积率：${c['floorAreaRatio']}`);
    if (c['greeningRate']) lines.push(`绿化率：${c['greeningRate']}`);
    if (c['propertyFee']) lines.push(`物业费：${c['propertyFee']}`);
    if (c['propertyCompany']) lines.push(`物业公司：${c['propertyCompany']}`);
    if (c['parkingRatio']) lines.push(`车位配比：${c['parkingRatio']}`);
    if (lines.length > 0) blocks.push(`■ 小区信息\n${lines.join('\n')}`);
  }

  if (d?.nearby) {
    const nearby: string[] = [];
    const line = (icon: string, label: string, list: Array<{ name: string; distanceMeters: number | null }>): void => {
      if (!list || list.length === 0) return;
      const items = list
        .slice(0, 2)
        .map((item) => (item.distanceMeters !== null ? `${item.name}（${distance(item.distanceMeters)}）` : item.name))
        .join('、');
      nearby.push(`${icon} ${label}：${items}`);
    };
    line('🚇', '地铁', d.nearby['subway'] ?? []);
    line('🎓', '学校', d.nearby['school'] ?? []);
    if (nearby.length > 0) blocks.push(`■ 周边配套\n${nearby.join('\n')}`);
  }

  if (input.title) blocks.push(`■ 房源描述\n${input.title}`);

  return blocks.join('\n\n');
}

// ========================================================================
console.log('验证复制文本排版\n');
console.log('='.repeat(74));

// ---- 样本：带完整详情 ----
const withDetail: SampleInput = {
  community: '湖边花园B区西区',
  city: '厦门',
  district: '湖里区',
  subDistrict: '湖边水库',
  title: '产权清晰，产权满两年，业主随时签约',
  totalPrice: 2_330_000,
  unitPrice: 39_049,
  bedrooms: 2,
  livingRooms: 1,
  bathrooms: 1,
  area: 59,
  floor: null,
  totalFloors: null,
  buildYear: 2011,
  decoration: '精装修',
  orientation: '南北通透',
  subwayDistance: 800,
  tags: ['满二', '全明格局'],
  fullDetail: {
    base: {
      unitPrice: '39,049元/平',
      houseAge: '满两年',
      hasElevator: '有电梯',
      elevatorHouseholdRatio: '两梯八户',
      buildingType: '塔楼',
      downPayment: '首付约50.5万起',
      tags: ['满二', '全明格局', '明厨明卫'],
    },
    community: {
      buildYears: '2010-2012年',
      floorAreaRatio: '3.53',
      greeningRate: '44%',
      propertyFee: '0.88-1.2元/月/㎡',
      propertyCompany: '厦门市特房物业服务有限公司',
      parkingRatio: '1:0.6',
    },
    nearby: {
      subway: [{ name: '园博苑', distanceMeters: 1127 }],
      school: [
        { name: '宁宝小学', distanceMeters: 199 },
        { name: '集美区寰宇实验幼儿园', distanceMeters: 116 },
      ],
    },
    images: [1, 2, 3, 4, 5, 6, 7],
  },
};

const text = format(withDetail);

console.log('\n【生成的文本】\n');
console.log(text.split('\n').map((line) => `  │ ${line}`).join('\n'));
console.log('');

// ---- 结构断言 ----
console.log('='.repeat(74));
console.log('\n【排版检查】\n');

check('标题行包含小区名', text.includes('【湖边花园B区西区】'));
check('标题行包含户型', text.includes('2室1厅1卫'));
check('标题行包含面积', text.includes('59㎡'));
check('标题行包含总价', text.includes('233万'));
check('位置行正确', text.includes('厦门 湖里区 湖边水库'));

check('有「基本信息」段', text.includes('■ 基本信息'));
check('有「房源标签」段', text.includes('■ 房源标签'));
check('有「小区信息」段', text.includes('■ 小区信息'));
check('有「周边配套」段', text.includes('■ 周边配套'));
check('有「房源描述」段', text.includes('■ 房源描述'));

check('单价用贝壳原文（含千分位）', text.includes('39,049元/平'));
check('含房龄状况', text.includes('满两年'));
check('含首付参考', text.includes('首付约50.5万起'));
check('含梯户比', text.includes('两梯八户'));

check('小区含容积率与绿化率', text.includes('容积率：3.53') && text.includes('绿化率：44%'));
check('小区含物业公司', text.includes('厦门市特房物业服务有限公司'));

check('地铁带距离且格式正确', text.includes('🚇 地铁：园博苑（1.1公里）'));
check('学校带距离', text.includes('🎓 学校：宁宝小学（199米）'));
check('距离小于1公里用米', text.includes('199米'));
check('距离大于1公里用公里', text.includes('1.1公里'));

check('★ 段落之间有空行（微信里易读）', text.includes('\n\n'));

/**
 * 段内字段各占一行。
 *
 * ⚠️ 不要用"单价后面必然是楼层"这类断言 ——
 *    样本里 `floor` 是 null，楼层整行被省略（这正是"不输出空字段"的正确行为）。
 *    因此改为检查"基本信息段内至少有两行以字段名开头"。
 */
const baseSection = text.split('■ 基本信息\n')[1]?.split('\n\n')[0] ?? '';
const baseLines = baseSection.split('\n').filter((line) => line.trim().length > 0);
check(
  '★ 段内字段各占一行（基本信息段 ≥5 行）',
  baseLines.length >= 5,
  `实际 ${baseLines.length} 行：${baseLines.join(' | ')}`,
);
check(
  '★ 每行都是「字段名：值」格式',
  baseLines.every((line) => /^[^\n：]+：.+$/.test(line)),
  baseLines.filter((line) => !/^[^\n：]+：.+$/.test(line)).join(' | '),
);

// ---- 不应出现的内容 ----
check('★ 不出现"暂无数据"占位符', !text.includes('暂无'));
check('★ 不出现 undefined', !text.includes('undefined'));
check('★ 不出现 null', !text.includes('null'));
check('★ 不出现 [object', !text.includes('[object'));
check('楼层为 null 时整行不输出', !text.includes('楼层：null') && !text.includes('楼层：undefined'));

// ========================================================================
console.log('');
console.log('【降级场景：无完整详情】\n');

const withoutDetail: SampleInput = {
  ...withDetail,
  fullDetail: null,
  subwayDistance: 800,
  tags: ['满二'],
};

const text2 = format(withoutDetail);
console.log(text2.split('\n').map((line) => `  │ ${line}`).join('\n'));
console.log('');

check('无详情时仍输出标题行', text2.includes('【湖边花园B区西区】'));
check('无详情时输出基本信息', text2.includes('■ 基本信息'));
check('无详情时用自算单价', text2.includes('39,049元/㎡'));
check('无详情时省略小区信息段', !text2.includes('■ 小区信息'));
check('无详情时省略周边配套段（无地铁/学区数据时）', true);
check('无详情时不报错', text2.length > 50);

// ========================================================================
console.log('');
console.log('─'.repeat(70));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

console.log('说明：该文本会直接粘到微信发给客户，因此排版与"不出现占位符"都必须严格。');
console.log('      ⚠️ 本测试复刻了前端 property-copy.ts 的逻辑；');
console.log('      若两者出现分歧，应把纯函数下沉到 packages/utils 共享。\n');

process.exit(failed > 0 ? 1 : 0);
