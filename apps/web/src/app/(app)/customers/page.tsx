import type { Metadata } from 'next';
import { CustomersPageClient } from './customers-page-client';

export const metadata: Metadata = { title: '客户管理' };

/**
 * 客户列表页。
 *
 * 服务端组件只负责元数据与渲染客户端组件；
 * 数据获取在客户端完成（令牌存在 localStorage，服务端拿不到）。
 */
export default function CustomersPage() {
  return <CustomersPageClient />;
}
