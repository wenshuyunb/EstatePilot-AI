/**
 * Mock 房源数据 Provider。
 *
 * 定位：在没有官方 API 凭证时提供**真实感足够强**的开发与演示数据。
 *
 * 重要合规约定：
 *   - 这些数据是**生成的模拟数据**，不是从任何真实平台抓取的。
 *   - 界面必须显示 "Demo Data" 标记，不得暗示数据来自贝壳或任何真实平台。
 *   - 小区名称使用上海公开的常见居住区名称，但价格、面积、楼层等属性均为程序生成，
 *     不代表任何真实在售房源。
 *
 * 技术要点：
 *   - 使用可复现的种子随机数（mulberry32），同一 seed 永远生成同一批数据，
 *     让测试可断言、让开发环境重启后数据不跳变。
 *   - 记录每个 externalId 的当前状态，用于模拟「价格变化 / 下架 / 重新挂牌」，
 *     这样 property-sync 任务与降价机会引擎可以真实跑通。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Decoration,
  DeviceType as _unusedDeviceType,
  ListingStatus,
  Orientation,
  OwnershipType,
  PropertyProviderKind,
  PropertyType,
  type NormalizedProperty,
  type PropertyFetchResult,
  type PropertyImage,
  type PropertyProvider,
  type PropertyQuery,
  type PropertyStatusChange,
  type SubwayInfo,
  type SchoolInfo,
} from '@estatepilot/types';
import { createSeededRandom, pickOne, randomFloat, randomInt } from '@estatepilot/utils';

/** 小区的静态属性 */
interface CommunitySeed {
  name: string;
  district: string;
  subDistrict: string;
  /** 单价区间（元/㎡） */
  unitPriceMin: number;
  unitPriceMax: number;
  /** 建成年份区间 */
  yearMin: number;
  yearMax: number;
  /** 到最近地铁站的步行距离区间（米） */
  subwayMin: number;
  subwayMax: number;
  /** 是否为重点学区 */
  keySchool: boolean;
  /** 物业费（元/㎡/月） */
  propertyFee: number;
  /** 常见户型分布（卧室数: 权重） */
  layoutWeights: Array<{ bedrooms: number; weight: number; areaMin: number; areaMax: number }>;
  /** 经度纬度基准（用于生成合理坐标） */
  lng: number;
  lat: number;
}

/**
 * 上海 5 区的小区种子数据。
 * 名称取自公开的居住区名称，价格与属性区间参考 2026 年市场量级，但均为程序生成值。
 */
