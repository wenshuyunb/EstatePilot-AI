import { AppShell } from '@/components/layout/app-shell-client';

/**
 * 受保护路由组布局。
 *
 * 用路由组 (app) 而不是在每个页面里重复写守卫：
 *   (app)/dashboard、  (app)/customers、 (app)/properties ...
 * 全部自动获得认证保护与统一外壳。
 *
 * 注意：这里的目录名带括号，不会出现在 URL 中。
 */
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
