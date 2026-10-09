/**
 * 贝壳 AI 开放平台房源 Provider（真实实现）。
 *
 * 与之前的"骨架实现"的区别：
 *   之前假设的是传统 REST + AppID/AppKey 换 Token 模式，因为没有官方文档，
 *   字段映射只能靠猜测 —— 那样的实现会产出错误数据，比明确报错更危险。
 *
 *   现在拿到了官方 CLI 与真实凭证，因此改为**真实实现**：
 *   CLI（本地 MCP 客户端）→ 结构化文本 + 嵌入 JSON → 解析器 → NormalizedProperty。
 *
 * 数据来源说明（合规）：
 *   - 通过贝壳官方 AI 开放平台的官方 CLI 获取，属于官方授权接入路径
 *   - 不做任何爬虫、不绕过反爬、不使用非官方接口
 *   - 返回的数据保留 rawData 原始字段，便于审计与追溯
 *
 * 重要限制（来自贝壳官方说明，必须遵守）：
 *   搜索结果中的「推荐展示数量」是 TopK 子集，**不代表全部结果**。
 *   总召回结果数（如 6063）是匹配总数，但接口只返回前 N 条。
 *   因此 Provider 的 total 字段返回的是召回总数，items 是实际拿到的子集。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ListingStatus,
  PropertyProviderKind,
  type NormalizedProperty,
  type PropertyFetchResult,
  type PropertyProvider,
  type PropertyQuery,
  type PropertyStatusChange,
} from '@estatepilot/types';
import { BeikeMcpClient, BeikeCliError, BeikeNotConfiguredError } from './beike-mcp-client.js';
import { BeikeFieldMapper, type ParsedEntity } from './beike-response-parser.js';

// 重新导出错误类型，方便业务层统一从 Provider 引入，避免深层路径依赖
export { BeikeCliError, BeikeNotConfiguredError };

/** 贝壳单次搜索返回的最大条数（官方 TopK 限制） */
const TOP_K_DISPLAYED = 10;

@Injectable()
export class BeikePropertyProvider implements PropertyProvider {
  readonly kind = PropertyProviderKind.BEIKE;

  private readonly logger = new Logger(BeikePropertyProvider.name);
  private readonly mapper = new BeikeFieldMapper();

  constructor(private readonly client: BeikeMcpClient) {}

  /** 凭证与 CLI 都已就绪才算可用 */
  isConfigured(): boolean {
    return this.client.isConfigured() && this.client.isCliInstalled();
  }

  /** 返回不可用的具体原因，供后台展示 */
  describeAvailability(): { available: boolean; reason: string | null } {
    if (!this.client.isCliInstalled()) {
      return {
        available: false,
        reason:
          '贝壳 CLI 未安装。请运行 infrastructure/beike/install-cli.ps1，' +
          '或设置 BEIKE_CLI_PATH 指向 beike 可执行文件。',
      };
    }
    if (!this.client.isConfigured()) {
      return {
        available: false,
        reason:
          '未配置贝壳 MCP 凭证。请在 .env 中设置 BEIKE_MCP_API_KEY，' +
          '或运行 beike login 获取后配置。',
      };
    }
    return { available: true, reason: null };
  }