const COMMUNITY_SEEDS: CommunitySeed[] = [
  // ---- 浦东新区 ----
  {
    name: '张江汤臣豪园',
    district: '浦东新区',
    subDistrict: '张江',
    unitPriceMin: 62000,
    unitPriceMax: 85000,
    yearMin: 2005,
    yearMax: 2012,
    subwayMin: 300,
    subwayMax: 900,
    keySchool: true,
    propertyFee: 2.8,
    layoutWeights: [
      { bedrooms: 2, weight: 3, areaMin: 78, areaMax: 95 },
      { bedrooms: 3, weight: 5, areaMin: 100, areaMax: 130 },
      { bedrooms: 4, weight: 2, areaMin: 135, areaMax: 175 },
    ],
    lng: 121.599,
    lat: 31.205,
  },
  {
    name: '碧云国际社区',
    district: '浦东新区',
    subDistrict: '金桥',
    unitPriceMin: 78000,
    unitPriceMax: 110000,
    yearMin: 2008,
    yearMax: 2018,
    subwayMin: 400,
    subwayMax: 1200,
    keySchool: true,
    propertyFee: 4.5,
    layoutWeights: [
      { bedrooms: 3, weight: 4, areaMin: 110, areaMax: 145 },
      { bedrooms: 4, weight: 3, areaMin: 150, areaMax: 210 },
    ],
    lng: 121.578,
    lat: 31.238,
  },
  {
    name: '金桥瑞仕花园',
    district: '浦东新区',
    subDistrict: '金桥',
    unitPriceMin: 55000,
    unitPriceMax: 72000,
    yearMin: 2003,
    yearMax: 2010,
    subwayMin: 500,
    subwayMax: 1400,
    keySchool: false,
    propertyFee: 2.2,
    layoutWeights: [
      { bedrooms: 2, weight: 5, areaMin: 72, areaMax: 92 },
      { bedrooms: 3, weight: 4, areaMin: 95, areaMax: 125 },
    ],
    lng: 121.562,
    lat: 31.251,
  },
  {
    name: '唐镇阳光城',
    district: '浦东新区',
    subDistrict: '唐镇',
    unitPriceMin: 45000,
    unitPriceMax: 62000,
    yearMin: 2013,
    yearMax: 2020,
    subwayMin: 600,
    subwayMax: 1800,
    keySchool: false,
    propertyFee: 2.6,
    layoutWeights: [
      { bedrooms: 2, weight: 4, areaMin: 76, areaMax: 92 },
      { bedrooms: 3, weight: 6, areaMin: 95, areaMax: 128 },
    ],
    lng: 121.655,
    lat: 31.212,
  },
  {
    name: '陆家嘴中央公寓',
    district: '浦东新区',
    subDistrict: '陆家嘴',
    unitPriceMin: 105000,
    unitPriceMax: 165000,
    yearMin: 2006,
    yearMax: 2016,
    subwayMin: 200,
    subwayMax: 700,
    keySchool: true,
    propertyFee: 8.5,
    layoutWeights: [
      { bedrooms: 2, weight: 4, areaMin: 95, areaMax: 120 },
      { bedrooms: 3, weight: 4, areaMin: 130, areaMax: 180 },
    ],
    lng: 121.507,
    lat: 31.239,
  },
  {
    name: '花木星辰苑',
    district: '浦东新区',
    subDistrict: '花木',
    unitPriceMin: 68000,
    unitPriceMax: 92000,
    yearMin: 2000,
    yearMax: 2008,
    subwayMin: 300,
    subwayMax: 1000,
    keySchool: true,
    propertyFee: 2.4,
    layoutWeights: [
      { bedrooms: 2, weight: 4, areaMin: 70, areaMax: 90 },
      { bedrooms: 3, weight: 5, areaMin: 92, areaMax: 125 },
    ],
    lng: 121.545,
    lat: 31.205,
  },
  {
    name: '北蔡紫叶花园',
    district: '浦东新区',
    subDistrict: '北蔡',
    unitPriceMin: 48000,
    unitPriceMax: 65000,
    yearMin: 2001,
    yearMax: 2009,
    subwayMin: 700,
    subwayMax: 2000,
    keySchool: false,
    propertyFee: 1.8,
    layoutWeights: [
      { bedrooms: 2, weight: 6, areaMin: 68, areaMax: 88 },
      { bedrooms: 3, weight: 3, areaMin: 90, areaMax: 118 },
    ],
    lng: 121.554,
    lat: 31.181,
  },
  // ---- 徐汇区 ----
  {
    name: '徐家汇花园',
    district: '徐汇区',
    subDistrict: '徐家汇',
    unitPriceMin: 95000,
    unitPriceMax: 140000,
    yearMin: 2002,
    yearMax: 2010,
    subwayMin: 200,
    subwayMax: 800,
    keySchool: true,
    propertyFee: 3.5,
    layoutWeights: [
      { bedrooms: 2, weight: 4, areaMin: 82, areaMax: 100 },
      { bedrooms: 3, weight: 4, areaMin: 105, areaMax: 140 },
    ],
    lng: 121.437,
    lat: 31.195,
  },
  {
    name: '田林新村',
    district: '徐汇区',
    subDistrict: '田林',
    unitPriceMin: 68000,
    unitPriceMax: 88000,
    yearMin: 1985,
    yearMax: 1998,
    subwayMin: 400,
    subwayMax: 1300,
    keySchool: false,
    propertyFee: 1.2,
    layoutWeights: [
      { bedrooms: 1, weight: 3, areaMin: 40, areaMax: 55 },
      { bedrooms: 2, weight: 6, areaMin: 58, areaMax: 78 },
      { bedrooms: 3, weight: 2, areaMin: 80, areaMax: 100 },
    ],
    lng: 121.425,
    lat: 31.18,
  },
  {
    name: '滨江凯旋门',
    district: '徐汇区',
    subDistrict: '龙华',
    unitPriceMin: 130000,
    unitPriceMax: 190000,
    yearMin: 2012,
    yearMax: 2021,
    subwayMin: 300,
    subwayMax: 900,
    keySchool: true,
    propertyFee: 9.8,
    layoutWeights: [
      { bedrooms: 3, weight: 4, areaMin: 140, areaMax: 185 },
      { bedrooms: 4, weight: 3, areaMin: 190, areaMax: 260 },
    ],
    lng: 121.459,
    lat: 31.176,
  },
  // ---- 闵行区 ----
  {
    name: '万科城市花园',
    district: '闵行区',
    subDistrict: '莘庄',
    unitPriceMin: 58000,
    unitPriceMax: 78000,
    yearMin: 2004,
    yearMax: 2013,
    subwayMin: 400,
    subwayMax: 1400,
    keySchool: false,
    propertyFee: 2.5,
    layoutWeights: [
      { bedrooms: 2, weight: 5, areaMin: 75, areaMax: 95 },
      { bedrooms: 3, weight: 5, areaMin: 98, areaMax: 132 },
    ],
    lng: 121.386,
    lat: 31.112,
  },
  {
    name: '春申景城',
    district: '闵行区',
    subDistrict: '春申',
    unitPriceMin: 46000,
    unitPriceMax: 62000,
    yearMin: 2006,
    yearMax: 2015,
    subwayMin: 600,
    subwayMax: 1800,
    keySchool: true,
    propertyFee: 2.1,
    layoutWeights: [
      { bedrooms: 2, weight: 5, areaMin: 78, areaMax: 96 },
      { bedrooms: 3, weight: 5, areaMin: 100, areaMax: 135 },
    ],
    lng: 121.373,
    lat: 31.089,
  },
  {
    name: '浦江华侨城',
    district: '闵行区',
    subDistrict: '浦江',
    unitPriceMin: 52000,
    unitPriceMax: 72000,
    yearMin: 2010,
    yearMax: 2019,
    subwayMin: 800,
    subwayMax: 2200,
    keySchool: false,
    propertyFee: 2.9,
    layoutWeights: [
      { bedrooms: 3, weight: 5, areaMin: 105, areaMax: 140 },
      { bedrooms: 4, weight: 3, areaMin: 145, areaMax: 190 },
    ],
    lng: 121.507,
    lat: 31.052,
  },
  // ---- 静安区 ----
  {
    name: '静安豪庭',
    district: '静安区',
    subDistrict: '曹家渡',
    unitPriceMin: 105000,
    unitPriceMax: 155000,
    yearMin: 2003,
    yearMax: 2012,
    subwayMin: 200,
    subwayMax: 700,
    keySchool: true,
    propertyFee: 5.2,
    layoutWeights: [
      { bedrooms: 2, weight: 4, areaMin: 88, areaMax: 110 },
      { bedrooms: 3, weight: 4, areaMin: 115, areaMax: 155 },
    ],
    lng: 121.437,
    lat: 31.229,
  },
  {
    name: '大宁金茂府',
    district: '静安区',
    subDistrict: '大宁',
    unitPriceMin: 85000,
    unitPriceMax: 120000,
    yearMin: 2014,
    yearMax: 2022,
    subwayMin: 400,
    subwayMax: 1100,
    keySchool: true,
    propertyFee: 6.5,
    layoutWeights: [
      { bedrooms: 3, weight: 5, areaMin: 118, areaMax: 155 },
      { bedrooms: 4, weight: 3, areaMin: 160, areaMax: 210 },
    ],
    lng: 121.459,
    lat: 31.279,
  },
  {
    name: '彭浦新村',
    district: '静安区',
    subDistrict: '彭浦',
    unitPriceMin: 52000,
    unitPriceMax: 68000,
    yearMin: 1982,
    yearMax: 1996,
    subwayMin: 500,
    subwayMax: 1500,
    keySchool: false,
    propertyFee: 1.1,
    layoutWeights: [
      { bedrooms: 1, weight: 3, areaMin: 38, areaMax: 52 },
      { bedrooms: 2, weight: 6, areaMin: 55, areaMax: 75 },
      { bedrooms: 3, weight: 2, areaMin: 78, areaMax: 98 },
    ],
    lng: 121.442,
    lat: 31.303,
  },
  // ---- 杨浦区 ----
  {
    name: '新江湾城尚浦领世',
    district: '杨浦区',
    subDistrict: '新江湾城',
    unitPriceMin: 75000,
    unitPriceMax: 105000,
    yearMin: 2011,
    yearMax: 2020,
    subwayMin: 500,
    subwayMax: 1400,
    keySchool: true,
    propertyFee: 5.8,
    layoutWeights: [
      { bedrooms: 3, weight: 5, areaMin: 110, areaMax: 145 },
      { bedrooms: 4, weight: 3, areaMin: 150, areaMax: 200 },
    ],
    lng: 121.507,
    lat: 31.328,
  },
  {
    name: '五角场创智坊',
    district: '杨浦区',
    subDistrict: '五角场',
    unitPriceMin: 62000,
    unitPriceMax: 85000,
    yearMin: 2007,
    yearMax: 2016,
    subwayMin: 300,
    subwayMax: 1000,
    keySchool: false,
    propertyFee: 3.2,
    layoutWeights: [
      { bedrooms: 2, weight: 5, areaMin: 76, areaMax: 96 },
      { bedrooms: 3, weight: 4, areaMin: 98, areaMax: 130 },
    ],
    lng: 121.518,
    lat: 31.302,
  },
  {
    name: '控江路 1200 弄',
    district: '杨浦区',
    subDistrict: '控江路',
    unitPriceMin: 55000,
    unitPriceMax: 72000,
    yearMin: 1988,
    yearMax: 2000,
    subwayMin: 400,
    subwayMax: 1200,
    keySchool: false,
    propertyFee: 1.3,
    layoutWeights: [
      { bedrooms: 1, weight: 3, areaMin: 42, areaMax: 56 },
      { bedrooms: 2, weight: 6, areaMin: 58, areaMax: 80 },
      { bedrooms: 3, weight: 2, areaMin: 82, areaMax: 105 },
    ],
    lng: 121.532,
    lat: 31.283,
  },
];

