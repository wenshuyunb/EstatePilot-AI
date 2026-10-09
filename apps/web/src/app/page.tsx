import { redirect } from 'next/navigation';

/**
 * 根路由：直接进入工作台。
 *
 * 未登录时由 (app) 布局守卫重定向到 /login，
 * 因此这里不需要做认证判断（避免重复逻辑）。
 */
export default function RootPage() {
  redirect('/dashboard');
}
