import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Badge 组件。
 *
 * 用于状态标签、优先级标记、匹配度等。
 * 语义色变体只用于表达状态，不做装饰（设计原则：颜色克制）。
 */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-tight whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface-subtle text-ink-secondary',
        brand: 'border-brand-border bg-brand-subtle text-brand',
        success: 'border-success-border bg-success-subtle text-success',
        warning: 'border-warning-border bg-warning-subtle text-warning',
        danger: 'border-danger-border bg-danger-subtle text-danger',
        info: 'border-info-border bg-info-subtle text-info',
        // 机会优先级专用
        urgent: 'border-danger-border bg-urgent-subtle text-urgent',
        high: 'border-orange-200 bg-high-subtle text-high',
        medium: 'border-brand-border bg-medium-subtle text-medium',
        low: 'border-border bg-low-subtle text-low',
        // 实心变体，用于需要强视觉的位置（如匹配度分数）
        solid: 'border-transparent bg-ink text-white',
        outline: 'border-border-strong bg-transparent text-ink-secondary',
      },
      size: {
        sm: 'px-1 py-0 text-2xs',
        default: 'px-1.5 py-0.5 text-2xs',
        lg: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

function Badge({ className, variant, size, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : 'span';
  return <Comp className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