/** 地铁线路与站名（用于生成通勤信息） */
const SUBWAY_LINES: Array<{ line: string; stations: string[] }> = [
  { line: '2 号线', stations: ['张江高科', '金科路', '广兰路', '唐镇', '世纪大道', '陆家嘴'] },
  { line: '9 号线', stations: ['松江新城', '七宝', '徐家汇', '打浦桥', '小南门', '杨高中路'] },
  { line: '1 号线', stations: ['莘庄', '莲花路', '上海南站', '徐家汇', '人民广场', '彭浦新村'] },
  { line: '4 号线', stations: ['宜山路', '上海体育场', '东安路', '浦电路', '蓝村路'] },
  { line: '10 号线', stations: ['新江湾城', '五角场', '同济大学', '四川北路', '新天地'] },
  { line: '12 号线', stations: ['七莘路', '虹梅路', '龙华', '大木桥路', '汉中路'] },
  { line: '13 号线', stations: ['金运路', '大渡河路', '江宁路', '自然博物馆', '张江路'] },
  { line: '16 号线', stations: ['龙阳路', '华夏中路', '周浦东', '鹤沙航城', '惠南'] },
];

/** 小学 / 初中名称（用于生成学区信息） */
const PRIMARY_SCHOOLS = [
  '明珠小学',
  '福山外国语小学',
  '建平实验小学',
  '上海实验学校（小学部）',
  '汇师小学',
  '高安路第一小学',
  '静安区第一中心小学',
  '打虎山路第一小学',
  '闵行区实验小学',
  '七宝外国语小学',
];

