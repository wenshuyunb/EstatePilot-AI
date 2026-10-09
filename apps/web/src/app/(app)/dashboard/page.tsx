import type { Metadata } from 'next';
import { DashboardPageClient } from './dashboard-page-client';

export const metadata: Metadata = {
  title: '工作台',
  description: '今天 AI 帮你发现了什么 —— 最值得联系的客户、新出现的成交机会与待办事项',
};

/**
 * 工作台页面。
 *
 * 数据在客户端获取（useAgentDashboard）而不是服务端渲染，原因：
 * 令牌存在 localStorage，服务端拿不到；
 * 且工作台需要 60 秒自动刷新，客户端轮询更自然。
 */
export default function DashboardPage() {
  return <DashboardPageClient />;
}
