/**
 * 房源详情服务 —— 按需加载完整详情与图片。
 *
 * ============================================================================
 * 为什么改为按需（真实容量数据驱动）
 * ============================================================================
 * 实测调用量分析（20 次搜索/天/人的典型场景）：
 *   · 列表预取全部详情：一次搜索 11 次调用 → 约 220 次/天/人
 *   · 列表只取摘要 + 详情按需：一次搜索 1 次调用 → 约 30 次/天/人
 *
 * 而实测：11 次密集调用即触发贝壳限流，**恢复需 30 分钟以上**，
 * 且限流是按账号/Key 计的 —— 10 个经纪人共用同一份额度。
 *
 * 因此策略调整为：
 *   · **列表**：只用搜索响应自带的摘要字段（面积/户型/朝向/楼层/年份/小区）
 *   · **详情**：经纪人点开某一套时才加载（本服务）
 *   · **缓存**：详情加载后落库 + 内存缓存，30 分钟内重复查看零调用
 *
 * ============================================================================
 * 数据来源优先级
 * ============================================================================
 *   1. 内存缓存（本次进程已取过）—— 最快
 *   2. 数据库持久化（历史取过）—— 快，且限流/重启后仍可用
 *   3. 贝壳实时接口 —— 慢（2-3 秒），消耗配额
 *
 * 只有 1、2 都未命中才走 3。这样"同一套房源只看一次"，
 * 反复查看不产生任何额外调用。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BeikeMcpClient } from './beike-mcp-client.js';
import { BeikeDetailCache } from './beike-detail-cache.service.js';
import {
  BeikeDetailParser,
  type PropertyFullDetail,
  type PropertyImage,
} from './beike-detail-parser.service.js';

export interface LoadedDetail {
  detail: PropertyFullDetail;
  images: PropertyImage[];
  vrUrl: string | null;
  /**
   * 数据来源，便于界面如实标注新鲜度。
   *
   * ⚠️ `LOCAL_PROPERTY` 是**不依赖贝壳**的来源 —— 用数据库 `Property` 表
   * 自带字段构造。它的覆盖率是 100%（搜索时就落库了），
   * 因此**贝壳限流时详情功能不会失效**，只是字段少一些。
   */
  from: 'MEMORY_CACHE' | 'DATABASE' | 'LOCAL_PROPERTY' | 'BEIKE_LIVE';
  /** 详情获取时间（界面展示"获取于 X 分钟前"） */
  fetchedAt: string | null;
  /** 可取到的警告（如"本次为历史数据"） */
  note: string | null;
}

/** 数据库读取回调（由调用方注入，避免本服务依赖 requirement 模块） */
export type PersistedDetailLoader = (
  externalId: string,
) => Promise<{ detail: PropertyFullDetail; detailFetchedAt: Date | null } | null>;

/** 数据库写入回调 */
export type PersistedDetailSaver = (
  externalId: string,
  detail: PropertyFullDetail,
) => Promise<void>;

/**
 * 本地房源行读取回调。
 *
 * 用于在内存与数据库都没有完整详情时，**用 Property 表自带字段构造详情**。
 * 这是"贝壳限流也能用"的关键 —— 没有这一步时，
 * 132 套里只有 3 套能在限流期间显示完整信息。
 */
export type LocalPropertyLoader = (
  externalId: string,
) => Promise<Record<string, unknown> | null>;

/**
 * 用本地 `Property` 行构造完整详情 —— **不调用贝壳**。
 *
 * ============================================================================
 * 为什么需要它（真实问题：限流即瘫痪）
 * ============================================================================
 * 实测：132 套房源中只有 3 套有 `fullDetail`（2%），
 * 因为完整详情只在"点开卡片"时才去贝壳取。
 * 一旦贝壳限流，绝大多数房源就只剩极简摘要，详情与复制功能形同虚设。
 *
 * 但 `Property` 表在**搜索时**就已落库 15+ 项字段，覆盖率 100%：
 *   小区 / 城市 / 区域 / 总价 / 单价 / 面积 / 户型 / 卫数 /
 *   朝向 / 建成年份 / 装修 / 电梯 / 物业类型 / 产权 / 在售状态 /
 *   地铁距离 / 学区 / 标签 / 描述 / 封面图 / 户型图
 *
 * 这些字段足够构成一份"能让客户看懂"的房源介绍。
 * 缺少的是小区层面的信息（容积率/绿化率/物业费/周边配套），
 * 那些必须点开时才向贝壳要 —— 但**没有它们不影响基本可用性**。
 *
 * ============================================================================
 * 数据诚实性
 * ============================================================================
 * 本地行缺失的字段一律**留空**，不猜测、不填充占位符。
 * 界面会如实标注"来自本地保存的数据"。
 */
