'use client';

/**
 * 官方平台检索方案查询钩子。
 *
 * 与房源搜索的区别：本钩子**秒级返回**（纯本地条件翻译，
 * 不查贝壳、不等网络），因此不需要长超时或轮询。
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface PlatformSearchPlan {
  platform: 'BEIKE';
  city: string;
  districts: string[];
  bedrooms: number[];
  priceMin: number | null;
  priceMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  /** 可直接粘进贝壳 App 搜索框的中文检索式 */
  searchText: string;
  /** 网页版入口（实测可能要求验证码，仅作备用） */
  deepLink: string;
  /** 条件来源说明，供经纪人核对 */
  explanation: string;
  warnings: string[];
}

export interface PlatformSearchPlanResponse {
  plan: PlatformSearchPlan | null;
  message: string;
}

export const platformSearchKeys = {
  all: ['platform-search-plan'] as const,
  detail: (customerId: string) => [...platformSearchKeys.all, customerId] as const,
};

/**
 * 取检索方案。
 *
 * @param enabled 没有需求画像时不请求（避免无意义的 400/空结果）
 */
export function usePlatformSearchPlan(customerId: string, enabled: boolean) {
  return useQuery({
    queryKey: platformSearchKeys.detail(customerId),
    queryFn: () =>
      api.get<PlatformSearchPlanResponse>(
        `/customers/${customerId}/platform-search-plan`,
      ),
    enabled: Boolean(customerId) && enabled,
    // 需求变化后要重新生成，因此缓存时间短
    staleTime: 10_000,
  });
}
