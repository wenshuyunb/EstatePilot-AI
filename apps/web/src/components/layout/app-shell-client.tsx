'use client';

/**
 * 受保护的应用外壳布局。
 *
 * 认证守卫放在客户端（而不是中间件）的原因：
 * 令牌存在 localStorage，服务端中间件读不到；
 * 用 httpOnly Cookie 可以放中间件，但那需要前后端同域部署。
 * 当前方案：客户端守卫 + 服务端接口二次校验（真正的安全边界在 API 侧）。
 */

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { MobileBottomNav, Sidebar, Topbar } from '@/components/layout/app-shell';
import { useAuthStore } from '@/lib/auth-store';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const initialized = useAuthStore((state) => state.initialized);
  const user = useAuthStore((state) => state.user);
  const bootstrap = useAuthStore((state) => state.bootstrap);

  // 应用启动时用令牌向服务端确认身份
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 未登录跳登录页
  useEffect(() => {
    if (initialized && !user) {
      router.replace('/login');
    }
  }, [initialized, user, router]);

  // 初始化完成前显示加载态，避免闪现受保护内容
  if (!initialized || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-ink-muted">
          <Loader2 className="size-5 animate-spin" />
          <p className="text-xs">正在加载工作台…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh bg-canvas">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* 移动端底部导航会占位，因此加 pb */}
        <main className="flex-1 pb-16 lg:pb-0">{children}</main>
      </div>
      <MobileBottomNav />
    </div>
  );
}
