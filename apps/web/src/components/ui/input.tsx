import * as React from 'react';
import { cn } from '@/lib/utils';

/** 输入框。表单场景下与 Label + 错误提示配合使用 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-8 w-full rounded-md border border-border bg-surface px-2.5 py-1 text-sm text-ink transition-colors',
        'placeholder:text-ink-muted',
        'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/15',
        'disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted',
        'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

/** 多行文本域 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[72px] w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-ink transition-colors',
      'placeholder:text-ink-muted',
      'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/15',
      'disabled:cursor-not-allowed disabled:bg-surface-subtle',
      'aria-[invalid=true]:border-danger',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

/** 原生 select。需要更复杂交互（搜索、多选）时用 Radix Select */
const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex h-8 w-full appearance-none rounded-md border border-border bg-surface bg-[length:16px] bg-[right_6px_center] bg-no-repeat px-2.5 pr-7 text-sm text-ink transition-colors',
      // 内联 SVG 箭头，避免额外请求
      "bg-[url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
      'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/15',
      'disabled:cursor-not-allowed disabled:bg-surface-subtle',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
NativeSelect.displayName = 'NativeSelect';

export { Input, Textarea, NativeSelect };
