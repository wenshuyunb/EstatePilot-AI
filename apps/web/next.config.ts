import type { NextConfig } from 'next';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // 独立产物：Docker 生产镜像只需拷贝 .next/standalone + static，镜像体积小很多
  output: 'standalone',

  // monorepo 下需要显式声明追踪根目录，否则 standalone 会打错依赖
  outputFileTracingRoot: process.cwd().replace(/[\\/]apps[\\/]web$/, ''),

  // 类型检查在构建时执行（发现问题早暴露）。
  // 注意：Next.js 16 已移除内置 ESLint 集成，因此这里不再有 eslint 选项，
  // lint 由独立的 CI 步骤负责（pnpm lint）。
  typescript: { ignoreBuildErrors: false },

  // 服务端渲染时把 API 请求代理到后端，避免浏览器跨域
  async rewrites() {
    return [
      {
        source: '/api/backend/:path*',
        destination: `${apiBaseUrl}/api/v1/:path*`,
      },
    ];
  },

  // 占位图来自 picsum.photos，需要在 next/image 里放行
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'fastly.picsum.photos' },
    ],
  },

  // 安全响应头（Nginx 层也会配一份，这里是纵深防御）
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            // 明确禁用不需要的敏感能力 —— 尤其是地理位置与摄像头，
            // 本项目承诺不采集客户手机数据
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
