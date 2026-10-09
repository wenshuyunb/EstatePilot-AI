'use client';

/**
 * 应用 Provider 组装。
 *
 * 顺序有讲究：
 *   QueryClientProvider 在最外层（数据层）→ TooltipProvider（UI 基础能力）
 *   → 会话监听（副作用）→ 子组件
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useEffect, useState } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';

/** 会话过期监听：API 客户端在刷新令牌失败时会派发这个事件 */
function SessionWatcher({ children }: { children: React.ReactNode }) {
  const logout = useAuthStore((state) => state.logout);

  useEffect(() => {
    const handler = () => {
      void logout();
    };
    window.addEventListener('estatepilot:session-expired', handler);
    return () => {
      window.removeEventListener('estatepilot:session-expired', handler);
    };
  }, [logout]);

  return <>{children}</>;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  // QueryClient 必须在组件内用 useState 创建，
  // 否则在 SSR 场景下多个请求会共享同一个缓存（导致数据串用）
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 数据新鲜期：房地产数据变化不频繁，30 秒内不重复请求
            staleTime: 30_000,
            // 缓存保留 5 分钟
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // 认证与权限错误不重试（重试也没用，反而拖慢跳转）
              if (error instanceof ApiError) {
                if (error.isAuthError || error.status === 403 || error.status === 404) return false;
              }
              return failureCount < 2;
            },
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <ToastProvider>
          <SessionWatcher>{children}</SessionWatcher>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