  /**
   * 拉取房源列表。
   *
   * 实现方式：把结构化查询条件组装成自然语言 query 交给贝壳的语义检索。
   * 贝壳的搜索是**语义检索**（自动提取特征词），因此组合条件比拼接参数更有效。
   *
   * ⚠️ 重要限制：贝壳单次只返回 TopK（约 10 条）。
   * 因此「同步全城房源」这种用法在贝壳数据源上不可行 ——
   * 它的定位是「按需查询」，而不是「批量拉取房源库」。
   * 需要完整房源库时请使用「粘贴导入」或自有房源库。
   */
  async fetchProperties(query: PropertyQuery): Promise<PropertyFetchResult> {
    const { available, reason } = this.describeAvailability();
    if (!available) {
      throw new BeikeNotConfiguredError(reason ?? '贝壳数据源不可用');
    }

    const naturalQuery = this.buildNaturalQuery(query);

    this.logger.log(`贝壳语义检索：${query.city} / ${naturalQuery}`);

    const result = await this.client.searchHouses({
      city: query.city,
      query: naturalQuery,
      houseType: 'second',
    });

    const entities = result.parsed.entities.filter((entity) => entity.kind === 'house');
    const properties = this.mapEntities(entities, query.city);

    const totalRecalled = result.parsed.overview.totalRecalled ?? properties.length;

    this.logger.log(
      `贝壳检索完成：召回 ${totalRecalled} 套，本次解析 ${properties.length} 套` +
        `（官方单次上限约 ${TOP_K_DISPLAYED} 条）`,
    );

    return {
      items: properties,
      page: 1,
      pageSize: properties.length,
      total: totalRecalled,
      // 单次只能拿到 TopK，因此没有"下一页"的概念
      hasMore: false,
    };
  }

  /** 按房源 ID 取详情（贝壳的 ID 就是搜索返回的数字 ID） */
  async fetchPropertyDetail(externalId: string): Promise<NormalizedProperty | null> {
    const { available, reason } = this.describeAvailability();
    if (!available) {
      throw new BeikeNotConfiguredError(reason ?? '贝壳数据源不可用');
    }

    const result = await this.client.fetchDetails({
      city: '上海',
      ids: [externalId],
      entityType: 'house',
    });

    const entities = result.parsed.entities.filter((entity) => entity.kind === 'house');
    if (entities.length === 0) {
      this.logger.warn(`贝壳未返回房源 ${externalId} 的详情`);
      return null;
    }

    const properties = this.mapEntities(entities, '上海');
    return properties[0] ?? null;
  }

  /**
   * 批量取详情。
   *
   * 这是本 Provider 最有价值的能力之一：
   * 搜索只返回摘要，而详情包含学区梯队、得房率、周边配套、真实图片等
   * 对匹配与推荐至关重要的字段。
   */
  async fetchPropertiesDetail(externalIds: string[], city = '上海'): Promise<NormalizedProperty[]> {
    const { available, reason } = this.describeAvailability();
    if (!available) {
      throw new BeikeNotConfiguredError(reason ?? '贝壳数据源不可用');
    }

    const ids = externalIds.filter((id) => /^\d{6,}$/.test(id)).slice(0, 20);
    if (ids.length === 0) {
      this.logger.warn('没有有效的贝壳房源 ID（应为纯数字），跳过详情查询');
      return [];
    }

    const result = await this.client.fetchDetails({ city, ids, entityType: 'house' });
    const entities = result.parsed.entities.filter((entity) => entity.kind === 'house');

    return this.mapEntities(entities, city);
  }

  /**
   * 状态变化查询。
   *
   * 贝壳的 MCP 接口**不提供**「自上次同步以来的变化」这种增量查询能力 ——
   * 它是按需语义检索，不是可轮询的数据源。
   *
   * 因此这里明确返回空数组并说明原因，而不是假装支持。
   * 房源状态变化依赖：① 自有房源库的导入更新 ② 定期按小区重新检索比对。
   */
  async fetchStatusChanges(_since: Date, _city: string): Promise<PropertyStatusChange[]> {
    this.logger.debug(
      '贝壳 MCP 接口不支持增量状态查询（它是按需语义检索），' +
        '状态变化检测依赖自有房源库或定期重新检索比对。',
    );
    return [];
  }

  // -------------------------------------------------------------------------
  // 辅助
  // -------------------------------------------------------------------------

