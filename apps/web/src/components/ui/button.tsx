'use client';

/**
 * Button 组件（shadcn/ui 风格）。
 *
 * 变体设计遵循「颜色克制」原则：
 *   default  —— 主操作，全站同一屏内最多出现一个
 *   secondary—— 次要操作（如取消）
 *   outline  —— 中性操作，最常用
 *   ghost    —— 图标按钮、工具栏
 *   danger   —— 破坏性操作（删除）
 *   link     —— 文字链接式按钮
 */

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // 基础样式：统一的焦点态、禁用态与过渡
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-brand text-white hover:bg-brand-hover',
        secondary: 'bg-surface-subtle text-ink border border-border hover:bg-surface-hover',
        outline: 'border border-border bg-surface text-ink hover:bg-surface-hover',
        ghost: 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
        danger: 'bg-danger text-white hover:bg-red-700',
        'danger-outline':
          'border border-danger-border bg-surface text-danger hover:bg-danger-subtle',
        link: 'text-brand underline-offset-4 hover:underline',
        success: 'bg-success text-white hover:bg-emerald-700',
      },
      size: {
        xs: 'h-6 px-2 text-2xs [&_svg]:size-3',
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        default: 'h-8 px-3 text-sm [&_svg]:size-4',
        lg: 'h-10 px-4 text-base [&_svg]:size-4',
        icon: 'size-8 [&_svg]:size-4',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 用子元素作为渲染标签（如包一个 <Link>），保留按钮样式 */
  asChild?: boolean;
  /** 加载中：显示 spinner 并禁用点击 */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';

    // asChild 模式下不能注入额外 DOM（Slot 只接受单个子元素），
    // 因此加载态只在原生 button 下生效
    if (asChild) {
      return (
        <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props}>
          {children}
        </Comp>
      );
    }

    return (
      <button
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
