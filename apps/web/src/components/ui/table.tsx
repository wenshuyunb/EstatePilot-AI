import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Table 组件。
 *
 * 列表页的核心容器。样式取向：紧凑行高（便于一屏看更多客户）、
 * 表头浅灰底、行悬停高亮、数字列右对齐并使用等宽数字。
 */

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-x-auto">
      <table
        ref={ref}
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('border-b border-border bg-surface-subtle', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('divide-y divide-border', className)} {...props} />
));
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn('transition-colors hover:bg-surface-subtle data-[state=selected]:bg-brand-subtle', className)}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-8 whitespace-nowrap px-3 text-left align-middle text-2xs font-semibold uppercase tracking-wide text-ink-tertiary',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-3 py-2 align-middle text-ink-secondary', className)} {...props} />
));
TableCell.displayName = 'TableCell';

/** 空状态：列表无数据时的友好提示，而不是空白表格 */
function TableEmpty({
  colSpan,
  title,
  description,
  action,
}: {
  colSpan: number;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-12">
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-sm font-medium text-ink-secondary">{title}</p>
          {description && <p className="max-w-sm text-xs text-ink-muted">{description}</p>}
          {action && <div className="mt-1">{action}</div>}
        </div>
      </td>
    </tr>
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty };
