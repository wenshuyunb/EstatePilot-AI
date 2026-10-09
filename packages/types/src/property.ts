/**
 * 房源领域模型：统一房源结构、Provider 抽象、价格历史。
 *
 * 关键约束：
 * - 所有外部房源数据必须转换为 NormalizedProperty，业务层不感知具体 Provider。
 * - 严禁非法爬取。无官方 API 凭证时只使用 MockPropertyProvider，且界面必须标注 Demo Data。
 */

/** 房源类型 */
export enum PropertyType {
  APARTMENT = 'APARTMENT',
  VILLA = 'VILLA',
  TOWNHOUSE = 'TOWNHOUSE',
  SHOP = 'SHOP',
  OFFICE = 'OFFICE',
  OTHER = 'OTHER',
}

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  [PropertyType.APARTMENT]: '住宅',
  [PropertyType.VILLA]: '别墅',
  [PropertyType.TOWNHOUSE]: '洋房/联排',
  [PropertyType.SHOP]: '商铺',
  [PropertyType.OFFICE]: '写字楼',
  [PropertyType.OTHER]: '其他',
};

/** 挂牌状态 */
export enum ListingStatus {
  /** 在售 */
  ACTIVE = 'ACTIVE',
  /** 已预订/已下定 */
  PENDING = 'PENDING',
  /** 已成交 */
  SOLD = 'SOLD',
  /** 下架 */
  DELISTED = 'DELISTED',
  /** 暂缓（业主暂停） */
  SUSPENDED = 'SUSPENDED',
}

export const LISTING_STATUS_LABELS: Record<ListingStatus, string> = {
  [ListingStatus.ACTIVE]: '在售',
  [ListingStatus.PENDING]: '已下定',
  [ListingStatus.SOLD]: '已成交',
  [ListingStatus.DELISTED]: '已下架',
  [ListingStatus.SUSPENDED]: '暂缓出售',
};

/** 产权类型 */
export enum OwnershipType {
  FREEHOLD = 'FREEHOLD',
  /** 房改房 */
  HOUSING_REFORM = 'HOUSING_REFORM',
  /** 经济适用房 */
  AFFORDABLE = 'AFFORDABLE',
  /** 动迁安置房 */
  RELOCATION = 'RELOCATION',
  COMMERCIAL = 'COMMERCIAL',
  OTHER = 'OTHER',
}

export const OWNERSHIP_TYPE_LABELS: Record<OwnershipType, string> = {
  [OwnershipType.FREEHOLD]: '商品房',
  [OwnershipType.HOUSING_REFORM]: '房改房',
  [OwnershipType.AFFORDABLE]: '经济适用房',
  [OwnershipType.RELOCATION]: '动迁安置房',
  [OwnershipType.COMMERCIAL]: '商办产权',
  [OwnershipType.OTHER]: '其他',
};

/** 装修情况 */
export enum Decoration {
  ROUGH = 'ROUGH',
  SIMPLE = 'SIMPLE',
  FINE = 'FINE',
  LUXURY = 'LUXURY',
}

export const DECORATION_LABELS: Record<Decoration, string> = {
  [Decoration.ROUGH]: '毛坯',
  [Decoration.SIMPLE]: '简装',
  [Decoration.FINE]: '精装',
  [Decoration.LUXURY]: '豪装',
};

/** 朝向 */
export enum Orientation {
  SOUTH = 'SOUTH',
  NORTH = 'NORTH',
  EAST = 'EAST',
  WEST = 'WEST',
  SOUTHEAST = 'SOUTHEAST',
  SOUTHWEST = 'SOUTHWEST',
  NORTHEAST = 'NORTHEAST',
  NORTHWEST = 'NORTHWEST',
  /** 南北通透 */
  SOUTH_NORTH = 'SOUTH_NORTH',
}

export const ORIENTATION_LABELS: Record<Orientation, string> = {
  [Orientation.SOUTH]: '朝南',
  [Orientation.NORTH]: '朝北',
  [Orientation.EAST]: '朝东',
  [Orientation.WEST]: '朝西',
  [Orientation.SOUTHEAST]: '东南',
  [Orientation.SOUTHWEST]: '西南',
  [Orientation.NORTHEAST]: '东北',
  [Orientation.NORTHWEST]: '西北',
  [Orientation.SOUTH_NORTH]: '南北通透',
};

/** 房源数据来源 Provider */
export enum PropertyProviderKind {
  /** 内置模拟数据（Demo，界面标注 Demo Data） */
  MOCK = 'MOCK',
  /** 贝壳官方开放平台 */
  BEIKE = 'BEIKE',
  /** 安居客官方接口（未来） */
  ANJUKE = 'ANJUKE',
  /** 中介公司自有房源库 */
  INTERNAL = 'INTERNAL',
}

export const PROPERTY_PROVIDER_LABELS: Record<PropertyProviderKind, string> = {
  [PropertyProviderKind.MOCK]: '模拟数据（Demo）',
  [PropertyProviderKind.BEIKE]: '贝壳开放平台',
  [PropertyProviderKind.ANJUKE]: '安居客',
  [PropertyProviderKind.INTERNAL]: '自有房源库',
};

