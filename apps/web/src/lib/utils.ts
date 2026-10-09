/**
 * 类名合并工具。
 *
 * 为什么需要它：Tailwind 的原子类在组合时会产生冲突
 * （如基础样式写了 px-4，调用处又传 px-6），后者的实际效果取决于 CSS 顺序而非代码顺序。
 * tailwind-merge 会智能识别同组属性并只保留最后一个，避免样式"莫名其妙不生效"。
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
