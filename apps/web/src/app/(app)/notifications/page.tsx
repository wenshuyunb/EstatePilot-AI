import type { Metadata } from 'next';

export const metadata: Metadata = { title: '通知中心' };

/** 通知中心占位页（下一步实现列表、筛选与已读操作） */
export default function NotificationsPage() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight text-ink">通知中心</h1>
      <p className="mt-1 text-xs text-ink-tertiary">正在实现中</p>
    </div>
  );
}