const MIDDLE_SCHOOLS = [
  '张江集团学校',
  '建平中学西校',
  '进才中学北校',
  '徐汇中学',
  '位育初级中学',
  '市西初级中学',
  '复旦二附中',
  '文来中学',
  '上宝中学',
];

/** 物业公司 */
const PROPERTY_COMPANIES = [
  '万科物业',
  '绿城物业',
  '保利物业',
  '中海物业',
  '碧桂园服务',
  '金地物业',
  '龙湖智创生活',
  '上海东湖物业',
];

/** 图片类别与数量 */
const IMAGE_PLAN: Array<{ category: PropertyImage['category']; count: number }> = [
  { category: 'EXTERIOR', count: 2 },
  { category: 'INTERIOR', count: 8 },
  { category: 'FLOOR_PLAN', count: 2 },
  { category: 'COMMUNITY', count: 3 },
];

/** 标签池 */
const TAG_POOL = [
  '满五唯一',
  '满二',
  '南北通透',
  '精装修',
  '拎包入住',
  '地铁房',
  '学区房',
  '近地铁',
  '带电梯',
  '高楼层',
  '采光好',
  '户型方正',
  '业主诚售',
  '可谈价',
  '首次挂牌',
  '看房方便',
  '有钥匙',
  '随时可看',
];

export interface MockProviderOptions {
  /** 随机种子，相同种子生成相同数据 */
  seed?: number;
  /** 每个小区生成的房源数量 */
  perCommunity?: number;
}

@Injectable()
export class MockPropertyProvider implements PropertyProvider {
  readonly kind = PropertyProviderKind.MOCK;

  private readonly logger = new Logger(MockPropertyProvider.name);
  private readonly seed: number;
  private readonly perCommunity: number;
  private readonly random: () => number;