  /**
   * 把结构化查询条件组装成自然语言。
   *
   * 贝壳的检索是语义化的，会从文本里提取「城区」「卧室数」「价格」等特征词，
   * 因此自然语言表达比拼参数更有效。这也是官方推荐的用法。
   */
  private buildNaturalQuery(query: PropertyQuery): string {
    const parts: string[] = [];

    if (query.district) parts.push(query.district);

    // 扩展查询对象可能携带的额外条件（由业务层传入）
    const extended = query as PropertyQuery & {
      bedrooms?: number[];
      priceMin?: number;
      priceMax?: number;
      keywords?: string;
      community?: string;
    };

    if (extended.community) parts.push(extended.community);

    if (extended.bedrooms && extended.bedrooms.length > 0) {
      const bedroomText = extended.bedrooms
        .map((count) => `${count}居室`)
        .join('或');
      parts.push(bedroomText);
    }

    if (extended.priceMax) {
      parts.push(`${Math.round(extended.priceMax / 10_000)}万以内`);
    }

    if (extended.keywords) parts.push(extended.keywords);

    // 兜底：没有任何条件时给一个宽泛查询
    if (parts.length === 0) parts.push('二手房');

    return parts.join(' ');
  }

  /** 把解析出的实体映射为统一的房源模型 */
  private mapEntities(entities: ParsedEntity[], city: string): NormalizedProperty[] {
    const results: NormalizedProperty[] = [];

    for (const entity of entities) {
      try {
        const mapped = this.mapper.mapEntity(entity, { city });
        if (mapped) results.push(mapped);
      } catch (error) {
        // 单条映射失败不应中断整批
        this.logger.error(
          `房源 ${entity.id} 字段映射失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return results;
  }

  /**
   * 对外暴露的实体映射。
   *
   * 供业务层（如微信助手编排器）在自行调用底层 client 之后，
   * 复用同一套字段映射逻辑 —— 避免在别处复制一份映射代码，
   * 那样一旦贝壳字段变化就会出现"两个接口口径不一致"的问题。
   */
  async mapEntitiesForReuse(
    entities: ParsedEntity[],
    city: string,
  ): Promise<NormalizedProperty[]> {
    return this.mapEntities(entities, city);
  }

  /** 环境诊断，供后台"测试连接"按钮使用 */
  async diagnose(): Promise<{ ok: boolean; message: string; detail: string }> {
    const { available, reason } = this.describeAvailability();
    if (!available) {
      return { ok: false, message: reason ?? '不可用', detail: '' };
    }

    try {
      const result = await this.client.diagnose();
      return {
        ok: result.ok,
        message: result.message,
        detail: result.raw,
      };
    } catch (error) {
      const message =
        error instanceof BeikeCliError
          ? error.message
          : error instanceof Error
            ? error.message
            : '诊断失败';
      return { ok: false, message, detail: '' };
    }
  }

  /**
   * 按客户需求做一次真实房源检索。
   *
   * 这是产品最核心的能力调用：把客户需求转成贝壳能理解的查询，
   * 拿回真实在售房源，再进入后续的匹配打分与推荐流程。
   *
   * 关于详情补全（重要）：
   *   贝壳的「搜索」接口只返回摘要（价格/户型/区位），而「详情」接口才提供
   *   学区梯队、周边配套、真实图片等字段。但详情是**额外的 CLI 调用**，
   *   单次约 2～10 秒，对 10 套房源全部补详情会让整体流程超过 30 秒。
   *
   *   因此这里默认**不**补详情，由调用方在完成硬筛与打分、确定 Top N 之后
   *   再调 fetchPropertiesDetail 精确补全 —— 这也是需求 §22 的要求：
   *   「不要对搜索返回的所有房源调用详情接口」。
   */
  async searchForCustomer(params: {
    city: string;
    districts?: string[];
    bedrooms?: number[];
    budgetMax?: number;
    budgetMin?: number;
    communities?: string[];
    keywords?: string;
    /** 是否同步补齐详情。默认 false，只对 Top N 补详情性能才可接受 */
    enrichDetails?: boolean;
    /** 需要补详情的数量上限（仅 enrichDetails=true 时生效） */
    enrichLimit?: number;
  }): Promise<NormalizedProperty[]> {
    const parts: string[] = [];

    if (params.districts && params.districts.length > 0) {
      parts.push(params.districts.slice(0, 3).join(' '));
    }
    if (params.communities && params.communities.length > 0) {
      parts.push(params.communities.slice(0, 2).join(' '));
    }
    if (params.bedrooms && params.bedrooms.length > 0) {
      parts.push(`${params.bedrooms[0]}居室`);
    }
    if (params.budgetMax) {
      parts.push(`${Math.round(params.budgetMax / 10_000)}万以内`);
    }
    if (params.keywords) {
      parts.push(params.keywords);
    }

    const query = parts.length > 0 ? parts.join(' ') : '二手房';

    const result = await this.client.searchHouses({
      city: params.city,
      query,
      houseType: 'second',
    });

    const entities = result.parsed.entities.filter((entity) => entity.kind === 'house');
    let properties = this.mapEntities(entities, params.city);

    // 客户端二次过滤：贝壳的语义检索可能放宽条件（官方说明里明确提到
    // match_type 可能是 LIKE，即近似召回），因此业务层需要自己再收一次
    properties = this.applyHardFilters(properties, params);

    // 详情补全：只对前 N 套做，避免为整个列表付出多次 CLI 调用的代价
    if (params.enrichDetails && properties.length > 0) {
      const enrichLimit = Math.min(params.enrichLimit ?? 8, 20);
      const topIds = properties.slice(0, enrichLimit).map((property) => property.externalId);

      try {
        const enriched = await this.fetchPropertiesDetail(topIds, params.city);
        const enrichedMap = new Map(enriched.map((property) => [property.externalId, property]));

        properties = properties.map((summary) => {
          const detail = enrichedMap.get(summary.externalId);
          if (!detail) return summary;
          // 详情字段更完整，但摘要里的标签等也要保留，因此做合并而不是覆盖
          return {
            ...summary,
            ...detail,
            tags: detail.tags.length > 0 ? detail.tags : summary.tags,
          };
        });
      } catch (error) {
        // 详情补齐失败不影响主流程，用摘要数据继续（并明确告知调用方）
        this.logger.warn(
          `补齐房源详情失败，使用摘要数据继续：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return properties;
  }

  /**
   * 硬性条件二次过滤。
   *
   * 为什么需要：贝壳官方明确说明检索条件可能被"改写或放宽"，
   * match_type 为 LIKE 时属于近似召回。
   * 如果直接把这些结果推给客户，会出现"客户要 500 万以内的房子，
   * 系统却推荐了 800 万的"这类问题。
   */
  private applyHardFilters(
    properties: NormalizedProperty[],
    params: {
      districts?: string[];
      bedrooms?: number[];
      budgetMax?: number;
      budgetMin?: number;
    },
  ): NormalizedProperty[] {
    return properties.filter((property) => {
      // 只看在售
      if (property.listingStatus !== ListingStatus.ACTIVE) return false;

      // 预算上限：允许 10% 溢出（真实业务中略超预算的房源也值得推荐）
      if (params.budgetMax) {
        if (property.totalPrice > params.budgetMax * 1.1) return false;
      }

      // 预算下限：如果客户有明确下限，低于下限太多的也不合适
      if (params.budgetMin) {
        if (property.totalPrice < params.budgetMin * 0.7) return false;
      }

      // 户型：必须命中
      if (params.bedrooms && params.bedrooms.length > 0) {
        if (!params.bedrooms.includes(property.bedrooms)) return false;
      }

      // 区域：贝壳返回的是「浦东」这类简称，需要用包含匹配
      if (params.districts && params.districts.length > 0) {
        const matched = params.districts.some(
          (district) =>
            property.district.includes(district.replace(/[区县]$/, '')) ||
            district.includes(property.district.replace(/[区县]$/, '')),
        );
        if (!matched) return false;
      }

      return true;
    });
  }
}
