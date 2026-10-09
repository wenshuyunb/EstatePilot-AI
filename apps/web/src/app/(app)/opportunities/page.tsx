import type { Metadata } from 'next';

export const metadata: Metadata = { title: '销售机会' };

/** 销售机会占位页（下一步实现完整机会列表与处理动作） */
export default function OpportunitiesPage() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight text-ink">销售机会</h1>
      <p className="mt-1 text-xs text-ink-tertiary">正在实现中</p>
    </div>
  );
}
