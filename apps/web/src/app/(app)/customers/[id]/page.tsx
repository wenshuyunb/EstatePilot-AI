import type { Metadata } from 'next';
import { CustomerDetailPageClient } from './customer-detail-client';

export const metadata: Metadata = { title: '客户详情' };

/**
 * 客户 360 页面。
 *
 * 页面结构（需求 §26、§48、§72）：
 *   上：客户基本信息（一眼看清是谁、意向多高）
 *   中：**微信消息智能处理**（页面最显眼的操作入口）
 *   下：需求画像 / 需求历史 / 推荐历史 / 消息历史
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CustomerDetailPageClient customerId={id} />;
}
