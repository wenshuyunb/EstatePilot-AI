/**
 * Tailwind CSS 4 配置。
 *
 * Tailwind 4 采用「CSS 优先」配置：设计令牌（颜色 / 圆角 / 字体）写在 globals.css 的
 * @theme 块里，这个文件只保留需要 JS 参与的部分（content 扫描路径与插件）。
 *
 * 设计取向（依据需求文档 §38）：
 *   参考 Linear / Stripe Dashboard / HubSpot —— 现代、克制、信息密度高，
 *   不要传统 ERP 风格，不要大量渐变与炫光。
 */

import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
    // 复用 workspace 内共享包中的类名（若后续抽出 UI 包）
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
