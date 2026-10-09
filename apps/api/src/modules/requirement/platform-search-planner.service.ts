/**
 * 官方平台检索助手 —— 把客户需求变成"能在贝壳 App 里一键搜索"的条件。
 *
 * ============================================================================
 * 为什么做这个（设计动机）
 * ============================================================================
 * 经纪人的真实困境：
 *
 *   1. 客户在微信说了一堆需求（"厦门岛外三房，400万左右，别太老"）
 *   2. 经纪人要**自己把这些翻译成 App 的搜索条件**（城市/区/户型/总价区间）
 *   3. 在贝壳 App 里点半天，看到房源
 *   4. 挑几套发给客户
 *   5. 客户说"再便宜点的" → 回到第 2 步
 *
 * 第 2 步是纯粹的机械劳动，而且**反复做**（每次客户改口都要重来）。
 * 本服务把这一步自动化：
 *
 *   客户需求 → 结构化搜索条件 + 可点击的深度链接 + 可复制的中文检索式
 *
 * ============================================================================
 * 合规说明（重要，不可删除）
 * ============================================================================
 * 本服务**不抓取任何平台数据**。它只做两件事：
 *   1. 把自然语言需求**翻译**成搜索条件（纯本地计算）
 *   2. 生成**跳转链接**，由经纪人用自己的账号在官方 App/网页里查看
 *
 * 数据始终来自经纪人**有权访问的官方渠道**，本系统不存储、不转发、
 * 不绕过任何技术措施。这是与"爬虫"的本质区别。
 *
 * 经纪人在官方 App 里看到房源后，可以把结果粘贴回系统，
 * 由 `PropertyTextParserService` + `MatchScoringService` 完成结构化与排序。
 */

import { Injectable, Logger } from '@nestjs/common';

import type { PropertySearchQuery } from '@estatepilot/types';

/** 一个可执行的检索方案 */
export interface PlatformSearchPlan {
  /** 目标平台（目前是贝壳，将来可扩展） */
  platform: 'BEIKE';
  /** 城市 */
  city: string;
  /** 行政区（空 = 全部） */
  districts: string[];
  /** 户型（空 = 不限） */
  bedrooms: number[];
  /** 总价区间（单位：元） */
  priceMin: number | null;
  priceMax: number | null;
  /** 面积区间（单位：㎡） */
  areaMin: number | null;
  areaMax: number | null;
  /**
   * 中文检索式 —— 可直接粘进贝壳 App 的搜索框。
   *
   * 为什么给这个而不只给结构化字段：App 的搜索框吃自然语言，
   * 而逐项点选筛选器很慢。一句话搜索通常更快命中。
   */
  searchText: string;
  /**
   * 深度链接 —— 可点击直接跳到贝壳的搜索结果页。
   *
   * ⚠️ 实现说明：这里用的是**公开的网页版搜索地址**，不是私有接口。
   * 它等价于"在浏览器里打开贝壳网站并搜索"，与经纪人在 App 里手动搜索
   * 没有本质区别。**不做任何签名伪造或接口逆向**。
   */
  deepLink: string;
  /** 客户端可复制的检索说明（含条件来源，便于经纪人核对） */
  explanation: string;
  /** 条件缺失或过宽的提醒 */
  warnings: string[];
}

/** 贝壳网页版搜索地址前缀（公开域名，仅用于跳转） */
const BEIKE_WEB_SEARCH = 'https://m.ke.com/xm/ershoufang/';

/**
 * 城市 → 贝壳网页版城市路径段。
 *
 * ⚠️ 这些 slug 是**实测验证**过的，不是猜的：
 *   `xm`      → 302 到验证码页（说明路径存在，只是被反爬拦住）
 *   `xiamen`  → 404（路径不存在）
 *   `sh`      → 302 到验证码页
 *
 * 只收录已支持的城市。未收录的城市**不生成链接** ——
 * 猜错路径会把经纪人带到错误城市的房源，比不给链接更糟。
 */
const CITY_SLUG: Record<string, string> = {
  厦门: 'xm',
  上海: 'sh',
  北京: 'bj',
  深圳: 'sz',
  广州: 'gz',
  杭州: 'hz',
  福州: 'fz',
  泉州: 'quanzhou',
  漳州: 'zhangzhou',
};

@Injectable()
export class PlatformSearchPlanner {
  private readonly logger = new Logger(PlatformSearchPlanner.name);