  /** 已生成的数据集，保证多次调用返回一致结果 */
  private dataset: Map<string, NormalizedProperty> | null = null;

  /** 记录被模拟变更过的房源，供状态变化查询使用 */
  private statusChanges: PropertyStatusChange[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.seed = options.seed ?? 20_261_008;
    this.perCommunity = options.perCommunity ?? 55;
    // 每次都从同一个种子重建 RNG，保证可复现
    this.random = createSeededRandom(this.seed);
  }

  /** Mock Provider 永远可用 —— 它不需要任何凭证 */
  isConfigured(): boolean {
    return true;
  }

  /**
   * 拉取房源列表。
   * 首次调用时生成全量数据集并缓存，之后按 query 过滤分页。
   */
  async fetchProperties(query: PropertyQuery): Promise<PropertyFetchResult> {
    const dataset = this.ensureDataset();
    let items = [...dataset.values()];

    // 按城市过滤
    if (query.city) {
      items = items.filter((item) => item.city === query.city);
    }
    // 按区域过滤
    if (query.district) {
      items = items.filter((item) => item.district === query.district);
    }
    // 增量同步：按 lastPriceChange 过滤
    if (query.updatedSince) {
      const since = query.updatedSince.getTime();
      items = items.filter((item) => {
        const changed = item.lastPriceChange ? new Date(item.lastPriceChange).getTime() : 0;
        return changed >= since;
      });
    }

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.max(1, Math.min(200, query.pageSize ?? 50));
    const total = items.length;
    const start = (page - 1) * pageSize;
    const paged = items.slice(start, start + pageSize);

    return {
      items: paged,
      page,
      pageSize,
      total,
      hasMore: start + pageSize < total,
    };
  }

  /** 按外部 ID 取详情 */
  async fetchPropertyDetail(externalId: string): Promise<NormalizedProperty | null> {
    const dataset = this.ensureDataset();
    return dataset.get(externalId) ?? null;
  }

  /**
   * 返回自指定时间以来的状态变化。
   *
   * 为了让「降价 → 机会 → 通知」这条链路可被真实演示与测试，
   * Mock Provider 提供 simulatePriceChange / simulateDelist / simulateRelist 方法，
   * 由演示脚本或开发工具调用，产生真实的状态变化事件。
   */
  async fetchStatusChanges(since: Date, city: string): Promise<PropertyStatusChange[]> {
    const sinceTime = since.getTime();
    return this.statusChanges.filter(
      (change) => change.changedAt.getTime() >= sinceTime,
    );
  }

  // -------------------------------------------------------------------------
  // 数据集生成
  // -------------------------------------------------------------------------

  /** 生成（或返回缓存的）全量数据集 */
  private ensureDataset(): Map<string, NormalizedProperty> {
    if (this.dataset) return this.dataset;

    const startedAt = Date.now();
    const dataset = new Map<string, NormalizedProperty>();
    let index = 0;

    for (const community of COMMUNITY_SEEDS) {
      for (let i = 0; i < this.perCommunity; i += 1) {
        const property = this.generateProperty(community, index);
        dataset.set(property.externalId, property);
        index += 1;
      }
    }

    this.dataset = dataset;
    this.logger.log(
      `Mock 数据集已生成：${dataset.size} 套房源，覆盖 ${COMMUNITY_SEEDS.length} 个小区，耗时 ${Date.now() - startedAt}ms`,
    );
    return dataset;
  }

