/**
 * 贝壳房源详情解析器 —— 把 `entity_detail` / `entity_material` 的原始返回
 * 解析成**与贝壳 App 同等详细**的结构化数据。
 *
 * ============================================================================
 * 背景：为什么要单独做这个
 * ============================================================================
 * 贝壳 `entity_detail` 返回的信息极其丰富，但原实现只从中取了 7 个字段
 * （小区/面积/总价/户型/朝向/楼层/建成年代），**其余全部丢弃**。
 * 经纪人在界面上看不到：
 *   · 单价、套内面积、首付、房屋年限（满五/满二）
 *   · 电梯、梯户比例、楼型、用途、户型结构
 *   · 小区容积率、绿化率、物业费、物业公司、车位配比、人车分流、封闭小区
 *   · 周边地铁/公交/学校/医院/商场/公园 及其**距离**
 *
 * 而这些恰恰是经纪人向客户介绍房源时**最常被问到**的信息。
 *
 * ============================================================================
 * 解析策略
 * ============================================================================
 * 贝壳返回的是**分段 JSON**（每个 `{...}` 是一个主题块）：
 *   {"基础信息": {...}}
 *   {"周边交通": ["距离杏滨地铁站1437米", ...]}
 *   {"周边教育": [...]}
 *
 * 因此不能用单个 JSON.parse —— 要按块解析并按主题归类。
 * 距离文本形如「距离杏滨地铁站1437米」，需要拆出**名称 + 距离**两段，
 * 便于前端按距离排序（经纪人关心"最近的地铁站有多远"）。
 */

import { Injectable, Logger } from '@nestjs/common';

/** 一条周边配套（含距离） */
export interface NearbyFacility {
  /** 设施名称，如「杏滨地铁站」「厦门市曾营小学」 */
  name: string;
  /** 距离（米）。可能为 null（部分条目没写距离） */
  distanceMeters: number | null;
  /** 品类，如「地铁站」「小学」「综合医院」 */
  category: string | null;
}

/** 一张房源图片 */
export interface PropertyImage {
  url: string;
  /** 房间名（客厅/卧室/厨房…）。户型图与 VR 图为 null */
  roomName: string | null;
  /** 图片类型 */
  kind: 'ROOM' | 'FLOOR_PLAN' | 'VR' | 'OTHER';
}

/** 小区信息 */
export interface CommunityDetail {
  name: string | null;
  aliases: string[];
  buildYears: string | null;
  totalHouseholds: number | null;
  floorAreaRatio: string | null;
  greeningRate: string | null;
  propertyFee: string | null;
  propertyCompany: string | null;
  parkingRatio: string | null;
  parkingFee: string | null;
  fixedParkingSpaces: number | null;
  /** 人车分流（是/否） */
  separatedTraffic: string | null;
  /** 封闭小区（是/否） */
  isClosed: string | null;
  /** 租售比 */
  rentToSaleRatio: string | null;
  /** 商圈租房均价 */
  rentPrice: string | null;
  waterType: string | null;
  electricityType: string | null;
  heatingType: string | null;
  gasFee: string | null;
  businessDistrict: string | null;
  district: string | null;
}

/**
 * 完整房源详情。
 *
 * 字段命名原则：**与贝壳 App 的展示项一一对应**，
 * 让经纪人能直接拿去向客户介绍，不需要再回去翻 App。
 */
export interface PropertyFullDetail {
  /** 基础信息 */
  base: {
    title: string | null;
    unitPrice: string | null;
    buildingArea: string | null;
    /** 套内面积（贝壳有时返回"暂无"） */
    innerArea: string | null;
    totalPrice: string | null;
    layoutStructure: string | null;
    houseType: string | null;
    /** 房屋年限：满五 / 满二 / 暂无 */
    houseAge: string | null;
    listingStatus: string | null;
    floor: string | null;
    totalFloors: string | null;
    /** 是否有电梯 */
    hasElevator: string | null;
    orientation: string | null;
    /** 梯户比例：两梯三户 */
    elevatorHouseholdRatio: string | null;
    /** 楼型：板楼 / 塔楼 */
    buildingType: string | null;
    /** 用途：普通住宅 */
    usage: string | null;
    /**
     * 装修：精装 / 简装 / 毛坯。
     *
     * 来源有两处（取先有值的）：
     *   1. 贝壳详情里的「装修类型」
     *   2. 从数据库 `description` 反解 —— 因为贝壳**搜索结果**不返回装修类型，
     *      而 description 里已经记下来了
     *      （实测 `decoration` 列覆盖率 0%，但 description 覆盖率 100%）
     */
    decoration: string | null;
    /** 首付提示：首付约41.9万起 */
    downPayment: string | null;
    /** 交易权属：商品房 */
    ownership: string | null;
    /** 房源综合分（贝壳的排序分，仅供参考） */
    beikeScore: number | null;
    /** 标签：满五 / 明厨明卫 */
    tags: string[];
  } | null;