function buildDetailFromLocalRow(row: Record<string, unknown>): PropertyFullDetail {
  /** 安全转字符串 */
  const text = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  /** 安全转数字（Prisma 的 Decimal/BigInt 会以对象或字符串返回） */
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;

    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);

    if (typeof value === 'object') {
      const candidate = value as { toNumber?: () => number; toString?: () => string };
      if (typeof candidate.toNumber === 'function') {
        try {
          return candidate.toNumber();
        } catch {
          // 落到 toString
        }
      }
      if (typeof candidate.toString === 'function') {
        const parsed = Number(candidate.toString());
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    }

    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : null;
  };

  const strArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  const totalPrice = num(row['totalPrice']);
  const unitPrice = num(row['unitPrice']);
  const area = num(row['area']);
  const bedrooms = num(row['bedrooms']);
  const livingRooms = num(row['livingRooms']);

  /** 朝向枚举 → 中文（与前端展示保持一致） */
  const ORIENTATION_LABEL: Record<string, string> = {
    SOUTH: '朝南',
    NORTH: '朝北',
    EAST: '朝东',
    WEST: '朝西',
    SOUTHEAST: '东南',
    SOUTHWEST: '西南',
    NORTHEAST: '东北',
    NORTHWEST: '西北',
    SOUTH_NORTH: '南北通透',
  };

  /** 装修枚举 → 中文 */
  const DECORATION_LABEL: Record<string, string> = {
    ROUGH: '毛坯',
    SIMPLE: '简装',
    FINE: '精装',
    LUXURY: '豪装',
  };

  const orientationKey = text(row['orientation']);
  const decorationKey = text(row['decoration']);

  /**
   * ============================================================================
   * 取出 `rawData.fields` —— 贝壳搜索响应的原始字段
   * ============================================================================
   * 这是**极其重要**的数据来源，实测发现：
   *
   *   `Property` 表的列大量为空（floor 40%、tags 40%），
   *   但同一个房源的 `rawData.fields` 里**明明有值**：
   *     「房源所属楼层」「标签」「周边交通」「学区信息」「单价」…
   *
   * 根因：搜索响应的字段名与我们数据库的列**不是一一对应**，
   *      有些字段（如"房源所属楼层"是"低楼层"这类相对描述）
   *      没有被映射进列，只留在了 rawData 里。
   *
   * 因此本地构造必须**同时读两处**：列为先（结构化的更准），
   * rawData 兜底（覆盖列缺失的情况）。
   *
   * 这样贝壳限流时能显示的信息显著变多，且**不需要任何额外调用**。
   */
  const rawFields = (() => {
    const raw = row['rawData'];

    if (!raw || typeof raw !== 'object') return null;

    const fields = (raw as Record<string, unknown>)['fields'];
    return fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : null;
  })();

  /** 从原始字段里取（返回 null 表示没有） */
  const fromRaw = (key: string): string | null => {
    if (!rawFields) return null;
    return text(rawFields[key]);
  };

  /**
   * ============================================================================
   * 从 `description` 提取结构化字段（真实数据驱动）
   * ============================================================================
   * 实测发现：`description` 覆盖率 **100%**，且格式固定 ——
   *
   *   【户型】3室2厅，117㎡，东南。
   *   【装修与楼层】中楼层。
   *   【小区】莲花国际C区，建成于 2019 年。
   *
   * 而对应的列填充率很低：`decoration` 0%、`floor` 40%。
   *
   * 原因：贝壳的**搜索结果**不返回"装修类型"与"楼层"的原始值，
   * 只在**详情**里才有 —— 但 description 已经把能拿到的都记下来了。
   *
   * 因此这里从 description 反解，**让已有信息不被浪费**：
   * 列有值就用列（更精确），列为空才用 description（兜底）。
   *
   * 之所以可以放心解析：这段文本是**我们自己生成的**（见
   * `beike-response-parser.ts` 的 buildDescription），格式受我们控制。
   */
  const descriptionText = text(row['description']) ?? '';

  /** 从「【装修与楼层】…」段里取内容 */
  const floorAndDecorationSection = /【装修与楼层】([^。\n]*)/.exec(descriptionText)?.[1] ?? '';

  /** 装修：识别已知品类词（"中楼层"这类楼层描述不会被误认） */
  const decorationFromText = (() => {
    const KNOWN = ['豪华装修', '精装修', '精装', '简装', '毛坯', '豪装', '中装'];
    for (const keyword of KNOWN) {
      if (floorAndDecorationSection.includes(keyword)) return keyword;
    }
    return null;
  })();

  /**
   * 楼层文本：从列里拿数字，拿不到就用 description 里的中文描述。
   *
   * 注意「中楼层」这类是**相对描述**（贝壳把楼层归为低/中/高），
   * 不是具体数字。因此不能塞进 `floor`（number 列），
   * 只能作为展示文本。
   */
  const floorFromText =
    /(低楼层|中楼层|高楼层|地下楼层|顶层|底层)/.exec(floorAndDecorationSection)?.[1] ?? null;

  const decorationLabel =
    decorationKey !== null
      ? (DECORATION_LABEL[decorationKey] ?? decorationKey)
      : decorationFromText;

  const floor = num(row['floor']);
  const totalFloors = num(row['totalFloors']);

  /**
   * 楼层文本：列 → description → rawData.fields，三级兜底。
   *
   * 实测三个来源的覆盖率：
   *   · `floor` 列 40%（贝壳把楼层归为"低/中/高"这类**相对描述**，
   *     只有部分响应给了数字，因此列经常为空）
   *   · `description` 100%（我们自己生成的文本里含"中楼层"）
   *   · `rawData.fields['房源所属楼层']` 覆盖未被污染的房源
   */
  const floorText =
    floor !== null && totalFloors !== null
      ? `${floor}层 / 共${totalFloors}层`
      : floor !== null
        ? `${floor}层`
        : totalFloors !== null
          ? `共${totalFloors}层`
          : (fromRaw('房源所属楼层') ?? floorFromText);

  /**
   * 标签：列 → description 提取 → rawData.fields。
   *
   * `tags` 列实测只有 40%，但搜索响应里 18 套有「标签」字段，
   * 且「房源标题」本身常含标签信息（如"全明格局""近地铁"）。
   */
  const tagsFromRaw = Array.isArray(rawFields?.['标签'])
    ? (rawFields['标签'] as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];

  const columnTags = strArray(row['tags']);
  const tags = columnTags.length > 0 ? columnTags : tagsFromRaw;

  const images: PropertyImage[] = [];

  const coverImage = text(row['coverImage']);
  if (coverImage) {
    images.push({ url: coverImage, roomName: null, kind: 'OTHER' });
  }

  for (const url of strArray(row['floorPlan'])) {
    if (url.startsWith('http')) {
      images.push({ url, roomName: null, kind: 'FLOOR_PLAN' });
    }
  }

  return {
    base: {
      title: text(row['description']) ?? text(row['title']),
      // 单价：数据库是整数（元/㎡），格式化成带千分位的文本
      unitPrice: unitPrice !== null ? `${Math.round(unitPrice).toLocaleString('zh-CN')}元/㎡` : null,
      buildingArea: area !== null ? `${area}㎡` : null,
      innerArea: null,
      totalPrice: totalPrice !== null ? `${Math.round(totalPrice / 10_000)}万` : null,
      layoutStructure: null,
      houseType:
        bedrooms !== null
          ? `${bedrooms}室${livingRooms !== null && livingRooms > 0 ? `${livingRooms}厅` : ''}`
          : null,
      houseAge: null,
      listingStatus: text(row['listingStatus']) === 'ACTIVE' ? '在售' : text(row['listingStatus']),
      floor: floorText,
      /**
       * 装修。
       *
       * 数据库 `decoration` 列实测覆盖率 0%（贝壳搜索结果不返回该字段），
       * 因此这里主要靠 `description` 反解 —— 那是我们自己生成的文本，
       * 覆盖率 100%，且格式受控。
       */
      decoration: decorationLabel,
      totalFloors: totalFloors !== null ? `${totalFloors}层` : null,
      hasElevator:
        typeof row['elevator'] === 'boolean' ? (row['elevator'] ? '有电梯' : '无电梯') : null,
      orientation: orientationKey ? (ORIENTATION_LABEL[orientationKey] ?? orientationKey) : null,
      elevatorHouseholdRatio: null,
      buildingType: null,
      usage: null,
      downPayment: null,
      ownership: text(row['ownershipType']),
      beikeScore: null,
      tags,
    },
    /**
     * 小区信息：本地行只有**小区名**，其余（容积率/绿化率/物业费…）
     * 必须点开时向贝壳要。
     *
     * 这里不返回 null 而是返回一个只含名称的对象 ——
     * 让前端"小区信息"段能显示名称，而不是整段消失。
     */
    community: {
      name: text(row['community']),
      aliases: [],
      buildYears: num(row['buildYear']) !== null ? `${num(row['buildYear'])}年` : null,
      totalHouseholds: null,
      floorAreaRatio: null,
      greeningRate: null,
      propertyFee: null,
      propertyCompany: text(row['propertyManagementCompany']),
      parkingRatio: null,
      parkingFee: null,
      fixedParkingSpaces: null,
      separatedTraffic: null,
      isClosed: null,
      rentToSaleRatio: null,
      rentPrice: null,
      waterType: null,
      electricityType: null,
      heatingType: null,
      gasFee: null,
      businessDistrict: text(row['subDistrict']),
      district: text(row['district']),
    },

    /**
     * 周边配套。
     *
     * 优先用 `rawData.fields` 里的**贝壳原始字段** —— 搜索时就落库了，
     * 含「周边交通」「周边教育」等，**不需要再调贝壳**。
     * 拿不到时才退化为本地列的零散信息。
     */
    nearby: (() => {
      const nearby: {
        subway: Array<{ name: string; distanceMeters: number | null; category: string | null }>;
        bus: Array<{ name: string; distanceMeters: number | null; category: string | null }>;
        school: Array<{ name: string; distanceMeters: number | null; category: string | null }>;
        hospital: Array<{ name: string; distanceMeters: number | null; category: string | null }>;
        shopping: Array<{ name: string; distanceMeters: number | null; category: string | null }>;
        park: Array<{ name: string; distanceMeters: number | null; category: string | null }>;
        other: Array<{ name: string; distanceMeters: number | null; category: string | null }>;
      } = { subway: [], bus: [], school: [], hospital: [], shopping: [], park: [], other: [] };

      /** 从原始字段里解析一条「距离XX地铁站1234米」 */
      const parseFacility = (
        raw: unknown,
      ): { name: string; distanceMeters: number | null; category: string | null } | null => {
        const text = String(raw ?? '').trim();
        if (text.length === 0) return null;

        const distanceMatch = /(\d+)\s*米\s*$/.exec(text);
        const distanceMeters = distanceMatch?.[1] ? Number(distanceMatch[1]) : null;

        let body = text.replace(/^距离/, '');
        if (distanceMatch) body = body.slice(0, body.length - distanceMatch[0].length).trim();

        if (body.length === 0) return null;

        const CATEGORIES = [
          '地铁站', '公交车站', '幼儿园', '小学', '中学', '大学',
          '综合医院', '专科医院', '诊所', '药店', '商场', '超市', '公园',
        ];

        let name = body;
        let category: string | null = null;

        for (const candidate of CATEGORIES) {
          if (body.endsWith(candidate) && body.length > candidate.length) {
            category = candidate;
            name = body.slice(0, body.length - candidate.length).trim();
            break;
          }
        }

        return { name: name.length > 0 ? name : body, distanceMeters, category };
      };

      /** 取出 rawData.fields */
      const rawFields = (() => {
        const raw = row['rawData'];

        if (!raw || typeof raw !== 'object') return null;

        const fields = (raw as Record<string, unknown>)['fields'];
        return fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : null;
      })();

      if (rawFields) {
        /** 「周边交通」数组里既有地铁也有公交，按品类拆分 */
        const transport = rawFields['周边交通'];
        if (Array.isArray(transport)) {
          for (const item of transport) {
            const facility = parseFacility(item);
            if (!facility) continue;

            if (facility.category?.includes('地铁')) nearby.subway.push(facility);
            else nearby.bus.push(facility);
          }
        }

        const education = rawFields['周边教育'];
        if (Array.isArray(education)) {
          for (const item of education) {
            const facility = parseFacility(item);
            if (facility) nearby.school.push(facility);
          }
        }

        const medical = rawFields['周边医疗'];
        if (Array.isArray(medical)) {
          for (const item of medical) {
            const facility = parseFacility(item);
            if (facility) nearby.hospital.push(facility);
          }
        }

        const shoppingRaw = rawFields['周边购物'] ?? rawFields['周边商业'];
        if (Array.isArray(shoppingRaw)) {
          for (const item of shoppingRaw) {
            const facility = parseFacility(item);
            if (facility) nearby.shopping.push(facility);
          }
        }

        const parkRaw = rawFields['周边公园休闲'] ?? rawFields['周边休闲'];
        if (Array.isArray(parkRaw)) {
          for (const item of parkRaw) {
            const facility = parseFacility(item);
            if (facility) nearby.park.push(facility);
          }
        }

        // 按距离升序（经纪人最关心"最近的有多远"）
        for (const list of Object.values(nearby)) {
          list.sort((a, b) => {
            if (a.distanceMeters === null) return 1;
            if (b.distanceMeters === null) return -1;
            return a.distanceMeters - b.distanceMeters;
          });
        }
      }

      /**
       * 兜底：原始字段里没有时，用本地列。
       *
       * ⚠️ 站名尽量从 `rawData.fields['周边交通']` 里找 ——
       *    那个数组里常有「杨高北路(地铁站)地铁站步行距离1632米」这种条目，
       *    含**真实站名**。只有真的找不到时才写"最近地铁站"
       *    （不能编一个站名出来）。
       */
      if (nearby.subway.length === 0) {
        const subwayDistance = num(row['subwayDistance']);

        if (subwayDistance !== null && Array.isArray(rawFields?.['周边交通'])) {
          for (const item of rawFields['周边交通'] as unknown[]) {
            const asText = String(item ?? '');

            // 只在距离一致时采用，避免张冠李戴
            if (!asText.includes(String(subwayDistance))) continue;

            // 从「xxx(地铁站)地铁站步行距离1632米」里抽出站名
            const nameMatch = /^([^(（]+)/.exec(asText.replace(/^距离/, '').trim());
            const stationName = nameMatch?.[1]?.trim();

            if (stationName && stationName.length > 0 && stationName.length < 30) {
              nearby.subway.push({
                name: stationName,
                distanceMeters: subwayDistance,
                category: '地铁站',
              });
              break;
            }
          }
        }

        if (nearby.subway.length === 0 && subwayDistance !== null) {
          nearby.subway.push({
            name: '最近地铁站',
            distanceMeters: subwayDistance,
            category: '地铁站',
          });
        }
      }

      if (nearby.school.length === 0) {
        const schoolInfoRaw = row['schoolInfo'];
        if (schoolInfoRaw && typeof schoolInfoRaw === 'object') {
          const primarySchool = text((schoolInfoRaw as Record<string, unknown>)['primarySchool']);
          if (primarySchool) {
            nearby.school.push({ name: primarySchool, distanceMeters: null, category: '小学' });
          }
        }
      }

      /**
       * 学区兜底：`schoolInfo` 列实测覆盖率 0%，
       * 但 `rawData.fields['学区信息']` 有 16 套房源带值。
       *
       * 原始值形态不确定（可能是字符串或对象），因此做兼容处理：
       *   · 字符串 → 直接作为学校名
       *   · 对象   → 尝试常见键名
       */
      if (nearby.school.length === 0 && rawFields?.['学区信息'] !== undefined) {
        const rawSchool = rawFields['学区信息'];

        if (typeof rawSchool === 'string' && rawSchool.trim().length > 0) {
          nearby.school.push({ name: rawSchool.trim(), distanceMeters: null, category: null });
        } else if (rawSchool && typeof rawSchool === 'object') {
          const info = rawSchool as Record<string, unknown>;
          const name =
            text(info['小学']) ?? text(info['primarySchool']) ?? text(info['学校']) ?? text(info['名称']);

          if (name) {
            nearby.school.push({ name, distanceMeters: null, category: '小学' });
          }
        }
      }

      const totalCount = Object.values(nearby).reduce((sum, list) => sum + list.length, 0);
      return totalCount > 0 ? nearby : null;
    })(),

    images,
    vrUrl: null,
  };
}