  /** 生成单套房源 */
  private generateProperty(community: CommunitySeed, index: number): NormalizedProperty {
    const externalId = `MOCK-${community.district.slice(0, 2)}-${String(index + 1).padStart(5, '0')}`;

    // 户型与面积
    const layout = this.pickLayout(community);
    const area = randomFloat(layout.areaMin, layout.areaMax, this.random, 1);

    // 单价（在该小区区间内，面积越大单价略低 —— 符合真实市场的大户型折价）
    const areaFactor = 1 - (area - layout.areaMin) / Math.max(1, layout.areaMax - layout.areaMin) * 0.08;
    const unitPrice = Math.round(
      randomFloat(community.unitPriceMin, community.unitPriceMax, this.random, 0) * areaFactor,
    );

    // 总价（元），取整到万
    const totalPrice = Math.round((unitPrice * area) / 10_000) * 10_000;

    // 楼层
    const totalFloors = this.pickTotalFloors(community.yearMin);
    const floor = randomInt(1, totalFloors, this.random);

    // 建成年代
    const buildYear = randomInt(community.yearMin, community.yearMax, this.random);

    // 地铁
    const subwayDistance = randomInt(community.subwayMin, community.subwayMax, this.random);
    const subway = this.buildSubwayInfo(subwayDistance);

    // 学区
    const schoolInfo = this.buildSchoolInfo(community);

    // 装修：老房子简装居多，新房子精装居多
    const decoration = this.pickDecoration(buildYear);

    // 挂牌状态：少数为已下定或下架，制造真实感
    const statusRoll = this.random();
    const listingStatus =
      statusRoll > 0.96
        ? ListingStatus.PENDING
        : statusRoll > 0.93
          ? ListingStatus.DELISTED
          : ListingStatus.ACTIVE;

    // 挂牌日期：最近 180 天内
    const daysAgo = randomInt(1, 180, this.random);
    const listingDate = new Date(Date.now() - daysAgo * 86_400_000);

    // 约 35% 的房源有过一次降价 —— 这是「降价机会」的数据基础
    const hasPriceChange = this.random() < 0.35;
    const priceChangeDaysAgo = hasPriceChange ? randomInt(1, Math.min(60, daysAgo), this.random) : null;
    const lastPriceChange =
      priceChangeDaysAgo !== null
        ? new Date(Date.now() - priceChangeDaysAgo * 86_400_000)
        : null;

    const images = this.buildImages(userIdSafe(externalId), community, layout.bedrooms);

    return {
      externalProvider: PropertyProviderKind.MOCK,
      externalId,
      rawData: {
        generator: 'MockPropertyProvider',
        seed: this.seed,
        generatedAt: new Date().toISOString(),
        notice: '若数据为程序生成的模拟数据，不代表任何真实在售房源',
      },

      city: '上海',
      district: community.district,
      subDistrict: community.subDistrict,
      community: community.name,
      title: `${community.name} ${layout.bedrooms}室${randomInt(1, 2, this.random)}厅 ${this.formatArea(area)}`,
      address: `上海市${community.district}${community.subDistrict}${community.name}`,
      longitude: Number((community.lng + randomFloat(-0.004, 0.004, this.random, 6)).toFixed(6)),
      latitude: Number((community.lat + randomFloat(-0.003, 0.003, this.random, 6)).toFixed(6)),

      totalPrice,
      unitPrice,

      bedrooms: layout.bedrooms,
      livingRooms: layout.bedrooms >= 3 ? 2 : 1,
      bathrooms: layout.bedrooms >= 4 ? 2 : 1,
      area,

      floor,
      totalFloors,

      orientation: this.pickOrientation(),
      buildYear,
      propertyType: PropertyType.APARTMENT,
      ownershipType: this.pickOwnership(buildYear),
      decoration,
      elevator: totalFloors > 6 ? true : this.random() < 0.2,

      subwayDistance,
      subway,
      schoolInfo,

      tags: this.pickTags(community, decoration, subwayDistance, buildYear),
      images,
      floorPlan: images
        .filter((image) => image.category === 'FLOOR_PLAN')
        .map((image) => image.url),
      description: this.buildDescription(community, layout.bedrooms, area, buildYear, decoration, subway, schoolInfo),

      listingStatus,
      listingDate: listingDate.toISOString(),
      lastPriceChange: lastPriceChange ? lastPriceChange.toISOString() : null,
    };
  }

  /** 按权重选择户型 */
  private pickLayout(community: CommunitySeed): { bedrooms: number; areaMin: number; areaMax: number } {
    const totalWeight = community.layoutWeights.reduce((acc, item) => acc + item.weight, 0);
    let threshold = this.random() * totalWeight;
    for (const item of community.layoutWeights) {
      threshold -= item.weight;
      if (threshold <= 0) return item;
    }
    return community.layoutWeights[community.layoutWeights.length - 1] as {
      bedrooms: number;
      areaMin: number;
      areaMax: number;
    };
  }

  /** 总楼层：老小区多层为主，新小区高层为主 */
  private pickTotalFloors(yearMin: number): number {
    if (yearMin < 1995) {
      // 老公房：6～7 层为主
      return this.random() < 0.7 ? 6 : randomInt(7, 18, this.random);
    }
    if (yearMin < 2010) {
      // 2000 年代：小高层为主
      return randomInt(6, 18, this.random);
    }
    // 新小区：高层为主
    return randomInt(11, 34, this.random);
  }

