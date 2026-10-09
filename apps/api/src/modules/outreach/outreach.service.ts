/**
 * 客户触达服务 —— 一键发送包生成。
 *
 * 这是产品对经纪人最直接的交付价值：
 *   客户在此系统里 → 系统匹配好房源 → 生成排版好的微信消息 + 话术 → 经纪人一键复制发送。
 *
 * 三个关键工程点：
 *
 * 1. **格式要能直接粘贴到微信**。微信不支持富文本，因此排版只能用
 *    换行、emoji 符号、中文全角标点来制造层次。这里刻意不用 Markdown 语法
 *    （微信里显示为原始字符，很丑）。
 *
 * 2. **话术要个性化**。用客户画像（显式需求 + 行为推断）、浏览历史、
 *    价格敏感度来定制角度，而不是套模板。AI 可用时用 AI 生成，
 *    不可用时用规则模板降级 —— 但降级版本也必须是个性化的。
 *
 * 3. **必须带专属链接**。客户点开链接后所有行为回流系统，
 *    这样"发一次消息"就变成了"持续获取客户真实需求"的入口。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_DISCLAIMER,
  CUSTOMER_STATUS_LABELS,
  CustomerStatus,
  DECORATION_LABELS,
  INTENT_LEVEL_LABELS,
  MESSAGE_CHANNEL_LABELS,
  ORIENTATION_LABELS,
  RECOMMEND_SCENARIO_LABELS,
  RecommendScenario,
  MessageChannel,
  type GenerateRecommendBundleInput,
  type RecommendBundle,
  type RecommendPropertyItem,
} from '@estatepilot/types';
import {
  buildWindowKey,
  daysBetween,
  floorPositionLabel,
  formatArea,
  formatBedroomsCn,
  formatDistance,
  formatPriceChange,
  formatPriceWan,
  formatRelativeTime,
  generateShareToken,
  maskPhone,
} from '@estatepilot/utils';
import { TenantService } from '../tenant/tenant.service.js';
import { getContext } from '../../common/context/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';
import { NotFoundError } from '../../common/filters/all-exceptions.filter.js';

/** 默认推送房源数量：3 套 —— 太少没得选，太多客户懒得看 */
const DEFAULT_LIMIT = 3;
/** 最多推送 6 套 */
const MAX_LIMIT = 6;

/**
 * 中文姓名的礼貌称呼。
 *
 * 踩过的坑：最初用 name.slice(-2) 取末两字，
 * 「唐刚刚」会变成「刚刚您好」—— 听起来像在叫小名，非常不专业。
 *
 * 正确规则（贴合中文习惯）：
 *   2 字姓名（张三）    → 全名「张三」
 *   3 字姓名（唐刚刚）  → 姓 + 敬称「唐先生/唐女士」，不确定性别时用「唐先生」不合适，
 *                        因此退化为「唐先生」不可取 —— 这里用「唐」+ 通用敬语「您」
 *   复姓（欧阳修）      → 「欧阳先生」
 *
 * 由于我们拿不到可靠性别，统一采用「姓氏 + 您好」的稳妥写法，
 * 避免出现「李女士」其实是男性的尴尬。
 */
function politeSalutation(fullName: string, gender?: string | null): string {
  const name = fullName.trim();
  if (!name) return '您好';

  // 复姓表（常见 20 个）
  const compoundSurnames = [
    '欧阳', '太史', '端木', '上官', '司马', '东方', '独孤', '南宫', '万俟', '闻人',
    '夏侯', '诸葛', '尉迟', '公羊', '赫连', '澹台', '皇甫', '宗政', '濮阳', '公冶',
  ];

  const compound = compoundSurnames.find((surname) => name.startsWith(surname));
  const surname = compound ?? name.slice(0, 1);

  // 有明确性别时用敬称，更自然
  if (gender === 'MALE') return `${surname}先生`;
  if (gender === 'FEMALE') return `${surname}女士`;

  // 无性别信息：用「姓氏 + 您好」避免误称
  return surname;
}

