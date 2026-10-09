'use client';

/**
 * 通知中心数据钩子。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  api,
} from '@/lib/api-client';
import type { Notification, NotificationUnreadCount, PaginatedResult } from '@estatepilot/types';

export const notificationKeys = {
  all: ['notifications'] as const,
  // 参数用 object 而不是 Record<string, unknown>：
  // 具体的筛选接口（如 NotificationFilters）没有索引签名，
  // 用 Record 会导致调用处类型不兼容。
  list: (filters: object) => ['notifications', 'list', filters] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
};

export interface NotificationFilters {
  page?: number;
  pageSize?: number;
  type?: string;
  priority?: string;
  isRead?: boolean;
}

/** 通知列表 */
export function useNotifications(filters: NotificationFilters = {}) {
  return useQuery({
    queryKey: notificationKeys.list(filters),
    queryFn: () =>
      api.get<PaginatedResult<Notification>>('/notifications', {
        query: {
          page: filters.page ?? 1,
          pageSize: filters.pageSize ?? 20,
          ...(filters.type ? { type: filters.type } : {}),
          ...(filters.priority ? { priority: filters.priority } : {}),
          ...(filters.isRead !== undefined ? { isRead: filters.isRead } : {}),
        },
      }),
    // 每 60 秒自动刷新一次，保证新机会与降价通知能及时出现
    refetchInterval: 60_000,
  });
}

/**
 * 未读数。
 * 侧边栏与底部导航都依赖它，因此单独抽出来并设置较短的轮询间隔。
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unreadCount,
    queryFn: () => api.get<NotificationUnreadCount>('/notifications/unread-count'),
    refetchInterval: 45_000,
    // 未读数失败（如未登录）不应反复重试打扰用户
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.isAuthError) return false;
      return failureCount < 1;
    },
    staleTime: 20_000,
  });
}

/** 标记单条已读 */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/${id}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/** 全部标记已读 */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/** 删除通知 */
export function useDeleteNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
