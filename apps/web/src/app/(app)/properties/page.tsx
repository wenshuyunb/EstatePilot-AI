import type { Metadata } from 'next';

export const metadata: Metadata = { title: '房源库' };

/** 房源库占位页（下一步实现完整列表与详情） */
export default function PropertiesPage() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight text-ink">房源库</h1>
      <p className="mt-1 text-xs text-ink-tertiary">正在实现中</p>
    </div>
  );
}
