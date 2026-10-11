'use client';

/**
 * 按需加载房源完整详情的钩子。
 *
 * ============================================================================
 * 为什么按需而不是随列表返回
 * ============================================================================
 * 实测调用量分析：
 *   · 列表预取全部详情：一次搜索 11 次贝壳调用 → 约 220 次/天/人
 *   · 列表只用摘要 + 详情按需：一次搜索 1 次调用 → 约 30 次/天/人
 *
 * 而实测 11 次密集调用即触发贝壳限流，**恢复需 30 分钟以上**，
 * 且限流按账号计 —— 多个经纪人共用同一份额度。
 *
 * 因此详情改为"点开才取"。后端有内存缓存 + 数据库持久化，
 * 同一套房源**反复展开不产生额外调用**。
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api-client';
import type { PropertyFullDetail, PropertyImage } from '@/lib/queries/use-wechat-assistant';

export interface PropertyDetailResponse {
  detail: PropertyFullDetail | null;
  images: PropertyImage[];
  vrUrl: string | null;
  /**
   * 数据来源。
   *
   * `LOCAL_PROPERTY` 是**不依赖贝壳**的来源 —— 后端用数据库 `Property` 表
   * 自带字段构造（覆盖率 100%）。贝壳限流时详情功能因此不会失效，
   * 只是字段比完整详情少（没有容积率/物业费/周边配套明细）。
   */
  from: 'MEMORY_CACHE' | 'DATABASE' | 'LOCAL_PROPERTY' | 'BEIKE_LIVE' | 'NONE';
  fetchedAt: string | null;
  /** 新鲜度提示（如"这是 X 小时前获取的详情"） */
  note: string | null;
  message: string;
}

export const propertyDetailKeys = {
  all: ['property-detail'] as const,
  one: (customerId: string, externalId: string) =>
    [...propertyDetailKeys.all, customerId, externalId] as const,
};

/**
 * 加载房源详情。
 *
 * @param enabled 仅在用户**展开**卡片时才置 true —— 这是省配额的关键。
 *                `false` 时不会发起任何请求。
 */
export function usePropertyDetail(
  customerId: string,
  externalId: string,
  city: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: propertyDetailKeys.one(customerId, externalId),
    queryFn: () =>
      api.get<PropertyDetailResponse>(
        `/customers/${customerId}/properties/${externalId}/detail`,
        {
          query: city ? { city } : undefined,
          // 详情可能触发贝壳实时调用（2-3 秒×2），给足超时
          timeoutMs: 30_000,
        },
      ),
    enabled: enabled && Boolean(customerId) && Boolean(externalId),
    // 详情在服务端已缓存 30 分钟，前端不必频繁重取
    staleTime: 5 * 60_000,
    // 失败不自动重试：贝壳限流时重试只会加剧，让用户手动点
    retry: false,
  });
}

/** 习惯用法：管理"是否展开"状态 + 惰性加载 */
export function useLazyPropertyDetail(
  customerId: string,
  externalId: string,
  city: string | null,
  defaultExpanded = false,
) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const query = usePropertyDetail(customerId, externalId, city, expanded);

  return {
    expanded,
    toggle: () => setExpanded((prev) => !prev),
    ...query,
  };
}
