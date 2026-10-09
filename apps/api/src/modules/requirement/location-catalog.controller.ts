/**
 * 城市与区域目录接口 —— 供前端"地址筛选"使用。
 *
 * ============================================================================
 * 为什么需要这个接口
 * ============================================================================
 * 需求：**选择哪个区域就推荐哪个地方的房源**。
 *
 * 实现上，前端需要知道：
 *   1. 系统支持哪些城市
 *   2. 每个城市有哪些行政区与板块（供下拉选择）
 *   3. 每个城市当前**实际有多少房源**（避免选了一个没房源的城市白等）
 *   4. 贝壳对该城市的可用状态（服务故障时提前告知，而不是等失败）
 *
 * 第 3、4 点很关键：如果没有它们，经纪人选了"厦门"却等 20 秒才发现
 * 一套房源都没有，体验很差。这里提前用数据说话。
 */

import { Controller, Get, Query } from '@nestjs/common';

import { TenantService } from '../tenant/tenant.service.js';
import { getContext } from '../../common/context/request-context.js';
import { CITY_LOCATION_PROFILES } from './city-locations.js';
import { BeikeMcpClient } from '../property/providers/beike/beike-mcp-client.js';

/** 单个城市的可选状态 */
interface CityCatalogItem {
  city: string;
  /** 贝壳城市编码 */
  beikeCityCode: string | null;
  /** 行政区（全称，用于筛选） */
  districts: string[];
  /** 板块（更细的位置偏好） */
  subDistricts: string[];
  /** 该城市在本地库里**实际可用**的真实房源数 */
  availableProperties: number;
  /**
   * 是否有本地房源可立即推荐。
   *
   * false 表示：选了这个城市，若贝壳不可用就会"无房源可推"。
   * 前端应据此提示用户。
   */
  hasLocalInventory: boolean;
}

@Controller('locations')
export class LocationCatalogController {
  constructor(
    private readonly tenant: TenantService,
    private readonly beike: BeikeMcpClient,
  ) {}

  /**
   * 统计各城市的可用房源数。
   *
   * 实现说明：`TenantScope` 没有 `groupBy`，而按城市聚合需要分组。
   * 这里用 `unsafeRaw()` 拿底层客户端，但**显式带上 organizationId 过滤** ——
   * 租户隔离不能因为"要分组"就丢掉。
   *
   * 只统计**真实来源**（排除演示数据）：演示数据在生产环境本来就进不了
   * 推荐，把它算进"可用房源"会误导经纪人以为某个城市有货。
   */
  private async countByCity(organizationId: string): Promise<Map<string, number>> {
    const scope = this.tenant.scopeFor(organizationId);

    const grouped = await scope.unsafeRaw().property.groupBy({
      by: ['city'],
      where: {
        organizationId,
        // 注意字段名是 delistedAt（下架时间），不是 deletedAt
        delistedAt: null,
        externalProvider: { not: 'MOCK' },
      },
      _count: { id: true },
    });

    const result = new Map<string, number>();
    for (const row of grouped) {
      if (row.city) result.set(row.city, row._count.id);
    }
    return result;
  }

  /** 统计某城市各行政区的可用房源数 */
  private async countByDistrict(
    organizationId: string,
    city: string,
  ): Promise<Array<{ district: string; count: number }>> {
    const scope = this.tenant.scopeFor(organizationId);

    const grouped = await scope.unsafeRaw().property.groupBy({
      by: ['district'],
      where: {
        organizationId,
        delistedAt: null,
        city,
        externalProvider: { not: 'MOCK' },
      },
      _count: { id: true },
    });

    return grouped
      .filter((row): row is typeof row & { district: string } => Boolean(row.district))
      .map((row) => ({ district: row.district, count: row._count.id }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * 城市与区域目录。
   *
   * @param withCounts 是否统计每个城市的真实房源数（默认 true）
   */
  @Get('cities')
  async cities(@Query('withCounts') withCounts?: string): Promise<{
    cities: CityCatalogItem[];
    beike: { configured: boolean; reachable: boolean; message: string };
  }> {
    const includeCounts = withCounts !== 'false';
    const organizationId = getContext()?.organizationId;

    // ---- 各城市的真实房源数 ----
    const countsByCity =
      includeCounts && organizationId ? await this.countByCity(organizationId) : new Map();

    // ---- 贝壳状态 ----
    // 只做轻量判断，不做真实请求（避免每次打开筛选器都等几秒）。
    // 真实的可用性由实际的搜索请求反馈，前端会看到明确的错误提示。
    const beikeConfigured = this.beike.isConfigured();

    const cities: CityCatalogItem[] = CITY_LOCATION_PROFILES.map((profile) => {
      const availableProperties = countsByCity.get(profile.city) ?? 0;

      return {
        city: profile.city,
        beikeCityCode: profile.beikeCityCode ?? null,
        districts: [...profile.districts],
        subDistricts: [...profile.subDistricts],
        availableProperties,
        hasLocalInventory: availableProperties > 0,
      };
    });

    // 把库里有房源但不在预设档案里的城市也列出来（避免数据"隐身"）
    for (const [city, count] of countsByCity) {
      if (cities.some((item) => item.city === city)) continue;
      cities.push({
        city,
        beikeCityCode: null,
        districts: [],
        subDistricts: [],
        availableProperties: count,
        hasLocalInventory: count > 0,
      });
    }

    // 有房源的排前面
    cities.sort((a, b) => b.availableProperties - a.availableProperties);

    return {
      cities,
      beike: {
        configured: beikeConfigured,
        reachable: beikeConfigured,
        message: beikeConfigured
          ? '贝壳数据源已配置（实时可用性以实际查询为准）'
          : '贝壳数据源未配置，只能使用本地已有房源',
      },
    };
  }

  /**
   * 单个城市的区域详情。
   *
   * 供"先选城市再选区"的两级联动使用（城市多时不必一次传全部区域）。
   */
  @Get('areas')
  async areas(@Query('city') city: string): Promise<{
    city: string;
    districts: string[];
    subDistricts: string[];
    availableProperties: number;
    /** 各行政区实际有多少房源（帮助下拉里显示数量） */
    districtCounts: Array<{ district: string; count: number }>;
  }> {
    const organizationId = getContext()?.organizationId;
    const profile = CITY_LOCATION_PROFILES.find((item) => item.city === city);

    const districtCounts = organizationId
      ? await this.countByDistrict(organizationId, city)
      : [];

    const availableProperties = districtCounts.reduce((sum, item) => sum + item.count, 0);

    return {
      city,
      districts: profile ? [...profile.districts] : [],
      subDistricts: profile ? [...profile.subDistricts] : [],
      availableProperties,
      districtCounts,
    };
  }
}
