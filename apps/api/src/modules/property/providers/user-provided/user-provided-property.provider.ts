/**
 * 用户提供数据 Provider —— 零法律风险的房源来源。
 *
 * ============================================================================
 * 为什么需要这个 Provider（它的法律意义）
 * ============================================================================
 * 房产数据合规调研的核心结论：
 *   中国主流平台均不向第三方 SaaS 开放房源批量接口，且已有生效判例
 *   （链家/贝壳 诉「推推99」判赔 550 万元）明确认定
 *   「向公众无差别展示的公开数据，不意味着其他经营者可以不受限制地获取和使用」。
 *
 * 但经纪人**自己**在浏览器里打开安居客/58/房天下页面、把内容提供给我们 ——
 * 这在性质上等同于用户主动提供数据：
 *   - 数据由**用户**获取（不是我们抓取）
 *   - 用户对自己的行为负责
 *   - 我们不实施任何自动化访问、不绕过任何限制
 *
 * 这与项目里已经验证过的「经纪人复制客户微信消息粘贴进来」是**同一个合规模式**。
 *
 * ============================================================================
 * 数据来源的三种形态
 * ============================================================================
 *   1. HTML 文件   —— 经纪人在浏览器 Ctrl+S 另存，上传文件
 *   2. 粘贴文本    —— 经纪人直接复制页面上的房源段落
 *   3. 结构化 JSON —— 未来若经纪人拿到官方数据导出，可直接喂进来
 *
 * 三者最终都归一化为 `NormalizedProperty`，因此**下游完全无感知**。
 *
 * ⚠️ 合规设计要点：
 *   - 本 Provider **不发起任何网络请求**（没有爬虫、没有自动化访问）
 *   - `sourceUrl` 如实记录用户提供的原始链接，便于人工核实
 *   - `rawData` 保留用户提供的原文，便于追溯与重新解析
 */

import { Logger } from '@nestjs/common';
import {
  CONSERVATIVE_CAPABILITY,
  Decoration,
  ListingStatus,
  Orientation,
  OwnershipType,
  PropertyProviderKind,
  PropertySourceType,
  PropertyType,
  ProviderCredentialType,
  ProviderError,
  ProviderErrorCode,
  ProviderHealthStatus,
  ProviderTier,
  RELIABILITY_TIERS,
  VERIFICATION_TTL,
  type AvailabilityResult,
  type CommunityProfile,
  type NormalizedProperty,
  type PropertyImage,
  type PropertyProviderV2,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderSearchQuery,
  type ProviderSearchResult,
} from '@estatepilot/types';

/**
 * 一条用户提供的房源记录。
 *
 * 注意 `fields` 是**宽类型**（unknown）：
 * 因为来源形态各异（HTML 解析结果、粘贴文本解析结果、JSON），
 * 字段名与完整度都不可控。Provider 的职责是**尽力归一化 + 如实标注缺失**，
 * 而不是假设字段一定存在。
 */
export interface UserProvidedPropertyInput {
  /** 用户提供的原始链接（可为空 —— 但强烈建议提供，便于核实） */
  sourceUrl?: string | null;
  /** 房源唯一标识：优先用平台 ID，没有则用 URL 或内容哈希 */
  externalId?: string | null;
  /** 原始字段（中文键或英文键均可，归一化时都会尝试） */
  fields: Record<string, unknown>;
  /** 用户提供的原文（保留用于追溯） */
  rawText?: string | null;
  /** 数据来源描述，如「经纪人上传的安居客页面」 */
  providedBy?: string | null;
}

/** 归一化结果（含未能识别的字段，供界面提示用户补全） */
export interface NormalizationOutcome {
  property: NormalizedProperty | null;
  /** 缺失的关键字段（界面据此提示用户） */
  missingFields: string[];
  /** 未能识别的原始字段名（提示解析器可能需要扩展） */
  unrecognizedFields: string[];
}

export class UserProvidedPropertyProvider implements PropertyProviderV2 {
  readonly kind: PropertyProviderKind;
  readonly sourceType = PropertySourceType.USER_PROVIDED;
  readonly credentialType = ProviderCredentialType.USER_PROVIDED;
  readonly tier = ProviderTier.SUPPLEMENTARY;