/** 学区信息 */
export interface SchoolInfo {
  /** 对口小学 */
  primarySchool?: string;
  /** 对口初中 */
  middleSchool?: string;
  /** 是否重点学区 */
  isKeySchool?: boolean;
  /** 学位是否被占用 */
  seatOccupied?: boolean;
  /** 备注 */
  note?: string;
}

/** 地铁信息 */
export interface SubwayInfo {
  /** 线路名，如「2 号线」 */
  line?: string;
  /** 站名 */
  station?: string;
  /** 距离（米） */
  distanceMeters?: number;
  /** 步行分钟数 */
  walkMinutes?: number;
}

/** 图片 */
export interface PropertyImage {
  id?: string;
  url: string;
  /** 图片类别，用于区分实景/户型图/小区图 */
  category?: 'INTERIOR' | 'EXTERIOR' | 'FLOOR_PLAN' | 'COMMUNITY' | 'MAP' | 'OTHER';
  /** 排序 */
  sortOrder?: number;
  /** 说明 */
  caption?: string;
  /** 图片宽度，便于前端预留占位避免布局抖动 */
  width?: number;
  /** 图片高度 */
  height?: number;
}

/**
 * 统一房源结构 —— 所有 Provider 的输出都必须归一化成它。
 * 字段与需求文档 §14 完全对齐。
 */
export interface NormalizedProperty {
  // ---- 外部来源标识 ----
  externalProvider: PropertyProviderKind;
  externalId: string;
  /** Provider 原始数据，存 JSONB，便于追溯与重新解析 */
  rawData?: Record<string, unknown> | null;

  // ---- 位置 ----
  city: string;
  district: string;
  subDistrict: string | null;
  community: string;
  title: string;
  address: string | null;
  longitude: number | null;
  latitude: number | null;

  // ---- 价格（单位：元） ----
  /** 总价 */
  totalPrice: number;
  /** 单价（元/㎡） */
  unitPrice: number;

  // ---- 户型 ----
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  /** 建筑面积（㎡） */
  area: number;

  // ---- 楼层 ----
  /** 所在楼层，1 起 */
  floor: number | null;
  /** 总楼层 */
  totalFloors: number | null;

  // ---- 房屋属性 ----
  orientation: Orientation | null;
  /** 建成年份，如 2018 */
  buildYear: number | null;
  propertyType: PropertyType;
  ownershipType: OwnershipType | null;
  decoration: Decoration | null;
  elevator: boolean | null;

  // ---- 配套 ----
  subwayDistance: number | null;
  subway: SubwayInfo | null;
  schoolInfo: SchoolInfo | null;

  // ---- 展示 ----
  tags: string[];
  images: PropertyImage[];
  /** 户型图 URL 列表 */
  floorPlan: string[];
  description: string | null;

  // ---- 状态与时间 ----
  listingStatus: ListingStatus;
  listingDate: string | null;
  lastPriceChange: string | null;
}

/**
 * 房源数据 Provider 统一接口。
 *
 * 实现类：MockPropertyProvider（已实现）、BeikePropertyProvider（官方 API 骨架）、
 * 未来：AnjukePropertyProvider、InternalPropertyProvider。
 */
export interface PropertyProvider {
  /** Provider 标识 */
  readonly kind: PropertyProviderKind;
  /** 是否已配置可用（例如贝壳需要 AppID/AppKey/Secret） */
  isConfigured(): boolean;
  /** 拉取房源列表（增量同步用） */
  fetchProperties(query: PropertyQuery): Promise<PropertyFetchResult>;
  /** 拉取单套房源详情 */
  fetchPropertyDetail(externalId: string): Promise<NormalizedProperty | null>;
  /** 探测房源状态变化（下架/成交/重新挂牌）用于同步 */
  fetchStatusChanges(since: Date, city: string): Promise<PropertyStatusChange[]>;
}

/** 房源查询条件 */
export interface PropertyQuery {
  city: string;
  district?: string;
  /** 增量同步起点 */
  updatedSince?: Date;
  page?: number;
  pageSize?: number;
}

/** Provider 分页返回 */
export interface PropertyFetchResult {
  items: NormalizedProperty[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** 房源状态变化 */
export interface PropertyStatusChange {
  externalId: string;
  status: ListingStatus;
  /** 变化时的新价格（若同时变价） */
  newTotalPrice?: number;
  changedAt: Date;
}

/** 价格历史记录 */
export interface PriceHistoryEntry {
  id: string;
  propertyId: string;
  oldPrice: number;
  newPrice: number;
  /** 变化额（元），负数表示降价 */
  change: number;
  /** 变化百分比，如 -5.28 表示降价 5.28% */
  changePercent: number;
  createdAt: string;
}

/** 房源同步结果统计 */
export interface PropertySyncResult {
  provider: PropertyProviderKind;
  /** 新入库 */
  created: number;
  /** 已更新 */
  updated: number;
  /** 价格变化 */
  priceChanged: number;
  /** 状态变化 */
  statusChanged: number;
  /** 下架 */
  delisted: number;
  /** 重新挂牌 */
  relisted: number;
  /** 处理失败的条目 */
  failed: number;
  durationMs: number;
}