@Injectable()
export class PropertyDetailService {
  private readonly logger = new Logger(PropertyDetailService.name);

  /** 同一房源的并发加载去重（避免用户连点产生多次请求） */
  private readonly inflight = new Map<string, Promise<LoadedDetail | null>>();

  constructor(
    private readonly beike: BeikeMcpClient,
    private readonly parser: BeikeDetailParser,
    private readonly cache: BeikeDetailCache,
  ) {}

  /**
   * 加载某套房源的完整详情。
   *
   * @param city 城市（贝壳接口必填）
   * @param loadPersisted 从数据库读取历史详情的回调
   * @param savePersisted 把实时详情落库的回调
   * @param loadLocalProperty 读取本地 Property 行的回调（用于无详情时兜底构造）
   * @param allowLiveFetch 是否允许调用贝壳
   */
  async load(
    externalId: string,
    city: string,
    loadPersisted: PersistedDetailLoader,
    savePersisted: PersistedDetailSaver,
    loadLocalProperty?: LocalPropertyLoader,
    allowLiveFetch = true,
  ): Promise<LoadedDetail | null> {
    // ---- 并发去重：同一房源已在加载中就直接复用 ----
    const existing = this.inflight.get(externalId);
    if (existing) {
      this.logger.debug(`房源 ${externalId} 详情已在加载中，复用同一请求`);
      return existing;
    }

    const task = this.doLoad(
      externalId,
      city,
      loadPersisted,
      savePersisted,
      loadLocalProperty,
      allowLiveFetch,
    ).finally(() => {
      this.inflight.delete(externalId);
    });

    this.inflight.set(externalId, task);
    return task;
  }