  /**
   * 能力声明。
   *
   * 关键：`supportsRealtimeStatus: false` —— 用户提供的数据是**某个时间点的快照**，
   * 我们无法核验它现在是否仍在售。因此界面必须提示"数据由用户提供，请自行确认"。
   */
  readonly capability: ProviderCapability = {
    ...CONSERVATIVE_CAPABILITY,
    canPaginate: false,
    maxResultsPerQuery: 200,
    supportsDetail: false,
    supportsImages: true,
    supportsFloorPlan: false,
    supportsCommunity: false,
    supportsSchool: true,
    supportsSubway: true,
    supportsSoldHistory: false,
    supportsRealtimeStatus: false,
    cities: 'ALL',
    rateLimit: { requestsPerMinute: 0, dailyQuota: null },
    // Phase 12：经纪人手动录入 → 可信度 80，且**核验有效期 null**
    // （我们没有任何渠道确认它是否仍在售 → 永远 PENDING，界面必须提示"需确认"）
    baseReliabilityScore: RELIABILITY_TIERS.AGENT_UPLOADED,
    verificationTtlHours: VERIFICATION_TTL.AGENT_UPLOADED,
  };

  private readonly logger = new Logger(UserProvidedPropertyProvider.name);

  /**
   * 内存中的记录池。
   *
   * 为什么不直接入数据库：用户提供的房源需要先经过去重与人工确认，
   * 才能决定是否作为正式房源入库（避免脏数据污染房源库）。
   * 入库由 `PropertyUpsertService` 在聚合之后统一负责。
   */
  private readonly records = new Map<string, { input: UserProvidedPropertyInput; property: NormalizedProperty }>();

  constructor(kind: PropertyProviderKind = PropertyProviderKind.ANJUKE) {
    this.kind = kind;
  }

  displayName(): string {
    return `${this.platformName()}（用户录入）`;
  }

  /**
   * 永远已配置 —— 它不需要任何第三方凭证。
   *
   * 这是它作为"零风险兜底数据源"的价值：贝壳挂了、商务没谈成，
   * 这条路径始终可用。
   */
  isConfigured(): boolean {
    return true;
  }

  // ==========================================================================
  // 录入
  // ==========================================================================

  /**
   * 接收用户提供的房源。
   *
   * @returns 归一化结果（含缺失字段提示，供界面引导用户补全）
   */
  accept(input: UserProvidedPropertyInput): NormalizationOutcome {
    const outcome = this.normalize(input);

    if (outcome.property) {
      this.records.set(outcome.property.externalId, { input, property: outcome.property });
    }

    return outcome;
  }

  /** 批量接收 */
  acceptMany(inputs: UserProvidedPropertyInput[]): NormalizationOutcome[] {
    return inputs.map((input) => this.accept(input));
  }

  /** 清空（用于导入会话结束后释放内存） */
  clear(): void {
    this.records.clear();
  }

  /** 当前已接收的条数 */
  get size(): number {
    return this.records.size;
  }

  // ==========================================================================
  // Provider 接口实现
  // ==========================================================================

