'use client';

/**
 * Dashboard 数据钩子。
 *
 * 工作台是产品的门面，数据变化相对频繁（新机会、新行为），
 * 因此设置 60 秒自动刷新，并在窗口重新聚焦时不额外刷新（避免打断阅读）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AgentDashboard, StoreDashboard } from '@estatepilot/types';

export const dashboardKeys = {
  agent: ['dashboard', 'agent'] as const,
  store: (storeId?: string) => ['dashboard', 'store', storeId ?? 'current'] as const,
};

/** 经纪人工作台 */
export function useAgentDashboard() {
  return useQuery({
    queryKey: dashboardKeys.agent,
    queryFn: () => api.get<AgentDashboard>('/dashboard'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** 门店驾驶舱 */
export function useStoreDashboard(storeId?: string) {
  return useQuery({
    queryKey: dashboardKeys.store(storeId),
    queryFn: () =>
      api.get<StoreDashboard>('/dashboard/store', {
        query: storeId ? { storeId } : undefined,
      }),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}

/** 处理机会（标记为已跟进 / 已忽略） */
export function useHandleOpportunity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      status,
      note,
    }: {
      id: string;
      status: 'ACKNOWLEDGED' | 'ACTIONED' | 'DISMISSED';
      note?: string;
    }) => api.patch(`/opportunities/${id}`, { status, handleNote: note }),

    onSuccess: () => {
      // 机会状态变化会影响工作台、机会列表与通知，全部失效
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.agent });
      void queryClient.invalidateQueries({ queryKey: ['opportunities'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