  /** 装修：新房精装概率高，老房简装概率高 */
  private pickDecoration(buildYear: number): Decoration {
    const roll = this.random();
    if (buildYear >= 2015) {
      if (roll < 0.55) return Decoration.FINE;
      if (roll < 0.8) return Decoration.LUXURY;
      if (roll < 0.95) return Decoration.SIMPLE;
      return Decoration.ROUGH;
    }
    if (buildYear >= 2000) {
      if (roll < 0.4) return Decoration.FINE;
      if (roll < 0.8) return Decoration.SIMPLE;
      if (roll < 0.9) return Decoration.LUXURY;
      return Decoration.ROUGH;
    }
    if (roll < 0.65) return Decoration.SIMPLE;
    if (roll < 0.9) return Decoration.FINE;
    return Decoration.ROUGH;
  }

  /** 朝向：南北通透与朝南最受欢迎，权重更高 */
  private pickOrientation(): Orientation {
    const roll = this.random();
    if (roll < 0.3) return Orientation.SOUTH_NORTH;
    if (roll < 0.55) return Orientation.SOUTH;
    if (roll < 0.7) return Orientation.SOUTHEAST;
    if (roll < 0.82) return Orientation.SOUTHWEST;
    if (roll < 0.9) return Orientation.EAST;
    if (roll < 0.96) return Orientation.WEST;
    return Orientation.NORTH;
  }

  /** 产权类型：2000 年后多为商品房，更早可能是房改房或动迁房 */
  private pickOwnership(buildYear: number): OwnershipType {
    const roll = this.random();
    if (buildYear >= 2000) {
      return roll < 0.9 ? OwnershipType.FREEHOLD : OwnershipType.COMMERCIAL;
    }
    if (roll < 0.5) return OwnershipType.HOUSING_REFORM;
    if (roll < 0.75) return OwnershipType.FREEHOLD;
    return OwnershipType.RELOCATION;
  }

  private buildSubwayInfo(distanceMeters: number): SubwayInfo {
    const line = pickOne(SUBWAY_LINES, this.random);
    const station = pickOne(line.stations, this.random);
    return {
      line: line.line,
      station,
      distanceMeters,
      // 步行速度按 80 米/分钟估算
      walkMinutes: Math.max(1, Math.round(distanceMeters / 80)),
    };
  }

  private buildSchoolInfo(community: CommunitySeed): SchoolInfo {
    if (!community.keySchool) {
      const hasSchool = this.random() < 0.5;
      return {
        primarySchool: hasSchool ? pickOne(PRIMARY_SCHOOLS, this.random) : undefined,
        isKeySchool: false,
        seatOccupied: hasSchool ? this.random() < 0.3 : undefined,
        note: hasSchool ? undefined : '周边学校信息以教育局当年公示为准',
      };
    }
    return {
      primarySchool: pickOne(PRIMARY_SCHOOLS, this.random),
      middleSchool: pickOne(MIDDLE_SCHOOLS, this.random),
      isKeySchool: true,
      seatOccupied: this.random() < 0.35,
      note: '学区划分以当年教育部门公示为准，不构成入学承诺',
    };
  }

  private pickTags(
    community: CommunitySeed,
    decoration: Decoration,
    subwayDistance: number,
    buildYear: number,
  ): string[] {
    const candidates: string[] = [];

    if (decoration === Decoration.FINE || decoration === Decoration.LUXURY) candidates.push('精装修');
    if (decoration === Decoration.LUXURY) candidates.push('拎包入住');
    if (subwayDistance <= 800) candidates.push('地铁房');
    else if (subwayDistance <= 1500) candidates.push('近地铁');
    if (community.keySchool) candidates.push('学区房');
    if (buildYear >= 2015) candidates.push('房龄新');
    candidates.push('户型方正', '采光好', '业主诚售');

    const count = randomInt(2, 5, this.random);
    const picked = new Set<string>();
    while (picked.size < Math.min(count, candidates.length)) {
      picked.add(pickOne(candidates, this.random));
    }
    return [...picked];
  }

  private buildImages(
    idPart: string,
    community: CommunitySeed,
    bedrooms: number,
  ): PropertyImage[] {
    const images: PropertyImage[] = [];
    let sortOrder = 0;

    for (const plan of IMAGE_PLAN) {
      for (let i = 0; i < plan.count; i += 1) {
        images.push({
          // 使用 picsum 的稳定占位图服务，同一 seed 返回同一张图，
          // 不依赖任何真实房源图片，符合合规要求
          url: `https://picsum.photos/seed/${idPart}-${plan.category}-${i}/1200/800`,
          category: plan.category,
          sortOrder: sortOrder++,
          caption:
            plan.category === 'FLOOR_PLAN'
              ? `${bedrooms}室户型图 ${i + 1}`
              : plan.category === 'COMMUNITY'
                ? `${community.name} 小区实景`
                : undefined,
          width: 1200,
          height: 800,
        });
      }
    }

    return images;
  }

