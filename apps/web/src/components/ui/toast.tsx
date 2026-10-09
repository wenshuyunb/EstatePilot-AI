'use client';

/**
 * Toast 提示。
 *
 * 为什么单独实现而不是引入第三方库：
 *   项目只需要"操作成功/失败提示"这一种能力（如"已复制，可直接粘贴到微信"），
 *   引入完整 toast 库会带进主题、动画、位置等大量本项目用不到的配置。
 *   这里 100 行覆盖全部需求，且样式与设计系统一致。
 *
 * 无障碍：使用 aria-live="polite"，屏幕阅读器会播报提示内容。
 */

import { CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

type ToastVariant = 'success' | 'error' | 'info' | 'loading';

interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  /** 毫秒；0 表示不自动关闭（loading 用） */
  duration: number;
}

interface ToastContextValue {
  toast: (input: {
    variant?: ToastVariant;
    title: string;
    description?: string;
    duration?: number;
  }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const VARIANT_STYLE: Record<ToastVariant, { icon: React.ReactNode; className: string }> = {
  success: {
    icon: <CheckCircle2 className="size-4 text-success" />,
    className: 'border-success/30',
  },
  error: {
    icon: <XCircle className="size-4 text-danger" />,
    className: 'border-danger/30',
  },
  info: {
    icon: <Info className="size-4 text-brand" />,
    className: 'border-brand/30',
  },
  loading: {
    icon: <Loader2 className="size-4 animate-spin text-ink-muted" />,
    className: 'border-border',
  },
};

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = React.useCallback<ToastContextValue['toast']>(
    ({ variant = 'info', title, description, duration }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // 成功与信息 4 秒足够读完；错误给 8 秒（用户可能需要看清原因）；loading 不自动关
      const effectiveDuration = duration ?? (variant === 'error' ? 8000 : variant === 'loading' ? 0 : 4000);

      setItems((previous) => [...previous, { id, variant, title, description, duration: effectiveDuration }]);

      if (effectiveDuration > 0) {
        const timer = setTimeout(() => dismiss(id), effectiveDuration);
        timers.current.set(id, timer);
      }

      return id;
    },
    [dismiss],
  );

  // 组件卸载时清理所有定时器，避免内存泄漏
  React.useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* 容器：右下角堆叠。移动端贴底显示，避免被底部导航遮挡 */}
      <div
        className="pointer-events-none fixed inset-x-3 bottom-20 z-[100] flex flex-col items-end gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-88"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => {
          const style = VARIANT_STYLE[item.variant];
          return (
            <div
              key={item.id}
              className={cn(
                'pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border bg-surface p-3 shadow-lg',
                'animate-fade-in',
                style.className,
              )}
              role={item.variant === 'error' ? 'alert' : 'status'}
            >
              <div className="mt-0.5 shrink-0">{style.icon}</div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug text-ink">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-tertiary">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="shrink-0 rounded p-0.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                aria-label="关闭提示"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** 取 toast 方法。必须在 ToastProvider 内使用。 */
export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return context;
}
