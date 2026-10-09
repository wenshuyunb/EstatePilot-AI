import type { Metadata, Viewport } from 'next';
import { AppProviders } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'EstatePilot AI · 房产 AI 成交助手',
    template: '%s · EstatePilot AI',
  },
  description:
    '给每一个房地产经纪人配一个懂客户、懂房源、懂销售的 AI 副驾驶。通过客户真实行为 + 房源变化 + AI，让经纪人每天知道最应该联系谁、推荐什么房、下一步怎么推进。',
  applicationName: 'EstatePilot AI',
  // 内部 SaaS 系统不被搜索引擎索引
  robots: { index: false, follow: false },
  formatDetection: {
    // 禁止自动识别手机号并加链接 —— 避免在界面上暴露可点击的号码
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 客户专属页面主要在手机微信内打开，禁止缩放会影响可读性，因此不做限制
  maximumScale: 5,
  themeColor: '#ffffff',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
