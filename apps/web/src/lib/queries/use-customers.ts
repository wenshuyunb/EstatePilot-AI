'use client';

/**
 * 客户列表查询钩子。
 *
 * 列表带筛选与分页，因此把参数拼进 queryKey —— 这样切换筛选条件会
 * 自动走缓存而不是重复请求，同时不同筛选条件的结果互相独立。
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface CustomerListItem {
  id: string;
  name: string;
  gender: string;
  phone: string | null;
  status: string;
  intentLevel: string | null;
  intentScore: number | null;
  intentScoreLevel: string | null;
  requirementBrief: string;
  budgetMin: number | null;
  budgetMax: number | null;
  preferredDistricts: string[];
  bedrooms: number[];
  lastContactAt: string | null;
  lastActiveAt: string | null;
  nextFollowUpAt: string | null;
  behaviorEventCount: number;
  viewingCount: number;
  hasRequirementProfile: boolean;
  lastRecommendedAt: string | null;
}

export interface CustomerDetail {
  id: string;
  name: string;
  gender: string;
  phone: string | null;
  wechat: string | null;
  status: string;
  source: string;
  intentLevel: string | null;
  intentScore: number | null;
  intentScoreLevel: string | null;
  requirement: {
    city: string | null;
    districts: string[];
    communities: string[];
    bedrooms: number[];
    livingRooms: number | null;
    budgetMin: number | null;
    budgetMax: number | null;
    areaMin: number | null;
    areaMax: number | null;
    decorationPreference: string | null;
    floorPreference: string | null;
    propertyAgePreference: string | null;
    schoolPreference: string | null;
    subwayDistanceMax: number | null;
    purchasePurpose: string | null;
    paymentMethod: string | null;
    purchaseTimeline: string | null;
    notes: string | null;
  };
  behavior: {
    eventCount: number;
    viewingCount: number;
    lastActiveAt: string | null;
    lastContactAt: string | null;
    nextFollowUpAt: string | null;
    preferenceDriftScore: number | null;
  };
}

export const customerKeys = {
  list: (params: Record<string, unknown>) => ['customers', 'list', params] as const,
  detail: (id: string) => ['customers', 'detail', id] as const,
};

/** 客户列表 */
export function useCustomers(params: {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: string;
  intentLevel?: string;
  mineOnly?: boolean;
  sortBy?: 'intentScore' | 'lastContactAt' | 'lastActiveAt' | 'createdAt';
}) {
  return useQuery({
    queryKey: customerKeys.list(params),
    queryFn: () =>
      api.get<{
        items: CustomerListItem[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
      }>('/customers', { query: params }),
    staleTime: 30_000,
  });
}

/** 客户基本信息 */
export function useCustomerDetail(id: string) {
  return useQuery({
    queryKey: customerKeys.detail(id),
    queryFn: () => api.get<CustomerDetail>(`/customers/${id}`),
    enabled: Boolean(id),
  });
}

/** 万元格式化（列表与详情共用） */
export function formatWan(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const wan = amount / 10_000;
  return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
}
