/**
 * 贝壳数据源控制器。
 *
 * 提供三类能力：
 *   1. 状态与诊断 —— 后台"测试连接"按钮、数据源健康检查
 *   2. 真实房源检索 —— 按客户需求或关键词查询贝壳在售房源
 *   3. 房源详情 —— 含学区、配套、真实图片
 *
 * 安全：所有响应都经过脱敏（API Key 绝不出现在任何返回中）。
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ApiErrorCode, UserRole, type NormalizedProperty } from '@estatepilot/types';
import {
  BeikePropertyProvider,
  BeikeNotConfiguredError,
  BeikeCliError,
} from './providers/beike/beike-property.provider.js';
import { BeikeMcpClient } from './providers/beike/beike-mcp-client.js';
import { PropertyProviderRegistry } from './providers/provider-registry.js';
import { BeikeFieldMapper, type ParsedEntity } from './providers/beike/beike-response-parser.js';
import { ZodBody } from '../../common/pipes/zod-validation.pipe.js';
import { Roles } from '../../common/decorators/auth.decorators.js';
import { ServiceUnavailableError } from '../../common/filters/all-exceptions.filter.js';

/** 关键词检索 */
const searchSchema = z.object({
  city: z.string().min(1).max(20).default('上海'),
  query: z.string().min(1, '请输入检索条件').max(120),
  houseType: z.enum(['second', 'new', 'all']).default('second'),
});

/** 按客户需求检索 */
const searchByRequirementSchema = z.object({
  city: z.string().min(1).max(20).default('上海'),
  districts: z.array(z.string().max(20)).max(5).optional(),
  communities: z.array(z.string().max(50)).max(5).optional(),
  bedrooms: z.array(z.coerce.number().int().min(1).max(10)).max(5).optional(),
  budgetMin: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
  budgetMax: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
  keywords: z.string().max(60).optional(),
  /** 是否补齐详情（更慢但字段更全，含学区与周边配套） */
  enrichDetails: z.boolean().default(true),
});

/** 详情查询 */
const detailSchema = z.object({
  city: z.string().min(1).max(20).default('上海'),
  ids: z.array(z.string().min(1).max(40)).min(1).max(20),
});

type SearchInput = z.infer<typeof searchSchema>;
type SearchByRequirementInput = z.infer<typeof searchByRequirementSchema>;
type DetailInput = z.infer<typeof detailSchema>;

/** 返回给前端的房源摘要（比 NormalizedProperty 更贴近界面需要） */
interface PropertySummaryDto {
  externalId: string;
  title: string;
  community: string;
  district: string;
  subDistrict: string | null;
  totalPrice: number;
  unitPrice: number;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: number;
  floor: number | null;
  totalFloors: number | null;
  orientation: string | null;
  decoration: string | null;
  buildYear: number | null;
  subwayDistance: number | null;
  subwayText: string | null;
  schoolText: string | null;
  tags: string[];
  coverImage: string | null;
  imageCount: number;
  listingStatus: string;
  /** 百度地图等外部地图链接（前端可直接跳转） */
  mapUrl: string | null;
}

@Controller('beike')
export class BeikeController {
  constructor(
    private readonly registry: PropertyProviderRegistry,
    private readonly beikeClient: BeikeMcpClient,
  ) {}