  /** 小区 */
  community: CommunityDetail | null;

  /** 周边配套（按距离升序，最近的在前） */
  nearby: {
    subway: NearbyFacility[];
    bus: NearbyFacility[];
    school: NearbyFacility[];
    hospital: NearbyFacility[];
    shopping: NearbyFacility[];
    park: NearbyFacility[];
    other: NearbyFacility[];
  } | null;

  /** 图片 */
  images: PropertyImage[];

  /** VR 看房跳转地址（贝壳 App scheme，可能为空） */
  vrUrl: string | null;
}

@Injectable()
export class BeikeDetailParser {
  private readonly logger = new Logger(BeikeDetailParser.name);

  /**
   * 解析 `entity_detail` 的返回文本。
   *
   * @param text 工具返回的原始文本（含多个分段 JSON）
   */
  parseDetail(text: string): PropertyFullDetail {
    const blocks = this.extractJsonBlocks(text);

    const result: PropertyFullDetail = {
      base: null,
      community: null,
      nearby: null,
      images: [],
      vrUrl: null,
    };

    for (const block of blocks) {
      for (const [key, value] of Object.entries(block)) {
        if (key === '基础信息') {
          result.base = this.parseBaseInfo(value);
          // 基础信息里也带房源图片（户型图）
          if (value && typeof value === 'object') {
            const images = (value as Record<string, unknown>)['房源图片'];
            if (images) result.images.push(...this.parseImages(images));
          }
        } else if (key === '基本信息') {
          // 小区基本信息
          result.community = this.parseCommunity(value);
        } else if (key.startsWith('周边')) {
          result.nearby ??= this.emptyNearby();
          this.assignNearby(result.nearby, key, value);
        } else if (key === '房源图片') {
          result.images.push(...this.parseImages(value));
        }
      }
    }

    // 去重（同一张图可能既在基础信息又在房源图片里出现）
    result.images = this.dedupeImages(result.images);

    // 周边配套去重（贝壳原始数据里同一条目会重复出现）
    if (result.nearby) {
      for (const key of Object.keys(result.nearby) as Array<keyof typeof result.nearby>) {
        result.nearby[key] = this.dedupeFacilities(result.nearby[key]);
      }
    }

    // 基础信息里的"标签"是逗号分隔的字符串，拆成数组
    if (result.base?.tags) {
      result.base.tags = result.base.tags
        .flatMap((tag) => String(tag).split(/[,，]/))
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    }

    return result;
  }

  /**
   * 解析 `entity_material` 的返回文本（图片为主）。
   *
   * 结构：`{"<房源ID>": {"房源图片": {"VR": {...}, "户型图片": "...", "房间图片": [...]}}}`
   */
  parseMaterial(text: string): { images: PropertyImage[]; vrUrl: string | null } {
    const blocks = this.extractJsonBlocks(text);

    const images: PropertyImage[] = [];
    let vrUrl: string | null = null;

    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      const record = node as Record<string, unknown>;

      // 房间图片数组：[{图片地址, 房间名称}]
      if (Array.isArray(record['房间图片'])) {
        for (const item of record['房间图片']) {
          if (!item || typeof item !== 'object') continue;
          const entry = item as Record<string, unknown>;
          const url = String(entry['图片地址'] ?? '').trim();
          if (!url) continue;

          images.push({
            url,
            roomName: entry['房间名称'] ? String(entry['房间名称']) : null,
            kind: 'ROOM',
          });
        }
      }

      if (record['户型图片']) {
        images.push({ url: String(record['户型图片']), roomName: null, kind: 'FLOOR_PLAN' });
      }

      // VR：封面图 + 跳转地址
      if (record['VR'] && typeof record['VR'] === 'object') {
        const vr = record['VR'] as Record<string, unknown>;
        if (vr['封面图']) {
          images.push({ url: String(vr['封面图']), roomName: null, kind: 'VR' });
        }
        if (vr['跳转地址']) vrUrl = String(vr['跳转地址']);
      }

      // 继续向下找
      for (const value of Object.values(record)) {
        if (value && typeof value === 'object') walk(value);
      }
    };