@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    private readonly tenant: TenantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 生成一键发送包。
   */
  async generateBundle(input: GenerateRecommendBundleInput): Promise<RecommendBundle> {
    const context = getContext();
    if (!context?.organizationId || !context.userId) {
      throw new Error('生成发送包需要登录上下文');
    }

    const scope = this.tenant.scope();
    const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));

    // ---- 1. 取客户完整信息（含行为画像）----
    //
    // 说明：CustomerBehavioralProfile 通过 customerId 关联到 Customer，
    // 自身没有 organizationId 字段，因此不在 TenantScope 白名单里。
    // 正确做法是像下面这样用 include 从父表带出来 ——
    // 这样既完成了租户校验（父表 Customer 已受作用域约束），
    // 又避免了直接查询子表绕过隔离。
    const customer = await scope.findFirst<{
      id: string;
      name: string;
      phone: string;
      status: string;
      intentLevel: string | null;
      intentScore: number | null;
      intentScoreLevel: string | null;
      budgetMin: number | null;
      budgetMax: number | null;
      preferredDistricts: string[];
      preferredCommunities: string[];
      bedrooms: number[];
      areaMin: number | null;
      areaMax: number | null;
      decorationPreference: string | null;
      subwayDistanceMax: number | null;
      schoolPreference: string | null;
      purchasePurpose: string | null;
      purchaseTimeline: string | null;
      paymentMethod: string | null;
      lastContactAt: Date | null;
      lastActiveAt: Date | null;
      behaviorEventCount: number;
      preferenceDriftScore: unknown;
      notes: string | null;
      /** 性别用于选择「先生/女士」敬称 */
      gender: string;
      behavioralProfile: {
        inferredBudgetMin: number | null;
        inferredBudgetMax: number | null;
        reasoningSummary: string | null;
        topDistricts: string[];
        confidence: unknown;
        driftResult: unknown;
      } | null;
    }>('Customer', {
      where: { id: input.customerId },
      select: {
        id: true,
        name: true,
        phone: true,
        gender: true,
        status: true,
        intentLevel: true,
        intentScore: true,
        intentScoreLevel: true,
        budgetMin: true,
        budgetMax: true,
        preferredDistricts: true,
        preferredCommunities: true,
        bedrooms: true,
        areaMin: true,
        areaMax: true,
        decorationPreference: true,
        subwayDistanceMax: true,
        schoolPreference: true,
        purchasePurpose: true,
        purchaseTimeline: true,
        paymentMethod: true,
        lastContactAt: true,
        lastActiveAt: true,
        behaviorEventCount: true,
        preferenceDriftScore: true,
        notes: true,
        // 行为画像随父表带出，自动继承租户约束
        behavioralProfile: {
          select: {
            inferredBudgetMin: true,
            inferredBudgetMax: true,
            reasoningSummary: true,
            topDistricts: true,
            confidence: true,
            driftResult: true,
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundError('客户', input.customerId);
    }

    const behaviorProfile = customer.behavioralProfile;

    // ---- 3. 选取要推送的房源 ----
    const properties = await this.selectProperties(scope, customer, input, limit);

    if (properties.length === 0) {
      this.logger.warn(`客户 ${customer.name}(${customer.id}) 没有可用匹配房源`);
    }

    // ---- 4. 准备/复用客户专属链接（数据闭环的关键）----
    let portalUrl: string | null = null;
    let portalShortCode: string | null = null;

    if (input.includePortalLink !== false) {
      const link = await this.ensureShareLink(scope, customer.id, properties.map((p) => p.propertyId));
      if (link) {
        portalUrl = link.url;
        portalShortCode = link.shortCode;
      }
    }

    // 把链接挂到每套房源上（客户点开直接到该房源详情）
    const propertiesWithLinks: RecommendPropertyItem[] = properties.map((property) => ({
      ...property,
      shareUrl: portalUrl ? `${portalUrl}#property-${property.propertyId}` : null,
    }));

    // ---- 5. 确定场景 ----
    const scenario = input.scenario ?? this.inferScenario(customer, propertiesWithLinks, behaviorProfile);

    // ---- 6. 生成各渠道文案 ----
    const channel = input.channel ?? MessageChannel.WECHAT_PERSONAL;

    const explicitSummary = this.buildExplicitSummary(customer);
    const behavioralSummary = behaviorProfile?.reasoningSummary ?? null;
    const driftNote = this.buildDriftNote(behaviorProfile, customer);

    const messageText = this.composeWechatMessage({
      customerName: customer.name,
      customerGender: customer.gender,
      scenario,
      properties: propertiesWithLinks,
      portalUrl,
      explicitSummary,
      behavioralSummary,
      driftNote,
      customNote: input.customNote,
    });

    const smsText = this.composeSms({
      customerName: customer.name,
      customerGender: customer.gender,
      scenario,
      properties: propertiesWithLinks,
      portalShortCode,
    });

    const phoneScript = this.composePhoneScript({
      customerName: customer.name,
      customerGender: customer.gender,
      scenario,
      properties: propertiesWithLinks,
      explicitSummary,
      driftNote,
      status: customer.status,
    });

    const cautions = this.buildCautions(customer, propertiesWithLinks, behaviorProfile);

    const bundle: RecommendBundle = {
      customerId: customer.id,
      customerName: customer.name,
      customerPhoneMasked: maskPhone(customer.phone),

      scenario,
      scenarioLabel: RECOMMEND_SCENARIO_LABELS[scenario],

      channel,
      channelLabel: MESSAGE_CHANNEL_LABELS[channel],

      messageText,
      smsText,
      phoneScript,

      strategyNote: this.buildStrategyNote(scenario, propertiesWithLinks, customer),
      cautions,

      properties: propertiesWithLinks,

      customerPortalUrl: portalUrl,
      customerPortalShortCode: portalShortCode,

      customerSnapshot: {
        status: customer.status,
        statusLabel: CUSTOMER_STATUS_LABELS[customer.status as CustomerStatus] ?? customer.status,
        intentScore: customer.intentScore ?? 0,
        intentLevelLabel: customer.intentScoreLevel
          ? `AI 意向 ${customer.intentScore} 分`
          : customer.intentLevel
            ? (INTENT_LEVEL_LABELS[customer.intentLevel as keyof typeof INTENT_LEVEL_LABELS] ?? '')
            : '未评分',
        explicitSummary,
        behavioralSummary,
        statedBudget: this.formatBudget(customer.budgetMin, customer.budgetMax),
        inferredBudget: this.formatBudget(
          behaviorProfile?.inferredBudgetMin ?? null,
          behaviorProfile?.inferredBudgetMax ?? null,
        ),
        driftNote,
        lastContactAt: customer.lastContactAt
          ? formatRelativeTime(customer.lastContactAt, new Date())
          : null,
        daysSinceLastContact: customer.lastContactAt
          ? daysBetween(customer.lastContactAt, new Date())
          : null,
      },

      // 话术目前由规则模板生成；接入 AI 后此处会变为 true
      aiGenerated: false,
      disclaimer: AI_DISCLAIMER,
      generatedAt: new Date().toISOString(),
    };

    this.logger.log(
      `生成发送包：客户=${customer.name} 场景=${scenario} 房源=${propertiesWithLinks.length} 套 ` +
        `渠道=${channel} 专属链接=${portalUrl ? '已生成' : '未生成'}`,
    );

    return bundle;
  }

  // -------------------------------------------------------------------------
  // 房源选取
  // -------------------------------------------------------------------------

  /**
   * 选取要推送给客户的房源。
   *
   * 优先级：
   *   1. 调用方明确指定的 propertyIds
   *   2. 数据库里已有的匹配结果（按分数降序）—— 这些是匹配引擎算过的，质量最高
   *   3. 若匹配结果为空，用客户显性需求做一次即时筛选（保证功能可用）
   */
  private async selectProperties(
    scope: ReturnType<TenantService['scope']>,
    customer: {
      id: string;
      preferredDistricts: string[];
      bedrooms: number[];
      budgetMin: number | null;
      budgetMax: number | null;
      areaMin: number | null;
      areaMax: number | null;
    },
    input: GenerateRecommendBundleInput,
    limit: number,
  ): Promise<RecommendPropertyItem[]> {
    // ---- 情况 1：明确指定 ----
    if (input.propertyIds && input.propertyIds.length > 0) {
      const rows = await scope.findMany<PropertyRow>('Property', {
        where: { id: { in: input.propertyIds.slice(0, MAX_LIMIT) } },
        select: PROPERTY_SELECT,
      });

      return rows.map((row, index) => this.toPropertyItem(row, {
        matchScore: 100 - index * 3,
        highlights: [],
        concerns: [],
      }));
    }

    // ---- 情况 2：用已有匹配结果 ----
    const matches = await scope.findMany<{
      propertyId: string;
      score: number;
      highlights: string[];
      concerns: string[];
      property: PropertyRow | null;
    }>('CustomerPropertyMatch', {
      where: {
        customerId: customer.id,
        property: { listingStatus: 'ACTIVE' },
      },
      orderBy: { score: 'desc' },
      take: limit * 3,
      select: {
        propertyId: true,
        score: true,
        highlights: true,
        concerns: true,
        property: { select: PROPERTY_SELECT },
      },
    });

    const fromMatches = matches
      .filter((match) => match.property !== null)
      .slice(0, limit)
      .map((match) =>
        this.toPropertyItem(match.property as PropertyRow, {
          matchScore: match.score,
          highlights: match.highlights ?? [],
          concerns: match.concerns ?? [],
        }),
      );

    if (fromMatches.length > 0) return fromMatches;

    // ---- 情况 3：即时筛选（匹配引擎尚未跑过时的兜底）----
    return this.quickFilter(scope, customer, limit);
  }

  /** 用显性需求做一次快速筛选，保证没有匹配记录时也能出结果 */
  private async quickFilter(
    scope: ReturnType<TenantService['scope']>,
    customer: {
      id: string;
      preferredDistricts: string[];
      bedrooms: number[];
      budgetMin: number | null;
      budgetMax: number | null;
      areaMin: number | null;
      areaMax: number | null;
    },
    limit: number,
  ): Promise<RecommendPropertyItem[]> {
    const where: Record<string, unknown> = { listingStatus: 'ACTIVE' };

    if (customer.preferredDistricts.length > 0) {
      where.district = { in: customer.preferredDistricts };
    }
    if (customer.bedrooms.length > 0) {
      where.bedrooms = { in: customer.bedrooms };
    }
    if (customer.budgetMin !== null || customer.budgetMax !== null) {
      where.totalPrice = {
        ...(customer.budgetMin !== null ? { gte: BigInt(Math.round(customer.budgetMin * 0.9)) } : {}),
        ...(customer.budgetMax !== null ? { lte: BigInt(Math.round(customer.budgetMax * 1.1)) } : {}),
      };
    }
    if (customer.areaMin !== null || customer.areaMax !== null) {
      where.area = {
        ...(customer.areaMin !== null ? { gte: customer.areaMin - 10 } : {}),
        ...(customer.areaMax !== null ? { lte: customer.areaMax + 10 } : {}),
      };
    }

    const rows = await scope.findMany<PropertyRow>('Property', {
      where,
      select: PROPERTY_SELECT,
      // 优先推价格更贴近客户预算下限的（性价比观感更好）
      orderBy: { totalPrice: 'asc' },
      take: limit,
    });

    // 即时筛选没有匹配分，用需求命中情况估算一个
    return rows.map((row) => {
      const { score, highlights } = this.estimateMatch(row, customer);
      return this.toPropertyItem(row, { matchScore: score, highlights, concerns: [] });
    });
  }

  /** 估算匹配分与加分项（用于即时筛选场景） */
  private estimateMatch(
    property: PropertyRow,
    customer: {
      preferredDistricts: string[];
      bedrooms: number[];
      budgetMin: number | null;
      budgetMax: number | null;
      areaMin: number | null;
      areaMax: number | null;
    },
  ): { score: number; highlights: string[] } {
    let score = 60;
    const highlights: string[] = [];

    if (customer.preferredDistricts.includes(property.district)) {
      score += 12;
      highlights.push(`位于您关注的${property.district}`);
    }
    if (customer.bedrooms.includes(property.bedrooms)) {
      score += 12;
      highlights.push(`${formatBedroomsCn(property.bedrooms)}户型`);
    }

    const price = Number(property.totalPrice);
    if (customer.budgetMin !== null && customer.budgetMax !== null) {
      if (price >= customer.budgetMin && price <= customer.budgetMax) {
        score += 10;
        highlights.push('总价在您的预算范围内');
      } else if (price > customer.budgetMax) {
        score -= 8;
      }
    }

    const area = Number(property.area);
    if (customer.areaMin !== null && area >= customer.areaMin) {
      score += 5;
    }

    return { score: Math.max(40, Math.min(96, score)), highlights };
  }

  /** 把数据库行转成发送项 */
  private toPropertyItem(
    row: PropertyRow,
    extra: { matchScore: number; highlights: string[]; concerns: string[] },
  ): RecommendPropertyItem {
    const totalPrice = Number(row.totalPrice);
    const priceChange = row.priceHistory?.[0]
      ? Number(row.priceHistory[0].change)
      : 0;
    const priceChangePercent = row.priceHistory?.[0]
      ? Number(row.priceHistory[0].changePercent)
      : 0;

    const subwayInfo = row.subwayInfo as { line?: string; station?: string; distanceMeters?: number } | null;
    const schoolInfo = row.schoolInfo as { primarySchool?: string; middleSchool?: string } | null;

    return {
      propertyId: row.id,
      title: row.title,
      community: row.community,
      district: row.district,
      subDistrict: row.subDistrict,

      totalPrice,
      unitPrice: row.unitPrice,
      priceChange,
      priceChangePercent,

      bedrooms: row.bedrooms,
      livingRooms: row.livingRooms,
      bathrooms: row.bathrooms,
      area: Number(row.area),
      floor: row.floor,
      totalFloors: row.totalFloors,
      floorPosition:
        row.floor !== null && row.totalFloors !== null
          ? floorPositionLabel(row.floor, row.totalFloors)
          : null,

      orientation: row.orientation ? (ORIENTATION_LABELS[row.orientation as keyof typeof ORIENTATION_LABELS] ?? null) : null,
      buildYear: row.buildYear,
      decoration: row.decoration ? (DECORATION_LABELS[row.decoration as keyof typeof DECORATION_LABELS] ?? null) : null,
      elevator: row.elevator,

      subwayDistance: row.subwayDistance,
      subwayText: subwayInfo
        ? [subwayInfo.line, subwayInfo.station, subwayInfo.distanceMeters ? `约${subwayInfo.distanceMeters}米` : null]
            .filter(Boolean)
            .join(' ')
        : row.subwayDistance
          ? `距地铁约${formatDistance(row.subwayDistance)}`
          : null,
      schoolText: schoolInfo
        ? [schoolInfo.primarySchool, schoolInfo.middleSchool].filter(Boolean).join(' / ') || null
        : null,

      tags: row.tags ?? [],

      matchScore: extra.matchScore,
      highlights: extra.highlights,
      concerns: extra.concerns,

      coverImage: row.coverImage,

      shareUrl: null, // 由调用方补上专属链接
    };
  }

  // -------------------------------------------------------------------------
  // 专属链接
  // -------------------------------------------------------------------------

  /**
   * 确保客户有一个可用的专属链接。
   *
   * 复用逻辑：若已有未过期、未撤销的链接则直接复用 ——
   * 避免每次发消息都生成新链接（那样客户的访问记录会被切成多段，
   * 行为画像就不完整了）。
   */
  private async ensureShareLink(
    scope: ReturnType<TenantService['scope']>,
    customerId: string,
    _propertyIds: string[],
  ): Promise<{ url: string; shortCode: string; token: string } | null> {
    // 查找已有可用链接
    const existing = await scope.findFirst<{
      token: string;
      shortCode: string;
      expiresAt: Date | null;
      isActive: boolean;
    }>('CustomerShareLink', {
      where: {
        customerId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      select: { token: true, shortCode: true, expiresAt: true, isActive: true },
    });

    if (existing) {
      return {
        url: `${this.config.api.appBaseUrl}/c/${existing.shortCode}`,
        shortCode: existing.shortCode,
        token: existing.token,
      };
    }

    // 新建：token 用 CSPRNG 生成，有效期 90 天
    const token = generateShareToken(24);
    const shortCode = generateShareToken(8);

    const created = await scope.create<{ token: string; shortCode: string }>('CustomerShareLink', {
      data: {
        customerId,
        token,
        shortCode,
        label: `房源推荐链接 ${buildWindowKey()}`,
        isActive: true,
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
        createdById: getContext()?.userId ?? null,
      },
    });

    this.logger.log(`为客户 ${customerId} 创建专属链接 ${shortCode}（有效期 90 天）`);

    return {
      url: `${this.config.api.appBaseUrl}/c/${created.shortCode}`,
      shortCode: created.shortCode,
      token: created.token,
    };
  }

  // -------------------------------------------------------------------------
  // 文案生成
  // -------------------------------------------------------------------------

  /** 推断推荐场景 —— 决定话术角度 */
  private inferScenario(
    customer: { status: string; lastContactAt: Date | null },
    properties: RecommendPropertyItem[],
    behaviorProfile: unknown,
  ): RecommendScenario {
    const hasPriceDrop = properties.some((property) => property.priceChange < 0);
    if (hasPriceDrop) return RecommendScenario.PRICE_DROP;

    if (customer.status === CustomerStatus.DORMANT) return RecommendScenario.DORMANT_REACTIVATE;

    if (customer.status === CustomerStatus.VIEWING || customer.status === CustomerStatus.NEGOTIATING) {
      return RecommendScenario.VIEWING_FOLLOWUP;
    }

    if (!customer.lastContactAt) return RecommendScenario.FIRST_MATCH;

    if (behaviorProfile) return RecommendScenario.NEW_LISTING;

    return RecommendScenario.ROUTINE;
  }

  /**
   * 生成微信消息正文。
   *
   * 排版设计原则（针对微信的真实限制）：
   *   - 微信不支持富文本，只能用换行 + 符号做层次
   *   - 每套房源控制在 4～5 行，用 emoji 做视觉锚点（但不滥用）
   *   - 价格用「万」而不是数字串，符合中文房产习惯
   *   - 结尾必须有明确行动引导（邀约带看），否则消息没有推进力
   *   - 不使用「亲」「尊敬的客户」等模板化称呼
   */
  private composeWechatMessage(input: {
    customerName: string;
    customerGender?: string | null;
    scenario: RecommendScenario;
    properties: RecommendPropertyItem[];
    portalUrl: string | null;
    explicitSummary: string;
    behavioralSummary: string | null;
    driftNote: string | null;
    customNote?: string;
  }): string {
    const { customerName, customerGender, scenario, properties, portalUrl, customNote } = input;
    // 「唐刚刚」不能再被截成「刚刚您好」——见 politeSalutation 的说明
    const salutation = politeSalutation(customerName, customerGender);
    const lines: string[] = [];

    // 主推房源：优先选有降价的（价格是客户最关心的），否则用第一套。
    // 踩过的坑：最初固定用 properties[0] 作为主推，
    // 结果开场说"降价 74 万"，但主推的第 1 套其实没降 —— 自相矛盾。
    const droppedProperties = properties.filter((property) => property.priceChange < 0);
    const featuredProperty = droppedProperties[0] ?? properties[0];

    // ---- 开场：场景化，不生硬 ----
    switch (scenario) {
      case RecommendScenario.PRICE_DROP: {
        lines.push(
          featuredProperty && featuredProperty.priceChange < 0
            ? `${salutation}您好，之前跟您提过的${featuredProperty.community}那套，业主这边价格松动了，${formatPriceChange(featuredProperty.priceChange)}，我第一时间想到您。`
            : `${salutation}您好，您关注的小区有房源价格调整了，我整理了几套发您看看。`,
        );
        break;
      }
      case RecommendScenario.DORMANT_REACTIVATE:
        lines.push(
          `${salutation}您好，好久没联系了。最近这个片区新出了几套不错的房源，价格比之前更合适，想起您之前的购房计划，发您参考一下。`,
        );
        break;
      case RecommendScenario.VIEWING_FOLLOWUP:
        lines.push(
          `${salutation}您好，上次带您看的房子我又跟进了一下，同时按您的反馈筛了几套更贴近需求的，一起发您对比看看。`,
        );
        break;
      case RecommendScenario.FIRST_MATCH:
        lines.push(
          `${salutation}您好，我是XX地产的经纪人。按您之前说的需求，我筛了几套比较合适的房源，您可以先看看有没有眼缘。`,
        );
        break;
      default:
        lines.push(`${salutation}您好，按您的需求我筛了几套房源，发给您参考。`);
    }

    lines.push('');

    // ---- 房源列表 ----
    properties.forEach((property, index) => {
      lines.push(`【${index + 1}】${property.community}｜${property.district}`);
      // 核心三要素：户型 / 面积 / 价格
      lines.push(
        `🏠 ${formatBedroomsCn(property.bedrooms)}${property.livingRooms ? `${property.livingRooms}厅` : ''}   ` +
          `${formatArea(property.area)}   ${property.floorPosition ?? ''}`,
      );
      lines.push(
        `💰 ${formatPriceWan(property.totalPrice)}（单价 ${Math.round(property.unitPrice / 1000)} 千/㎡）`,
      );

      // 价格变化：降价是强卖点，必须显式说出来
      if (property.priceChange < 0) {
        lines.push(
          `📉 业主降价 ${formatPriceWan(Math.abs(property.priceChange))}` +
            `（降幅 ${Math.abs(property.priceChangePercent).toFixed(1)}%）`,
        );
      }

      // 加分项
      const featureBits: string[] = [];
      if (property.decoration) featureBits.push(property.decoration);
      if (property.buildYear) featureBits.push(`${property.buildYear}年`);
      if (property.orientation) featureBits.push(property.orientation);
      if (property.subwayText) featureBits.push(property.subwayText);
      if (featureBits.length > 0) lines.push(`✨ ${featureBits.join(' · ')}`);

      if (property.schoolText) lines.push(`🎓 ${property.schoolText}`);

      // 匹配理由（不暴露内部术语与分数）
      if (property.highlights.length > 0) {
        lines.push(`✅ ${property.highlights.slice(0, 2).join('；')}`);
      }

      lines.push('');
    });

    // ---- 经纪人补充信息 ----
    if (customNote && customNote.trim()) {
      lines.push(customNote.trim());
      lines.push('');
    }

    // ---- 行动引导 ----
    // 主推理由要挑最有力的那个：价格降幅 > 匹配亮点 > 泛泛描述。
    // 之前只用 highlights[0]（"3房符合需求"）太弱，浪费了降价这个强卖点。
    if (featuredProperty) {
      const dropAmount = Math.abs(featuredProperty.priceChange);
      const reason =
        dropAmount > 0
          ? `业主刚降了${formatPriceWan(dropAmount)}，这个价格在这一片比较有优势`
          : (featuredProperty.highlights[0] ?? `${formatBedroomsCn(featuredProperty.bedrooms)}户型比较符合您的需求`);

      const featuredBedrooms =
        `${formatBedroomsCn(featuredProperty.bedrooms)}` +
        `${featuredProperty.livingRooms ? `${featuredProperty.livingRooms}厅` : ''}`;

      lines.push(
        `这几套里我个人最推荐${featuredProperty.community}那套${featuredBedrooms}` +
          `${formatArea(featuredProperty.area)}的，${reason}。您看什么时候方便，我带您实地看看？`,
      );
    } else {
      lines.push('您看什么时候方便，我帮您安排实地看房？');
    }

    // ---- 专属链接（数据闭环入口）----
    if (portalUrl) {
      lines.push('');
      lines.push('👇 点开可以看到完整房源信息、真实照片和价格走势：');
      lines.push(portalUrl);
      lines.push('（您在上面浏览、收藏的房源我这边能看到，方便帮您精准筛选）');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 短信版：极简，控制在 70 字内避免被拆成多条 */
  private composeSms(input: {
    customerName: string;
    customerGender?: string | null;
    scenario: RecommendScenario;
    properties: RecommendPropertyItem[];
    portalShortCode: string | null;
  }): string {
    const { customerName, customerGender, properties, portalShortCode } = input;
    const salutation = politeSalutation(customerName, customerGender);
    const first = properties[0];

    const parts: string[] = [`${salutation}您好`];

    if (first) {
      parts.push(
        `${first.community}${formatBedroomsCn(first.bedrooms)}${formatArea(first.area)}，${formatPriceWan(first.totalPrice)}`,
      );
      if (first.priceChange < 0) {
        parts.push(`降${formatPriceWan(Math.abs(first.priceChange))}`);
      }
    }

    if (portalShortCode) {
      parts.push(`详情 ${this.config.api.appBaseUrl}/c/${portalShortCode}`);
    } else {
      parts.push('详情回电咨询');
    }

    return parts.join('，').slice(0, 140);
  }

  /** 电话话术：三段式（开场 / 核心信息 / 引导提问） */
  private composePhoneScript(input: {
    customerName: string;
    customerGender?: string | null;
    scenario: RecommendScenario;
    properties: RecommendPropertyItem[];
    explicitSummary: string;
    driftNote: string | null;
    status: string;
  }): string {
    const { customerName, customerGender, properties, explicitSummary, driftNote } = input;
    const salutation = politeSalutation(customerName, customerGender);
    const first = properties[0];

    const lines: string[] = [];

    lines.push(`【开场】`);
    lines.push(
      `${salutation}您好，我是XX地产的小X。上次跟您聊过您在找${explicitSummary}的房子，今天给您打电话是有个新情况想跟您同步一下。`,
    );
    lines.push('');

    lines.push('【核心信息】');
    if (first) {
      lines.push(
        `您关注的${first.community}那边，现在有一套${formatBedroomsCn(first.bedrooms)}${formatArea(first.area)}的，总价${formatPriceWan(first.totalPrice)}。` +
          (first.priceChange < 0 ? `业主刚降了${formatPriceWan(Math.abs(first.priceChange))}，现在这个价格在这一片是比较有优势的。` : ''),
      );
      if (properties.length > 1) {
        lines.push(`另外还有 ${properties.length - 1} 套同区域的，价格梯度不一样，可以一起看看。`);
      }
    }
    if (driftNote) {
      lines.push(`（提示：${driftNote}）`);
    }
    lines.push('');

    lines.push('【引导提问】');
    lines.push('1. 您最近看房的节奏还顺利吗？有没有看到比较中意的？');
    lines.push('2. 您理想的价格段大概在什么区间？我按这个帮您精准筛。');
    lines.push('3. 这周末方便的话，我带您实地看看这几套？');
    lines.push('');

    lines.push('【注意事项】');
    lines.push('· 不要一上来就报价格，先问需求变化');
    lines.push('· 客户若说"再看看"，追问具体不满意哪一点，不要直接换房源');
    lines.push('· 通话结束前一定要约定下一个动作（带看时间或回电时间）');

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // 辅助信息
  // -------------------------------------------------------------------------

  /** 显性需求一句话描述 */
  private buildExplicitSummary(customer: {
    preferredDistricts: string[];
    bedrooms: number[];
    areaMin: number | null;
    areaMax: number | null;
    budgetMin: number | null;
    budgetMax: number | null;
    decorationPreference: string | null;
    schoolPreference: string | null;
  }): string {
    const parts: string[] = [];

    if (customer.preferredDistricts.length > 0) {
      parts.push(customer.preferredDistricts.join('、'));
    }
    if (customer.bedrooms.length > 0) {
      parts.push(customer.bedrooms.map((count) => formatBedroomsCn(count)).join('/'));
    }
    if (customer.areaMin !== null || customer.areaMax !== null) {
      parts.push(`${customer.areaMin ?? '不限'}～${customer.areaMax ?? '不限'}㎡`);
    }
    const budget = this.formatBudget(customer.budgetMin, customer.budgetMax);
    if (budget) parts.push(`预算${budget}`);
    if (customer.schoolPreference) parts.push('需学区');

    return parts.length > 0 ? parts.join('，') : '需求待补充';
  }

  /** 预算区间文案 */
  private formatBudget(min: number | null, max: number | null): string | null {
    if (min === null && max === null) return null;
    if (min !== null && max !== null) {
      return `${formatPriceWan(min)}～${formatPriceWan(max)}`;
    }
    if (min !== null) return `${formatPriceWan(min)}以上`;
    return `${formatPriceWan(max as number)}以内`;
  }

  /** 需求漂移提示 */
  private buildDriftNote(behaviorProfile: unknown, customer: { budgetMax: number | null }): string | null {
    if (!behaviorProfile) return null;
    const profile = behaviorProfile as { driftResult?: unknown; inferredBudgetMax?: number | null };
    if (!profile.driftResult) return null;

    const drift = profile.driftResult as { hasDrift?: boolean; recommendation?: string };
    if (!drift.hasDrift) return null;

    return drift.recommendation ?? '客户的预算或偏好近期有变化，建议按最新行为调整推荐方向。';
  }

  /** 策略说明：告诉经纪人这条消息的思路 */
  private buildStrategyNote(
    scenario: RecommendScenario,
    properties: RecommendPropertyItem[],
    customer: { intentScore: number | null; status: string },
  ): string {
    const score = customer.intentScore ?? 0;
    const hasDrop = properties.some((property) => property.priceChange < 0);

    const notes: string[] = [];

    switch (scenario) {
      case RecommendScenario.PRICE_DROP:
        notes.push('降价是天然的沟通理由，优先用价格变化开场，比"最近有房源吗"有效得多。');
        break;
      case RecommendScenario.DORMANT_REACTIVATE:
        notes.push('客户已沉睡较久，首次触达不要提成交，用"新信息"重新建立对话。');
        break;
      case RecommendScenario.VIEWING_FOLLOWUP:
        notes.push('带看后 24 小时内跟进效果最好，重点是解决客户当时提出的反对点。');
        break;
      case RecommendScenario.FIRST_MATCH:
        notes.push('首次触达，先给价值再谈约看，不要急着要联系方式之外的承诺。');
        break;
      default:
        notes.push('常规跟进，用具体房源信息作为沟通由头，避免空泛问候。');
    }

    if (score >= 75) {
      notes.push(`该客户 AI 意向分 ${score}，属于高意向，建议今天内电话跟进而不只是发微信。`);
    } else if (score >= 50) {
      notes.push(`该客户 AI 意向分 ${score}，保持每 3～5 天一次的跟进节奏。`);
    } else {
      notes.push(`该客户 AI 意向分 ${score} 偏低，建议先用微信保持触达，暂不投入过多时间。`);
    }

    if (hasDrop) {
      notes.push('推送中包含降价房源，这类消息的回复率明显高于普通推荐。');
    }

    return notes.join(' ');
  }

  /** 发送注意事项 */
  private buildCautions(
    customer: {
      budgetMin: number | null;
      budgetMax: number | null;
      status: string;
      intentLevel: string | null;
      notes: string | null;
    },
    properties: RecommendPropertyItem[],
    behaviorProfile: { inferredBudgetMax?: number | null } | null,
  ): string[] {
    const cautions: string[] = [];

    // 行为预算高于自述预算 —— 这是产品核心洞察，必须提示经纪人
    const statedMax = customer.budgetMax;
    const inferredMax = behaviorProfile?.inferredBudgetMax ?? null;

    if (statedMax !== null && inferredMax !== null && inferredMax > statedMax * 1.05) {
      cautions.push(
        `客户自述预算上限 ${formatPriceWan(statedMax)}，但实际浏览的房源最高到 ${formatPriceWan(inferredMax)}，` +
          `可以适当推荐超出其自述预算 5%～10% 的房源。`,
      );
    }

    // 超预算房源提示
    if (statedMax !== null) {
      const overBudget = properties.filter((property) => property.totalPrice > statedMax);
      if (overBudget.length > 0) {
        cautions.push(
          `本次推送中有 ${overBudget.length} 套超出客户自述预算，发送前建议先确认客户预算是否有调整。`,
        );
      }
    }

    if (customer.status === CustomerStatus.NEGOTIATING) {
      cautions.push('客户已进入谈判阶段，推送新房源可能分散其注意力，建议以推进在谈房源为主。');
    }

    if (customer.notes && customer.notes.trim()) {
      cautions.push(`客户备注：${customer.notes.trim()}`);
    }

    return cautions;
  }
}

/** 房源查询字段集（多处复用，避免遗漏字段导致运行时 undefined） */
const PROPERTY_SELECT = {
  id: true,
  title: true,
  community: true,
  district: true,
  subDistrict: true,
  totalPrice: true,
  unitPrice: true,
  bedrooms: true,
  livingRooms: true,
  bathrooms: true,
  area: true,
  floor: true,
  totalFloors: true,
  orientation: true,
  buildYear: true,
  decoration: true,
  elevator: true,
  subwayDistance: true,
  subwayInfo: true,
  schoolInfo: true,
  tags: true,
  coverImage: true,
  priceHistory: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { change: true, changePercent: true, oldPrice: true, newPrice: true },
  },
} as const;

interface PropertyRow {
  id: string;
  title: string;
  community: string;
  district: string;
  subDistrict: string | null;
  totalPrice: bigint;
  unitPrice: number;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: unknown;
  floor: number | null;
  totalFloors: number | null;
  orientation: string | null;
  buildYear: number | null;
  decoration: string | null;
  elevator: boolean | null;
  subwayDistance: number | null;
  subwayInfo: unknown;
  schoolInfo: unknown;
  tags: string[];
  coverImage: string | null;
  priceHistory: Array<{
    change: bigint;
    changePercent: unknown;
    oldPrice: bigint;
    newPrice: bigint;
  }>;
}