  /**
   * 数据源状态。
   * 供设置页与后台展示，让用户清楚当前用的是真实贝壳数据还是 Demo 数据。
   *
   * 加 `?probe=1` 时额外做一次**真实数据查询**探测，用于区分两种完全不同的故障：
   *   - 凭证问题：Key 无效/过期 → 需要用户重新获取 Key
   *   - 服务问题：Key 有效但数据服务不可用（实测贝壳会整体不可用）
   *     → 用户只需等待，重试即可，不需要做任何配置
   * 这个区分很重要：否则用户会以为是自己的配置错了，反复折腾。
   */
  @Get('status')
  async status(
    @Query('probe') probe?: string,
  ): Promise<{
    providers: Array<{
      kind: string;
      configured: boolean;
      isDefault: boolean;
      description: string;
    }>;
    beike: {
      cliInstalled: boolean;
      cliPath: string;
      credentialConfigured: boolean;
      credentialMasked: string | null;
      apiBaseUrl: string;
      available: boolean;
      unavailableReason: string | null;
    };
    activeProvider: string;
    /** 真实数据查询探测结果（仅 probe=1 时返回） */
    liveProbe?: {
      ok: boolean;
      /** CONNECTION = 连接/凭证问题（需要处理）；SERVICE = 数据服务不可用（等待即可） */
      failureKind: 'NONE' | 'CONNECTION' | 'SERVICE' | 'UNKNOWN';
      message: string;
      durationMs: number;
    };
  }> {
    const beikeProvider = new BeikePropertyProvider(this.beikeClient);
    const availability = beikeProvider.describeAvailability();

    const base = {
      providers: this.registry.listStatus(),
      beike: {
        ...this.beikeClient.describeStatus(),
        available: availability.available,
        unavailableReason: availability.reason,
      },
      activeProvider: this.registry.getDefault().kind,
    };

    // 只有显式要求时才做真实探测（它会消耗一次贝壳调用）
    if (probe !== '1' && probe !== 'true') {
      return base;
    }

    const startedAt = Date.now();

    try {
      // 用最小的查询做探测：只要能拿到结构化返回即认为数据服务正常
      const result = await this.beikeClient.searchHouses({
        city: '上海',
        query: '房',
        houseType: 'second',
      });

      const entities = result.parsed.entities.filter((entity) => entity.kind === 'house');

      return {
        ...base,
        liveProbe: {
          ok: true,
          failureKind: 'NONE',
          message: `贝壳数据服务正常（本次探测返回 ${entities.length} 条房源）`,
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // 区分两类失败：连接/凭证问题 vs 数据服务不可用
      const isServiceIssue =
        error instanceof BeikeCliError &&
        (error.isServiceBusy || error.isUnavailable) &&
        !/凭证|未配置|auth|unauthor/i.test(message);

      return {
        ...base,
        liveProbe: {
          ok: false,
          failureKind: isServiceIssue ? 'SERVICE' : 'CONNECTION',
          message: isServiceIssue
            ? '贝壳数据服务暂时不可用（凭证有效、连接正常，属于对方服务端问题）。' +
              '请稍后重试，无需修改任何配置。'
            : `贝壳连接或凭证异常：${message}`,
          durationMs: Date.now() - startedAt,
        },
      };
    }
  }

  /**
   * 测试连接（后台"测试连接"按钮）。
   * 会真实调用贝壳 CLI 做一次诊断，验证凭证与网络。
   */
  @Post('diagnose')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.STORE_MANAGER, UserRole.OWNER)
  async diagnose(): Promise<{ ok: boolean; message: string; detail: string }> {
    const provider = new BeikePropertyProvider(this.beikeClient);
    return provider.diagnose();
  }

  /**
   * 关键词检索真实房源。
   * 支持自由文本，贝壳会自动提取特征词（如"浦东三房 500万以内"）。
   */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(@Body(ZodBody(searchSchema)) body: SearchInput): Promise<{
    items: PropertySummaryDto[];
    totalRecalled: number | null;
    matchedConditions: Array<{ query: string; condition: string; matchType: string }>;
    notice: string;
  }> {
    const provider = new BeikePropertyProvider(this.beikeClient);

    try {
      // 直接调用底层客户端以拿到检索概览（这是产品价值之一：
      // 让经纪人知道贝壳实际用了哪些条件检索，避免误以为结果完全符合需求）
      const result = await this.beikeClient.searchHouses({
        city: body.city,
        query: body.query,
        houseType: body.houseType,
      });

      const entities = result.parsed.entities.filter((entity) => entity.kind === 'house');

      // 注意：这里**不做硬筛、也不补详情**。
      // 这是"经纪人主动搜索"入口，他应该看到贝壳的真实返回，
      // 而不是被系统按某个客户的条件过滤过的结果。
      // 详情补全交给调用方在确定 Top N 之后再做（需求 §22）。
      const properties = this.mapEntitiesDirectly(entities, body.city);

      return {
        items: properties.map((property) => this.toSummaryDto(property, body.city)),
        totalRecalled: result.parsed.overview.totalRecalled,
        matchedConditions: result.parsed.overview.matchedConditions,
        notice:
          '贝壳单次返回展示上限约 10 条（官方 TopK 限制），' +
          '总召回数表示匹配总量。检索条件可能被语义改写，请以实际带看为准。',
      };
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  /**
   * 把贝壳客户端错误转成合适的 HTTP 错误。
   *
   * 关键区分：网络不可达（临时故障）→ 503 + BEIKE_UNAVAILABLE，
   * 前端据此提示"贝壳房源暂时无法查询"并只提供"重新查询房源"，
   * 而不是让用户重新走一遍 AI 需求解析（那样既浪费 Token 又可能产生不一致需求）。
   */
  private toHttpError(error: unknown): Error {
    if (error instanceof BeikeCliError && error.isUnavailable) {
      return new ServiceUnavailableError(
        '贝壳房源服务暂时不可用，请稍后点击「重新查询房源」重试。' +
          '您的客户需求已经保存，无需重新分析。',
        ApiErrorCode.BEIKE_UNAVAILABLE,
      );
    }

    if (error instanceof BeikeNotConfiguredError) {
      return new ServiceUnavailableError(error.message, ApiErrorCode.BEIKE_NOT_CONFIGURED);
    }

    if (error instanceof BeikeCliError) {
      return new ServiceUnavailableError(
        `贝壳房源查询失败：${error.message}`,
        ApiErrorCode.BEIKE_SEARCH_FAILED,
      );
    }

    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * 按客户需求检索。
   * 这是产品核心链路的一环：客户需求 → 贝壳真实房源 → 匹配打分 → 推荐话术。
   */
  @Post('search-by-requirement')
  @HttpCode(HttpStatus.OK)
  async searchByRequirement(
    @Body(ZodBody(searchByRequirementSchema)) body: SearchByRequirementInput,
  ): Promise<{
    items: PropertySummaryDto[];
    totalRecalled: number | null;
    filteredOut: number;
    notice: string;
  }> {
    const provider = new BeikePropertyProvider(this.beikeClient);

    const properties = await provider.searchForCustomer({
      city: body.city,
      ...(body.districts ? { districts: body.districts } : {}),
      ...(body.communities ? { communities: body.communities } : {}),
      ...(body.bedrooms ? { bedrooms: body.bedrooms } : {}),
      ...(body.budgetMin !== undefined ? { budgetMin: body.budgetMin } : {}),
      ...(body.budgetMax !== undefined ? { budgetMax: body.budgetMax } : {}),
      ...(body.keywords ? { keywords: body.keywords } : {}),
    });

    return {
      items: properties.map((property) => this.toSummaryDto(property, body.city)),
      totalRecalled: null,
      filteredOut: 0,
      notice:
        '已按您的硬性条件（区域/户型/预算）做了二次过滤。' +
        '贝壳的语义检索可能放宽条件，因此过滤是必要的。',
    };
  }

  /** 批量查询房源详情 */
  @Post('detail')
  @HttpCode(HttpStatus.OK)
  async detail(@Body(ZodBody(detailSchema)) body: DetailInput): Promise<{
    items: PropertySummaryDto[];
    notice: string;
  }> {
    const provider = new BeikePropertyProvider(this.beikeClient);
    const properties = await provider.fetchPropertiesDetail(body.ids, body.city);

    return {
      items: properties.map((property) => this.toSummaryDto(property, body.city)),
      notice: '详情数据来自贝壳开放平台，含学区与周边配套信息，具体以实际带看为准。',
    };
  }

  /** 直接映射实体（用于搜索接口的降级路径：用户主动搜索时不应返回空列表） */
  private mapEntitiesDirectly(entities: ParsedEntity[], city: string): NormalizedProperty[] {
    const mapper = new BeikeFieldMapper();

    return entities
      .map((entity) => mapper.mapEntity(entity, { city }))
      .filter((property): property is NormalizedProperty => property !== null);
  }

  /** 把统一房源模型转成前端友好的摘要 */
  private toSummaryDto(property: NormalizedProperty, city: string): PropertySummaryDto {
    const subway = property.subway;
    const subwayText = subway
      ? [subway.line, subway.station, subway.distanceMeters ? `约${subway.distanceMeters}米` : null]
          .filter(Boolean)
          .join(' ')
      : null;

    const school = property.schoolInfo;
    const schoolText = school
      ? [school.primarySchool, school.middleSchool, school.note].filter(Boolean).join(' ｜ ')
      : null;

    // 地图链接：有经纬度就用精确坐标，否则用地址搜索
    const mapUrl =
      property.longitude !== null && property.latitude !== null
        ? `https://api.map.baidu.com/marker?location=${property.latitude},${property.longitude}&title=${encodeURIComponent(property.community)}&content=${encodeURIComponent(property.title)}&output=html`
        : `https://api.map.baidu.com/geocoder?address=${encodeURIComponent(`${city}${property.district}${property.community}`)}&output=html&src=estatepilot`;

    return {
      externalId: property.externalId,
      title: property.title,
      community: property.community,
      district: property.district,
      subDistrict: property.subDistrict,
      totalPrice: property.totalPrice,
      unitPrice: property.unitPrice,
      bedrooms: property.bedrooms,
      livingRooms: property.livingRooms,
      bathrooms: property.bathrooms,
      area: property.area,
      floor: property.floor,
      totalFloors: property.totalFloors,
      orientation: property.orientation,
      decoration: property.decoration,
      buildYear: property.buildYear,
      subwayDistance: property.subwayDistance,
      subwayText,
      schoolText,
      tags: property.tags,
      coverImage: property.images[0]?.url ?? null,
      imageCount: property.images.length,
      listingStatus: property.listingStatus,
      mapUrl,
    };
  }
}