    for (const block of blocks) walk(block);

    return { images: this.dedupeImages(images), vrUrl };
  }

  // ==========================================================================
  // 内部实现
  // ==========================================================================

  /**
   * 从文本里提取所有**顶层** JSON 块。
   *
   * 为什么不用单个 JSON.parse：贝壳的返回是**分段 JSON**，
   * 多个 `{...}` 并列且各属不同主题，整体不是合法 JSON。
   * 因此需要按大括号配对逐个提取（要考虑字符串内的括号）。
   */
  private extractJsonBlocks(text: string): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];

    let index = 0;
    while (index < text.length) {
      const start = text.indexOf('{', index);
      if (start < 0) break;

      const end = this.findMatchingBrace(text, start);
      if (end <= start) {
        index = start + 1;
        continue;
      }

      const candidate = text.slice(start, end + 1);
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          blocks.push(parsed as Record<string, unknown>);
        }
      } catch {
        // 不是合法 JSON，跳过继续找下一个
      }

      index = end + 1;
    }

    return blocks;
  }

  /** 找与起始大括号配对的收尾位置（考虑字符串内的括号与转义） */
  private findMatchingBrace(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  /** 解析「基础信息」 */
  private parseBaseInfo(value: unknown): PropertyFullDetail['base'] {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;

    const str = (key: string): string | null => {
      const raw = record[key];
      if (raw === undefined || raw === null) return null;
      const text = String(raw).trim();
      return text.length > 0 ? text : null;
    };

    const beikeScoreRaw = record['房源综合分'];
    const beikeScore =
      typeof beikeScoreRaw === 'number'
        ? beikeScoreRaw
        : beikeScoreRaw !== undefined && beikeScoreRaw !== null && beikeScoreRaw !== ''
          ? Number(beikeScoreRaw)
          : null;

    return {
      title: str('房源标题'),
      unitPrice: str('单价'),
      buildingArea: str('建筑面积'),
      // 贝壳对缺失的套内面积返回"套内面积暂无"，这种占位文本要清掉
      innerArea: this.cleanPlaceholder(str('套内面积')),
      totalPrice: str('总价'),
      layoutStructure: str('户型结构'),
      houseType: str('房型'),
      houseAge: str('房屋年限'),
      listingStatus: str('房源售卖状态'),
      floor: str('房源所属楼层'),
      totalFloors: str('楼栋总楼层'),
      hasElevator: str('是否有电梯'),
      orientation: str('朝向'),
      elevatorHouseholdRatio: str('梯户比例'),
      buildingType: str('楼型'),
      usage: str('用途'),
      /**
       * 装修。
       *
       * 贝壳详情的字段名在不同接口下不一致，因此按优先级尝试多个：
       * 「装修类型」是详情接口的写法，「装修」是部分返回的简写。
       */
      decoration: str('装修类型') ?? str('装修'),
      downPayment: str('首付'),
      ownership: str('交易权属'),
      beikeScore: Number.isFinite(beikeScore) ? beikeScore : null,
      // 标签原样保留，由 parseDetail 统一拆分
      tags: record['标签'] !== undefined && record['标签'] !== null ? [String(record['标签'])] : [],
    };
  }

  /** 解析小区「基本信息」 */
  private parseCommunity(value: unknown): CommunityDetail | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;

    const str = (key: string): string | null => {
      const raw = record[key];
      if (raw === undefined || raw === null) return null;
      const text = String(raw).trim();
      return text.length > 0 ? text : null;
    };

    const num = (key: string): number | null => {
      const raw = record[key];
      if (raw === undefined || raw === null || raw === '') return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const aliases = str('小区别名');

    return {
      name: str('小区名称'),
      aliases: aliases ? aliases.split(/[,，]/).map((a) => a.trim()).filter(Boolean) : [],
      buildYears: str('建成年代'),
      totalHouseholds: num('总户数'),
      floorAreaRatio: str('容积率'),
      greeningRate: str('绿化率'),
      propertyFee: str('物业费'),
      propertyCompany: str('物业公司'),
      parkingRatio: str('车位配比'),
      parkingFee: str('停车费'),
      fixedParkingSpaces: num('固定车位数'),
      separatedTraffic: str('人车分流'),
      isClosed: str('封闭小区'),
      rentToSaleRatio: str('租售比'),
      rentPrice: str('租房均价'),
      waterType: str('用水类型'),
      electricityType: str('用电类型'),
      heatingType: str('供暖类型'),
      gasFee: str('燃气费'),
      businessDistrict: str('所属商圈'),
      district: str('所属城区'),
    };
  }

  private emptyNearby(): NonNullable<PropertyFullDetail['nearby']> {
    return { subway: [], bus: [], school: [], hospital: [], shopping: [], park: [], other: [] };
  }

  /** 把一条「周边XX」数组归类到对应桶里 */
  private assignNearby(
    target: NonNullable<PropertyFullDetail['nearby']>,
    key: string,
    value: unknown,
  ): void {
    if (!Array.isArray(value)) return;

    const facilities = value
      .map((entry) => this.parseFacility(String(entry)))
      .filter((entry): entry is NearbyFacility => entry !== null)
      .filter((entry) => this.isPlausibleFacility(entry, key));

    // 按距离升序 —— 经纪人最关心"最近的有多远"
    facilities.sort((a, b) => {
      if (a.distanceMeters === null) return 1;
      if (b.distanceMeters === null) return -1;
      return a.distanceMeters - b.distanceMeters;
    });

    if (key.includes('交通')) {
      // 同一条目里既有地铁也有公交，按品类拆开
      target.subway.push(...facilities.filter((f) => f.category?.includes('地铁')));
      target.bus.push(...facilities.filter((f) => !f.category?.includes('地铁')));
    } else if (key.includes('教育')) {
      target.school.push(...facilities);
    } else if (key.includes('医疗')) {
      target.hospital.push(...facilities);
    } else if (key.includes('购物') || key.includes('商业')) {
      target.shopping.push(...facilities);
    } else if (key.includes('公园') || key.includes('休闲')) {
      target.park.push(...facilities);
    } else {
      target.other.push(...facilities);
    }
  }

  /**
   * 剔除明显不属于该类目的条目（贝壳原始数据有噪音）。
   *
   * 实测发现的问题：
   *   · 「周边公园休闲」里混进了「正宗龙岩花生」（一家店），
   *     它不是公园也不是休闲设施，展示出来会让经纪人困惑
   *   · 「周边医疗」里同一条目重复出现（贝壳数据本身重复）
   *
   * 处理原则：**宁可少展示，也不要展示明显错误的分类**。
   * 医院列表里出现一家花生店，会让人怀疑整个数据的可信度。
   */
  private isPlausibleFacility(facility: NearbyFacility, sourceKey: string): boolean {
    const name = facility.name;
    const category = facility.category;

    // 公园/休闲类：必须能识别出设施品类，否则大概率是误入的商铺
    if (sourceKey.includes('公园') || sourceKey.includes('休闲')) {
      const allowed = [
        '体育场馆', '电影院', '剧院', '公园', '风景区',
      ];
      return category !== null && allowed.includes(category);
    }

    // 教育类：必须能识别出学校品类
    if (sourceKey.includes('教育')) {
      const allowed = ['幼儿园', '小学', '中学', '大学', '学校'];
      return category !== null && allowed.includes(category);
    }

    // 医疗类：药店/诊所也算，但必须是这几类
    if (sourceKey.includes('医疗')) {
      const allowed = ['综合医院', '专科医院', '社区卫生服务中心', '诊所', '药店'];
      return category !== null && allowed.includes(category);
    }

    void name;
    return true;
  }

  /**
   * 解析一条周边配套文本。
   *
   * 形如：
   *   「距离杏滨地铁站1437米」
   *   「距离厦门市曾营小学小学430米」
   *   「距离厦门大学附属第一医院(杏林分院)综合医院946米」
   *
   * 拆解策略：
   *   距离 = 结尾的「(\d+)米」
   *   名称 + 品类 = 中间部分。贝壳把**品类紧跟在名称后**（无分隔符），
   *   因此从结尾往前匹配已知品类词，剩下的就是名称。
   */
  private parseFacility(text: string): NearbyFacility | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;

    // 距离：结尾的「1234米」
    const distanceMatch = /(\d+)\s*米\s*$/.exec(trimmed);
    const distanceMeters = distanceMatch?.[1] ? Number(distanceMatch[1]) : null;

    // 去掉开头的「距离」与结尾的距离
    let body = trimmed.replace(/^距离/, '');
    if (distanceMatch) body = body.slice(0, body.length - distanceMatch[0].length).trim();

    if (body.length === 0) return null;

    /**
     * 品类词表 —— 按长度降序匹配，避免"医院"先于"综合医院"命中。
     *
     * 为什么需要品类：经纪人想知道"这是地铁还是公交""这是小学还是中学"，
     * 只有名称（"厦门市曾营小学"）不利于快速判断。
     */
    const CATEGORIES = [
      '综合医院', '专科医院', '社区卫生服务中心', '诊所', '药店',
      '地铁站', '公交车站',
      '幼儿园', '小学', '中学', '大学', '学校',
      '体育场馆', '电影院', '剧院', '公园', '风景区', '商场', '超市', '购物中心',
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

    return {
      name: name.length > 0 ? name : body,
      distanceMeters,
      category,
    };
  }

  /** 解析图片块 */
  private parseImages(value: unknown): PropertyImage[] {
    const images: PropertyImage[] = [];

    const push = (url: unknown, roomName: string | null, kind: PropertyImage['kind']): void => {
      const text = String(url ?? '').trim();
      if (text.length === 0 || !text.startsWith('http')) return;
      images.push({ url: text, roomName, kind });
    };

    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      const record = node as Record<string, unknown>;

      if (Array.isArray(record['房间图片'])) {
        for (const item of record['房间图片']) {
          if (!item || typeof item !== 'object') continue;
          const entry = item as Record<string, unknown>;
          push(entry['图片地址'], entry['房间名称'] ? String(entry['房间名称']) : null, 'ROOM');
        }
      }

      if (record['户型图片']) push(record['户型图片'], null, 'FLOOR_PLAN');

      if (record['VR'] && typeof record['VR'] === 'object') {
        const vr = record['VR'] as Record<string, unknown>;
        if (vr['封面图']) push(vr['封面图'], null, 'VR');
      }

      for (const child of Object.values(record)) {
        if (child && typeof child === 'object') walk(child);
      }
    };

    walk(value);
    return images;
  }

  /** 按 URL 去重（保留首次出现的房间名） */
  private dedupeImages(images: PropertyImage[]): PropertyImage[] {    const seen = new Set<string>();
    const result: PropertyImage[] = [];

    for (const image of images) {
      // 去掉 URL 上的尺寸参数后再判重 —— 同一张图可能有多种尺寸变体
      const key = image.url.split('?')[0] ?? image.url;
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(image);
    }

    return result;
  }

  /** 清洗"暂无""未知"这类占位文本 */
  private cleanPlaceholder(value: string | null): string | null {
    if (!value) return null;
    if (/暂无|未知|无数据|--/.test(value)) return null;
    return value;
  }

  /**
   * 周边配套去重。
   *
   * 实测：贝壳「周边医疗」里同一条目会重复出现
   * （如「辅太医鼻咽馆(文达路店) 142米」出现两次）。
   * 保留距离最近的一条即可。
   */
  private dedupeFacilities(list: NearbyFacility[]): NearbyFacility[] {
    const seen = new Map<string, NearbyFacility>();

    for (const facility of list) {
      const key = `${facility.name}|${facility.category ?? ''}`;
      const existing = seen.get(key);

      // 已有则保留距离更近的（更近的更有参考价值）
      if (!existing) {
        seen.set(key, facility);
      } else if (
        facility.distanceMeters !== null &&
        (existing.distanceMeters === null || facility.distanceMeters < existing.distanceMeters)
      ) {
        seen.set(key, facility);
      }
    }

    return [...seen.values()];
  }
}
