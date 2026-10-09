'use client';

/**
 * 客户列表。
 *
 * 设计目标（需求 §72）：一眼知道下一步点哪里。
 *   因此列表的每一行都直接给出「客户要什么」与「多久没联系」，
 *   而不是只列姓名和电话 —— 经纪人扫一眼就能决定先联系谁。
 *
 * 进入客户详情后，最显眼的位置是「微信消息智能处理」模块。
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Flame,
  Loader2,
  MessageSquarePlus,
  Search,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/primitives';
import { useCustomers, formatWan, type CustomerListItem } from '@/lib/queries/use-customers';
import { cn } from '@/lib/utils';

/** 意向等级 → 徽标样式 */
const INTENT_VARIANT: Record<string, 'urgent' | 'high' | 'medium' | 'low' | 'default'> = {
  HOT: 'urgent',
  WARM: 'high',
  COOL: 'medium',
  COLD: 'low',
};

const INTENT_LABEL: Record<string, string> = {
  HOT: '高意向',
  WARM: '有意向',
  COOL: '观望',
  COLD: '冷淡',
};

const STATUS_LABEL: Record<string, string> = {
  NEW: '新客户',
  CONTACTED: '已联系',
  VIEWING: '带看中',
  NEGOTIATING: '谈判中',
  DEAL: '已成交',
  LOST: '已流失',
  INVALID: '无效',
};

export function CustomersPageClient() {
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<'intentScore' | 'lastContactAt' | 'lastActiveAt' | 'createdAt'>(
    'intentScore',
  );

  const { data, isLoading, isError, error } = useCustomers({
    page,
    pageSize: 20,
    keyword: keyword || undefined,
    sortBy,
  });

  /** 多久没联系（人类可读） */
  const contactedLabel = useMemo(
    () => (customer: CustomerListItem): { text: string; urgent: boolean } => {
      const value = customer.lastContactAt ?? customer.lastActiveAt;
      if (!value) return { text: '从未联系', urgent: true };

      const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
      if (days === 0) return { text: '今天联系过', urgent: false };
      if (days === 1) return { text: '昨天联系过', urgent: false };
      if (days <= 7) return { text: `${days} 天前联系`, urgent: false };
      if (days <= 30) return { text: `${days} 天未联系`, urgent: days > 14 };
      return { text: `超过 ${Math.floor(days / 30)} 个月未联系`, urgent: true };
    },
    [],
  );

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      {/* 标题区 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">客户管理</h1>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            共 {data?.total ?? 0} 位客户 · 按意向分排序，优先跟进高意向客户
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* 搜索 */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setKeyword(searchInput.trim());
              setPage(1);
            }}
            className="relative"
          >
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索姓名 / 手机 / 微信"
              className="h-8 w-56 pl-7 text-xs"
              aria-label="搜索客户"
            />
          </form>

          {/* 排序 */}
          <select
            value={sortBy}
            onChange={(event) => {
              setSortBy(event.target.value as typeof sortBy);
              setPage(1);
            }}
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
            aria-label="排序方式"
          >
            <option value="intentScore">按意向分</option>
            <option value="lastActiveAt">按最近活跃</option>
            <option value="lastContactAt">按最近联系</option>
            <option value="createdAt">按创建时间</option>
          </select>
        </div>
      </div>

      {/* 列表 */}
      <div className="mt-4 space-y-2">
        {isLoading && (
          <>
            {Array.from({ length: 6 }).map((_, index) => (
              <Card key={index}>
                <CardContent className="p-3">
                  <Skeleton className="h-12 w-full" />
                </CardContent>
              </Card>
            ))}
          </>
        )}

        {isError && (
          <Card className="border-danger/30">
            <CardContent className="flex items-center gap-2 p-4 text-sm text-danger">
              <Flame className="size-4" />
              加载失败：{error instanceof Error ? error.message : '未知错误'}
            </CardContent>
          </Card>
        )}

        {!isLoading && !isError && (data?.items.length ?? 0) === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
              <UserRound className="size-6 text-ink-muted" />
              <p className="text-sm text-ink-secondary">
                {keyword ? `没有找到匹配「${keyword}」的客户` : '暂无客户'}
              </p>
              {keyword && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setKeyword('');
                    setSearchInput('');
                  }}
                >
                  清除搜索
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {data?.items.map((customer) => {
          const contacted = contactedLabel(customer);
          return (
            <Card
              key={customer.id}
              className="transition-colors hover:border-brand/40 hover:bg-surface-hover"
            >
              <CardContent className="p-0">
                <Link
                  href={`/customers/${customer.id}`}
                  className="flex flex-wrap items-center gap-3 p-3"
                >
                  {/* 意向分 */}
                  <div className="flex w-14 shrink-0 flex-col items-center">
                    <span
                      className={cn(
                        'tabular text-lg font-semibold leading-none',
                        (customer.intentScore ?? 0) >= 75
                          ? 'text-danger'
                          : (customer.intentScore ?? 0) >= 50
                            ? 'text-warning'
                            : 'text-ink-tertiary',
                      )}
                    >
                      {customer.intentScore ?? '—'}
                    </span>
                    <span className="mt-0.5 text-[10px] text-ink-muted">意向分</span>
                  </div>

                  {/* 客户信息 */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-ink">{customer.name}</span>
                      {customer.intentLevel && (
                        <Badge variant={INTENT_VARIANT[customer.intentLevel] ?? 'default'}>
                          {INTENT_LABEL[customer.intentLevel] ?? customer.intentLevel}
                        </Badge>
                      )}
                      <Badge variant="outline">
                        {STATUS_LABEL[customer.status] ?? customer.status}
                      </Badge>
                      {customer.hasRequirementProfile && (
                        <Badge variant="brand" className="gap-0.5">
                          <Sparkles className="size-2.5" />
                          已识别需求
                        </Badge>
                      )}
                    </div>

                    <p className="mt-1 truncate text-xs text-ink-secondary">
                      {customer.requirementBrief}
                    </p>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-muted">
                      <span className={cn(contacted.urgent && 'font-medium text-warning')}>
                        {contacted.text}
                      </span>
                      <span>行为 {customer.behaviorEventCount} 次</span>
                      {customer.viewingCount > 0 && <span>带看 {customer.viewingCount} 次</span>}
                      {customer.lastRecommendedAt && (
                        <span className="text-brand">已推过房源</span>
                      )}
                    </div>
                  </div>

                  {/* 操作提示 */}
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden items-center gap-1 text-xs text-brand sm:flex">
                      <MessageSquarePlus className="size-3.5" />
                      粘贴微信消息
                    </span>
                    <ArrowRight className="size-4 text-ink-muted" />
                  </div>
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 分页 */}
      {data && data.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-ink-muted">
            第 {data.page} / {data.totalPages} 页
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-ink-muted">
          <Loader2 className="size-3 animate-spin" />
          正在加载客户…
        </div>
      )}
    </div>
  );
}