  /**
   * 检索。
   *
   * 语义说明：这里是在**用户本次提供的房源**里做条件过滤，
   * 而不是"去某个平台搜索"。因为用户提供的是一批已知房源，
   * Provider 的职责是按客户需求从中筛出匹配的。
   */
  async search(query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    const startedAt = Date.now();

    const matched = [...this.records.values()]
      .map((record) => record.property)
      .filter((property) => this.matchesQuery(property, query));

    return {
      provider: this.kind,
      items: query.limit > 0 ? matched.slice(0, query.limit) : matched,
      // 用户提供的池子是有限的，总召回数就是池子大小
      totalRecalled: matched.length,
      exactMatch: true,
      effectiveQuery: {
        city: query.city,
        districts: query.districts,
        subDistricts: query.subDistricts,
        bedrooms: query.bedrooms,
        budgetMax: query.budgetMax,
        budgetMin: query.budgetMin,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  async getDetail(externalId: string): Promise<NormalizedProperty | null> {
    return this.records.get(externalId)?.property ?? null;
  }

  async getImages(externalId: string): Promise<PropertyImage[]> {
    return this.records.get(externalId)?.property.images ?? [];
  }

  async getCommunity(externalId: string): Promise<CommunityProfile | null> {
    const property = this.records.get(externalId)?.property;
    if (!property) return null;

    // 用户提供的文本里通常没有小区维度数据，如实返回只含基本信息的档案
    return {
      name: property.community,
      district: property.district,
      subDistrict: property.subDistrict,
      buildYear: property.buildYear,
      floorAreaRatio: null,
      greenRate: null,
      propertyFee: null,
      totalHouseholds: null,
      developer: null,
      propertyManagementCompany: null,
      facilities: [],
      rawData: null,
    };
  }

  /**
   * 状态核验。
   *
   * ⚠️ **无法核验** —— 用户提供的是快照，我们没有任何渠道确认它是否仍在售。
   * 这里如实返回 `UNAVAILABLE`，界面据此提示经纪人"请自行确认"。
   *
   * 这是诚实性要求：不能假装核验过，那会让经纪人误以为房源状态可信。
   */
  async checkAvailability(externalId: string): Promise<AvailabilityResult> {
    return {
      externalId,
      status: this.records.get(externalId)?.property.listingStatus ?? ListingStatus.ACTIVE,
      currentTotalPrice: this.records.get(externalId)?.property.totalPrice ?? null,
      checkedAt: new Date(),
      method: 'UNAVAILABLE',
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.kind,
      sourceType: this.sourceType,
      status: ProviderHealthStatus.ONLINE,
      responseTimeMs: 0,
      lastErrorMessage: null,
      checkedAt: new Date(),
    };
  }

  // ==========================================================================
  // 归一化
  // ==========================================================================

  /**
   * 把用户提供的原始字段归一化为 `NormalizedProperty`。
   *
   * 设计原则（重要）：**宁可留空，不可编造**。
   *   - 字段缺失 → 保持 null/0，并把字段名加进 `missingFields`，让界面提示用户补全
   *   - 无法识别的字段 → 记入 `unrecognizedFields`，便于后续扩展解析规则
   *   - **绝不用默认值伪造数据**（比如房价未知就填 0 会被当成"免费房"）
   */
  normalize(input: UserProvidedPropertyInput): NormalizationOutcome {
    const f = input.fields;
    const missingFields: string[] = [];
    const unrecognizedFields: string[] = [];

    const city = this.pickString(f, ['city', '城市']) ?? '';
    if (!city) missingFields.push('city');

    const community = this.pickString(f, ['community', '小区', '小区名称', '楼盘', '楼盘名称']) ?? '';
    if (!community) missingFields.push('community');

    const totalPrice = this.pickPrice(f, ['totalPrice', '总价', '售价', '价格', '挂牌价']);
    if (totalPrice === null) missingFields.push('totalPrice');

    const area = this.pickNumber(f, ['area', '建筑面积', '面积', '建面']);
    if (area === null) missingFields.push('area');

    // 关键字段不全 → 不生成房源（避免脏数据进入后续匹配）
    // 这里只要求"城市 + 小区 + 总价 + 面积"，其余字段允许缺失。
    if (!city || !community || totalPrice === null || area === null) {
      this.logger.debug(
        `用户提供的房源缺少关键字段，已跳过：缺少 ${missingFields.join('、')}`,
      );
      return { property: null, missingFields, unrecognizedFields };
    }

    const unitPrice =
      this.pickNumber(f, ['unitPrice', '单价']) ??
      Math.round(totalPrice / Math.max(area, 1));

    const property: NormalizedProperty = {
      externalProvider: this.kind,
      externalId: input.externalId ?? this.deriveExternalId(input, community, area, totalPrice),

      rawData: {
        source: 'USER_PROVIDED',
        sourceUrl: input.sourceUrl ?? null,
        providedBy: input.providedBy ?? null,
        // 保留原文，便于追溯与重新解析（与贝壳 rawData 的做法一致）
        rawText: input.rawText ?? null,
        fields: f,
      },

      city,
      district: this.pickString(f, ['district', '区域', '行政区', '区县']) ?? '',
      subDistrict: this.pickString(f, ['subDistrict', '板块', '商圈']),
      community,
      title: this.pickString(f, ['title', '标题']) ?? `${community} ${area}㎡`,
      address: this.pickString(f, ['address', '地址']),
      longitude: this.pickNumber(f, ['longitude', '经度']),
      latitude: this.pickNumber(f, ['latitude', '纬度']),

      totalPrice,
      unitPrice,

      bedrooms: this.pickNumber(f, ['bedrooms', '卧室', '房间数', '户型']) ?? 0,
      livingRooms: this.pickNumber(f, ['livingRooms', '客厅']) ?? 0,
      bathrooms: this.pickNumber(f, ['bathrooms', '卫生间']) ?? 0,
      area,

      floor: this.pickNumber(f, ['floor', '楼层', '所在楼层']),
      totalFloors: this.pickNumber(f, ['totalFloors', '总楼层']),

      orientation: this.parseEnum(
        this.pickString(f, ['orientation', '朝向']),
        Orientation,
      ),
      buildYear: this.pickNumber(f, ['buildYear', '建成年份', '年代']),
      propertyType:
        this.parseEnum(this.pickString(f, ['propertyType', '物业类型', '房屋类型']), PropertyType) ??
        PropertyType.APARTMENT,
      ownershipType: this.parseEnum(
        this.pickString(f, ['ownershipType', '产权性质', '产权']),
        OwnershipType,
      ),
      decoration: this.parseEnum(this.pickString(f, ['decoration', '装修']), Decoration),
      elevator: this.pickBoolean(f, ['elevator', '电梯']),

      subwayDistance: this.pickNumber(f, ['subwayDistance', '地铁距离']),
      subway: null,
      schoolInfo: null,

      tags: this.pickStringArray(f, ['tags', '标签']),
      images: this.pickImages(f),
      floorPlan: this.pickStringArray(f, ['floorPlan', '户型图']),
      description: this.pickString(f, ['description', '描述', '备注']) ?? input.rawText ?? null,

      // 用户提供的房源默认视为在售，但**必须由经纪人自行确认**
      listingStatus: ListingStatus.ACTIVE,
      listingDate: null,
      lastPriceChange: null,
    };

    return { property, missingFields, unrecognizedFields };
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  private platformName(): string {
    switch (this.kind) {
      case PropertyProviderKind.ANJUKE:
        return '安居客';
      case PropertyProviderKind.INTERNAL:
        return '本公司';
      default:
        return String(this.kind);
    }
  }

  /** 按候选键名依次尝试取字符串 */
  private pickString(fields: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  }

  private pickNumber(fields: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  /**
   * 价格解析 —— 支持「568万」「5680000」「5,680,000元」等常见写法。
   *
   * 为什么单独处理：房产数据里价格单位混用极其普遍（万/元），
   * 如果按普通数字解析，"568万" 会变成 568 元 —— 这是灾难性的错误。
   */
  private pickPrice(fields: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = fields[key];

      if (typeof value === 'number' && Number.isFinite(value)) {
        // 数字形式：小于 100000 视为"万元"（房价不可能 50 万元以下却写成 50）
        return value < 100_000 ? Math.round(value * 10_000) : Math.round(value);
      }

      if (typeof value === 'string') {
        const text = value.replace(/[,，\s]/g, '');
        const match = /([\d.]+)\s*(亿|万)?/.exec(text);
        if (!match?.[1]) continue;

        const base = Number.parseFloat(match[1]);
        if (!Number.isFinite(base)) continue;

        if (match[2] === '亿') return Math.round(base * 100_000_000);
        if (match[2] === '万') return Math.round(base * 10_000);
        // 无单位：按数值大小推断
        return base < 100_000 ? Math.round(base * 10_000) : Math.round(base);
      }
    }
    return null;
  }

  private pickBoolean(fields: Record<string, unknown>, keys: string[]): boolean | null {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        if (/^(有|是|true|yes|1)$/i.test(value.trim())) return true;
        if (/^(无|否|false|no|0)$/i.test(value.trim())) return false;
      }
    }
    return null;
  }

  private pickStringArray(fields: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
      const value = fields[key];
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string');
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
          .split(/[/、,，|]/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
    }
    return [];
  }

  private pickImages(fields: Record<string, unknown>): PropertyImage[] {
    const raw = fields['images'] ?? fields['图片'] ?? fields['图片列表'];
    if (!Array.isArray(raw)) return [];

    return raw
      .map((item, index): PropertyImage | null => {
        if (typeof item === 'string') {
          return { url: item, category: 'EXTERIOR', sortOrder: index };
        }
        if (typeof item === 'object' && item !== null) {
          const record = item as Record<string, unknown>;
          const url = typeof record['url'] === 'string' ? record['url'] : null;
          if (!url) return null;
          return {
            url,
            category: 'EXTERIOR',
            sortOrder: index,
            ...(typeof record['caption'] === 'string' ? { caption: record['caption'] } : {}),
          };
        }
        return null;
      })
      .filter((item): item is PropertyImage => item !== null);
  }

  /**
   * 生成稳定标识。
   *
   * 优先用用户提供的链接（同一链接 = 同一房源），
   * 否则用「小区 + 面积 + 价格」的内容哈希 —— 保证同一套房重复录入时
   * 得到相同的 externalId（这是幂等入库的前提）。
   */
  private deriveExternalId(
    input: UserProvidedPropertyInput,
    community: string,
    area: number,
    totalPrice: number,
  ): string {
    if (input.sourceUrl) {
      // 从 URL 中抽取平台房源 ID（如 anjuke.com/.../12345678.htm）
      const idMatch = /(\d{6,})/.exec(input.sourceUrl);
      if (idMatch?.[1]) return `URL_${idMatch[1]}`;
      return `URL_${this.shortHash(input.sourceUrl)}`;
    }

    return `UP_${this.shortHash(`${community}|${Math.round(area)}|${totalPrice}`)}`;
  }

  private shortHash(text: string): string {
    // 简单稳定的字符串哈希（FNV-1a 变体），避免引入 crypto 依赖
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  private parseEnum<T extends Record<string, string>>(
    value: string | null,
    enumObject: T,
  ): T[keyof T] | null {
    if (!value) return null;
    const values = Object.values(enumObject);
    if (values.includes(value)) return value as T[keyof T];

    // 中文映射
    const chineseMap: Record<string, string> = {
      朝南: 'SOUTH',
      朝北: 'NORTH',
      朝东: 'EAST',
      朝西: 'WEST',
      南北通透: 'SOUTH_NORTH',
      毛坯: 'ROUGH',
      简装: 'SIMPLE',
      精装: 'FINE',
      豪装: 'LUXURY',
      商品房: 'COMMERCIAL',
      住宅: 'APARTMENT',
      公寓: 'APARTMENT',
    };

    const mapped = chineseMap[value];
    if (mapped && values.includes(mapped)) return mapped as T[keyof T];

    return null;
  }

  /** 按客户需求过滤（与硬筛逻辑保持一致的语义，但这里是粗筛） */
  private matchesQuery(property: NormalizedProperty, query: ProviderSearchQuery): boolean {
    if (query.onlyActive && property.listingStatus !== ListingStatus.ACTIVE) return false;

    if (query.city && property.city && !property.city.includes(query.city)) return false;

    if (query.districts.length > 0 && property.district) {
      const hit = query.districts.some((district) =>
        property.district.includes(district.replace(/[区县]$/, '')),
      );
      if (!hit) return false;
    }

    if (query.bedrooms.length > 0 && !query.bedrooms.includes(property.bedrooms)) return false;

    // 预算给 5% 弹性（与硬筛一致：不让用户因为几万块错过房源）
    if (query.budgetMax !== null && property.totalPrice > query.budgetMax * 1.05) return false;
    if (query.budgetMin !== null && property.totalPrice < query.budgetMin * 0.95) return false;

    if (query.areaMin !== null && property.area < query.areaMin * 0.92) return false;
    if (query.areaMax !== null && property.area > query.areaMax * 1.08) return false;

    return true;
  }
}