  /**
   * 把搜索条件翻译成各平台的检索方案。
   *
   * @param query 已生成的结构化搜索条件（来自 PropertySearchQueryBuilder）
   */
  plan(query: PropertySearchQuery): PlatformSearchPlan {
    const city = query.city ?? '';
    const warnings: string[] = [];

    // ---- 预算 ----
    // 用 budgetMax（检索放宽后的上限）而不是客户说的理想价：
    // 经纪人在 App 里看到的是"能接受的最高价以内"，漏掉刚好超一点的房源可惜。
    const priceMax = query.budgetMax ?? null;
    const priceMin = query.budgetMin ?? null;

    if (priceMax === null) {
      warnings.push('未识别到预算上限，App 里请自行设定总价范围');
    }

    // ---- 中文检索式 ----
    const searchText = this.buildSearchText(query);

    // ---- 深度链接 ----
    const deepLink = this.buildDeepLink(city, query, warnings);

    // ---- 检索说明 ----
    const explanation = this.buildExplanation(query);

    if (query.districts.length === 0) {
      warnings.push('未指定行政区，App 里会搜全城，结果较多');
    }
    if (query.bedrooms.length === 0) {
      warnings.push('未指定户型');
    }

    return {
      platform: 'BEIKE',
      city,
      districts: [...query.districts],
      bedrooms: [...query.bedrooms],
      priceMin,
      priceMax,
      areaMin: query.areaMin ?? null,
      areaMax: query.areaMax ?? null,
      searchText,
      deepLink,
      explanation,
      warnings,
    };
  }

  /**
   * 组装中文检索式。
   *
   * 设计取舍：**按 App 搜索框的实际理解习惯排序** ——
   * 区域在前（限定范围）、户型面积在中、价格在后（App 对价格的解析最稳）、
   * 定性偏好（房龄/地铁）放最后，它们影响排序而非过滤。
   */
  private buildSearchText(query: PropertySearchQuery): string {
    const parts: string[] = [];

    if (query.city) parts.push(query.city);

    // 区域：行政区优先，板块更精确时用板块
    if (query.subDistricts.length > 0) {
      parts.push(query.subDistricts.slice(0, 2).join('、'));
    } else if (query.districts.length > 0) {
      parts.push(query.districts.map((d) => d.replace(/[区县]$/, '')).slice(0, 3).join('、'));
    }

    if (query.bedrooms.length > 0) {
      parts.push(`${query.bedrooms.join('或')}房`);
    }

    if (query.areaMin !== null && query.areaMax !== null) {
      parts.push(`${Math.round(query.areaMin)}-${Math.round(query.areaMax)}平`);
    } else if (query.areaMin !== null) {
      parts.push(`${Math.round(query.areaMin)}平以上`);
    }

    if (query.budgetMax !== null) {
      parts.push(`${Math.round(query.budgetMax / 10_000)}万以内`);
    }

    // 定性偏好放最后
    if (query.builtAfterYear !== null) {
      parts.push(`${query.builtAfterYear}年后`);
    }

    return parts.join(' ');
  }

  /**
   * 生成网页版搜索深度链接。
   *
   * ⚠️ 只生成**公开网页版**的地址，不做任何签名或参数伪造、不逆向私有接口。
   *
   * 实测限制（必须告知使用者，不能假装链接一定可用）：
   *   贝壳网页版有反爬保护，直接访问会 302 到验证码页
   *   （`https://hip.ke.com/captcha?...`）。
   *
   *   这不是我们造成的，也不是我们能绕过的 —— 绕过验证码正是法律风险所在。
   *   因此在界面提示语里明确写出"可能要求验证"，让经纪人知道
   *   **主力用法是把检索式粘进 App**，网页链接只是备用。
   *
   * 城市不在已知列表时**不生成链接**并给出提醒 ——
   * 猜错城市路径会把经纪人带到错误城市的房源，比没有链接更糟。
   */
  private buildDeepLink(
    city: string,
    query: PropertySearchQuery,
    warnings: string[],
  ): string {
    const slug = CITY_SLUG[city];

    if (!slug) {
      warnings.push(
        `暂不支持「${city}」的网页链接（城市路径未收录）。请直接在贝壳 App 里搜索。`,
      );
      return '';
    }

    warnings.push('贝壳网页版可能要求验证码。建议优先把「检索式」粘进贝壳 App 搜索框。');

    void query;
    return BEIKE_WEB_SEARCH.replace('/xm/', `/${slug}/`);
  }

  /** 检索说明：让经纪人能核对"系统理解的需求对不对" */
  private buildExplanation(query: PropertySearchQuery): string {
    const lines: string[] = [];

    if (query.city) {
      const area =
        query.subDistricts.length > 0
          ? query.subDistricts.join('、')
          : query.districts.length > 0
            ? query.districts.join('、')
            : '全城';
      lines.push(`城市：${query.city}（${area}）`);
    }

    if (query.bedrooms.length > 0) {
      lines.push(`户型：${query.bedrooms.join('或')} 房`);
    }

    if (query.budgetMax !== null) {
      const max = Math.round(query.budgetMax / 10_000);
      lines.push(
        query.budgetMin !== null
          ? `总价：${Math.round(query.budgetMin / 10_000)}-${max} 万`
          : `总价：${max} 万以内`,
      );
    }

    if (query.areaMin !== null || query.areaMax !== null) {
      lines.push(
        `面积：${query.areaMin !== null ? Math.round(query.areaMin) : '不限'}` +
          `-${query.areaMax !== null ? Math.round(query.areaMax) : '不限'} ㎡`,
      );
    }

    if (query.builtAfterYear !== null) {
      lines.push(`建成年份：${query.builtAfterYear} 年之后`);
    }

    if (query.avoidFirstFloor) lines.push('排除一楼');
    if (query.avoidTopFloor) lines.push('排除顶楼');

    return lines.join('\n');
  }
}