  private buildDescription(
    community: CommunitySeed,
    bedrooms: number,
    area: number,
    buildYear: number,
    decoration: Decoration,
    subway: SubwayInfo,
    schoolInfo: SchoolInfo,
  ): string {
    const decorationText =
      decoration === Decoration.LUXURY
        ? '豪华装修'
        : decoration === Decoration.FINE
          ? '精装修'
          : decoration === Decoration.SIMPLE
            ? '简单装修'
            : '毛坯';

    const parts = [
      `【户型】${bedrooms}室，建筑面积约 ${this.formatArea(area)}，格局方正，采光通风良好。`,
      `【装修】${decorationText}，${decoration === Decoration.ROUGH ? '可按自己喜好设计' : '保养良好，可直接入住'}。`,
      `【交通】距 ${subway.line} ${subway.station}站约 ${subway.distanceMeters} 米，步行约 ${subway.walkMinutes} 分钟。`,
    ];

    if (schoolInfo.primarySchool) {
      parts.push(
        `【学校】周边有 ${schoolInfo.primarySchool}${schoolInfo.middleSchool ? `、${schoolInfo.middleSchool}` : ''}（学区划分以当年教育部门公示为准）。`,
      );
    }

    parts.push(
      `【小区】${community.name}，位于${community.district}${community.subDistrict}，建成于 ${buildYear} 年，物业费约 ${community.propertyFee} 元/㎡/月。`,
    );
    parts.push('【说明】本房源信息由系统模拟生成，仅用于产品演示，不代表真实在售房源。');

    return parts.join('\n');
  }

  private formatArea(area: number): string {
    return `${Number.isInteger(area) ? area : area.toFixed(1)}㎡`;
  }

  // -------------------------------------------------------------------------
  // 模拟数据变化（供演示与测试使用）
  // -------------------------------------------------------------------------

  /**
   * 模拟一次降价。
   * 返回被修改的房源，便于调用方直接断言。
   */
  simulatePriceChange(externalId: string, newTotalPrice: number): NormalizedProperty | null {
    const dataset = this.ensureDataset();
    const property = dataset.get(externalId);
    if (!property) return null;

    const oldPrice = property.totalPrice;
    const change = newTotalPrice - oldPrice;
    const changePercent = oldPrice > 0 ? Number(((change / oldPrice) * 100).toFixed(3)) : 0;

    // 重算单价
    const newUnitPrice = Math.round(newTotalPrice / property.area);

    property.totalPrice = newTotalPrice;
    property.unitPrice = newUnitPrice;
    property.lastPriceChange = new Date().toISOString();

    this.statusChanges.push({
      externalId,
      status: property.listingStatus,
      newTotalPrice,
      changedAt: new Date(),
    });

    this.logger.log(
      `模拟价格变化：${externalId} ${oldPrice} → ${newTotalPrice}（${changePercent}%）`,
    );
    return property;
  }

  /** 模拟下架 */
  simulateDelist(externalId: string): NormalizedProperty | null {
    const dataset = this.ensureDataset();
    const property = dataset.get(externalId);
    if (!property) return null;

    property.listingStatus = ListingStatus.DELISTED;
    this.statusChanges.push({
      externalId,
      status: ListingStatus.DELISTED,
      changedAt: new Date(),
    });
    return property;
  }

  /** 模拟重新挂牌 */
  simulateRelist(externalId: string): NormalizedProperty | null {
    const dataset = this.ensureDataset();
    const property = dataset.get(externalId);
    if (!property) return null;

    property.listingStatus = ListingStatus.ACTIVE;
    this.statusChanges.push({
      externalId,
      status: ListingStatus.ACTIVE,
      changedAt: new Date(),
    });
    return property;
  }

  /** 取全部外部 ID，供同步任务遍历 */
  listExternalIds(): string[] {
    return [...this.ensureDataset().keys()];
  }

  /** 数据集大小 */
  get size(): number {
    return this.ensureDataset().size;
  }
}

/** 把 ID 转成适合放进 URL 的短字符串 */
function userIdSafe(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
}

// 明确标记未使用的导入，避免 lint 噪音（DeviceType 在本文件中确实不需要）
void _unusedDeviceType;