  private async doLoad(
    externalId: string,
    city: string,
    loadPersisted: PersistedDetailLoader,
    savePersisted: PersistedDetailSaver,
    loadLocalProperty?: LocalPropertyLoader,
    allowLiveFetch = true,
  ): Promise<LoadedDetail | null> {
    // ======================================================================
    // 1. 内存缓存
    // ======================================================================
    const cached = this.cache.get(externalId);
    if (cached) {
      return {
        detail: cached.detail,
        images: cached.images,
        vrUrl: cached.vrUrl,
        from: 'MEMORY_CACHE',
        fetchedAt: new Date(cached.cachedAt).toISOString(),
        note: null,
      };
    }

    // ======================================================================
    // 2. 数据库持久化
    // ======================================================================
    try {
      const persisted = await loadPersisted(externalId);
      if (persisted) {
        // 回填内存缓存，下次更快
        this.cache.set(externalId, {
          detail: persisted.detail,
          vrUrl: persisted.detail.vrUrl,
          images: persisted.detail.images,
        });

        const ageMinutes = persisted.detailFetchedAt
          ? Math.round((Date.now() - persisted.detailFetchedAt.getTime()) / 60_000)
          : null;

        return {
          detail: persisted.detail,
          images: persisted.detail.images,
          vrUrl: persisted.detail.vrUrl,
          from: 'DATABASE',
          fetchedAt: persisted.detailFetchedAt?.toISOString() ?? null,
          note:
            ageMinutes !== null && ageMinutes > 60
              ? `这是 ${Math.round(ageMinutes / 60)} 小时前获取的详情，价格与在售状态可能有变化`
              : null,
        };
      }
    } catch (error) {
      this.logger.warn(
        `读取历史详情失败（房源 ${externalId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // ======================================================================
    // 2.5 本地 Property 行构造（**不调贝壳**）
    // ======================================================================
    //
    // ============================================================================
    // 为什么必须有这一层（真实问题：限流即失效）
    // ============================================================================
    // 实测：132 套房源里只有 3 套（2%）有 `fullDetail` ——
    // 因为完整详情只在"经纪人点开卡片"时才去贝壳取。
    // 结果是**贝壳一限流，99% 的房源就只剩极简摘要**。
    //
    // 但 `Property` 表本身在**搜索时**就落库了 15+ 项可用字段
    // （小区/区域/价格/面积/户型/朝向/年份/装修/标签/描述…），
    // 覆盖率 100%，且**完全不需要再调贝壳**。
    //
    // 因此这里先用本地行构造一份"够用"的详情：
    //   · 覆盖率 100% → 限流时功能不失效
    //   · 字段比贝壳详情少（没有容积率/物业费/周边配套）→ 如实标注
    //
    // 若调用方不允许实时取数（限流/预算用尽），就在这里返回，
    // 不再尝试贝壳。
    let localDetail: PropertyFullDetail | null = null;

    if (loadLocalProperty) {
      try {
        const row = await loadLocalProperty(externalId);

        if (row) {
          localDetail = buildDetailFromLocalRow(row);
          this.logger.debug(
            `房源 ${externalId} 使用本地 Property 字段构造详情（无需贝壳）`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `读取本地房源失败（房源 ${externalId}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // ---- 不允许实时取数时，直接用本地构造结果返回 ----
    if (!allowLiveFetch) {
      if (!localDetail) return null;

      return {
        detail: localDetail,
        images: localDetail.images,
        vrUrl: null,
        from: 'LOCAL_PROPERTY',
        fetchedAt: null,
        note: '当前未查询贝壳，以下信息来自本地已保存的房源数据（价格与在售状态可能有变化）',
      };
    }

    // ======================================================================
    // 3. 贝壳实时接口（消耗配额）
    // ======================================================================
    const client = this.beike.getDirectClient();
    if (!client) {
      this.logger.debug('直连未启用，使用本地构造的详情');

      if (!localDetail) return null;

      return {
        detail: localDetail,
        images: localDetail.images,
        vrUrl: null,
        from: 'LOCAL_PROPERTY',
        fetchedAt: null,
        note: null,
      };
    }

    try {
      const detailResult = await client.callTool('entity_detail', {
        city_name: city,
        entity_ids: externalId,
        entity_type: 'house',
      });

      if (!detailResult.ok) {
        this.logger.warn(
          `房源 ${externalId} 详情获取失败：${String(detailResult.error).slice(0, 120)}`,
        );

        /**
         * 贝壳取不到时**回退到本地构造**，而不是返回 null。
         *
         * 这是"限流也能用"的最后一道保障 —— 有本地数据就一定有东西给客户看。
         */
        if (!localDetail) return null;

        return {
          detail: localDetail,
          images: localDetail.images,
          vrUrl: null,
          from: 'LOCAL_PROPERTY',
          fetchedAt: null,
          note: '贝壳暂时取不到这套房源的详情，以下信息来自本地已保存的数据',
        };
      }

      const detail = this.parser.parseDetail(detailResult.text);

      // 图片单独取（entity_detail 只带户型图，实景图要 entity_material）
      const materialResult = await client.callTool('entity_material', {
        city_name: city,
        entity_ids: externalId,
        entity_type: 'house',
        fields: ['房源图片'],
      });

      const material = materialResult.ok
        ? this.parser.parseMaterial(materialResult.text)
        : { images: [] as PropertyImage[], vrUrl: null as string | null };

      // 合并图片并按 URL 去重
      const merged = new Map<string, PropertyImage>();
      for (const image of [...material.images, ...detail.images]) {
        const key = image.url.split('?')[0] ?? image.url;
        if (!merged.has(key)) merged.set(key, image);
      }

      const images = [...merged.values()];
      detail.images = images;
      detail.vrUrl = material.vrUrl ?? detail.vrUrl;

      // 写缓存 + 落库
      this.cache.set(externalId, { detail, vrUrl: detail.vrUrl, images });

      try {
        await savePersisted(externalId, detail);
      } catch (error) {
        // 落库失败不影响返回 —— 内存缓存已有
        this.logger.warn(
          `详情落库失败（房源 ${externalId}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return {
        detail,
        images,
        vrUrl: detail.vrUrl,
        from: 'BEIKE_LIVE',
        fetchedAt: new Date().toISOString(),
        note: null,
      };
    } catch (error) {
      this.logger.warn(
        `房源 ${externalId} 实时详情异常：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
