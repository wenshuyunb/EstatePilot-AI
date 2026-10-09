'use client';

/**
 * 经纪人工作台（首页）。
 *
 * 这是整个产品的门面。需求文档 §27 与 §55 明确要求：
 *   打开首页第一眼看到的必须是「今天 AI 帮你发现了什么」，
 *   而不是「客户总数多少」。
 *
 * 因此页面结构是：
 *   1. 问候语 + AI 发现摘要（最大的视觉权重）
 *   2. 今日重点客户（为什么联系他 / 建议怎么做 / 什么时候联系）
 *   3. 今日带看 / 待跟进 / 高意向客户
 */

import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarCheck,
  ChevronRight,
  Clock,
  Flame,
  Loader2,
  Phone,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/primitives';
import { useAgentDashboard } from '@/lib/queries/use-dashboard';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/lib/auth-store';

/** 优先级 → 徽标样式映射 */
const PRIORITY_VARIANT: Record<string, 'urgent' | 'high' | 'medium' | 'low'> = {
  URGENT: 'urgent',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

const PRIORITY_LABEL: Record<string, string> = {
  URGENT: '紧急',
  HIGH: '重要',
  MEDIUM: '一般',
  LOW: '低',
};

/** 发现项 → 图标 */
function discoveryIcon(key: string) {
  if (key.includes('price')) return TrendingUp;
  if (key.includes('match')) return Zap;
  if (key.includes('drift') || key.includes('preference')) return AlertTriangle;
  if (key.includes('dormant') || key.includes('reactivat')) return Flame;
  if (key.includes('revisit')) return Clock;
  return Sparkles;
}

export function DashboardPageClient() {
  const { data, isLoading, isError, error, refetch, isFetching } = useAgentDashboard();
  const user = useAuthStore((state) => state.user);

  // ---- 加载态 ----
  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // ---- 错误态 ----
  if (isError || !data) {
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <Card className="border-danger-border bg-danger-subtle">
          <CardContent className="flex flex-col items-start gap-2 pt-4">
            <p className="text-sm font-medium text-danger">工作台数据加载失败</p>
            <p className="text-xs text-danger/80">
              {error instanceof Error ? error.message : '请稍后重试'}
            </p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              重新加载
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasDiscoveries = data.discoveries.some((item) => item.count > 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      {/* ================= 顶部：问候 + AI 发现摘要 ================= */}
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">
              {data.greeting}
              {data.agentName ? `，${data.agentName}` : user?.name ? `，${user.name}` : ''}
            </h1>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              {data.today}
              {isFetching && <span className="ml-2 text-ink-muted">· 正在刷新</span>}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {data.unreadNotificationCount > 0 && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/notifications">
                  <Bell className="size-3.5" />
                  未读通知 {data.unreadNotificationCount}
                </Link>
              </Button>
            )}
            <Button size="sm" asChild>
              <Link href="/ai">
                <Sparkles className="size-3.5" />
                问 AI 助手
              </Link>
            </Button>
          </div>
        </div>

        {/* AI 发现摘要 —— 首页视觉权重最高的区块 */}
        <div className="mt-4 overflow-hidden rounded-lg border border-brand-border bg-gradient-to-br from-brand-subtle to-surface">
          <div className="flex items-center gap-2 border-b border-brand-border/60 px-4 py-2.5">
            <Sparkles className="size-4 text-brand" />
            <p className="text-sm font-semibold text-ink">今天 AI 帮你发现了什么</p>
            {!data.aiAvailable && (
              <Badge variant="warning" className="ml-1">
                AI 未启用（显示规则化结果）
              </Badge>
            )}
          </div>

          {hasDiscoveries ? (
            <div className="grid gap-px bg-brand-border/40 sm:grid-cols-2 lg:grid-cols-3">
              {data.discoveries
                .filter((item) => item.count > 0)
                .map((item) => {
                  const Icon = discoveryIcon(item.key);
                  return (
                    <Link
                      key={item.key}
                      href={item.link}
                      className="group flex items-center gap-3 bg-surface px-4 py-3 transition-colors hover:bg-brand-subtle/50"
                    >
                      <div
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-lg',
                          item.emphasis === 'PRIMARY'
                            ? 'bg-brand text-white'
                            : 'border border-border bg-surface-subtle text-ink-secondary',
                        )}
                      >
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-lg font-semibold leading-tight tabular text-ink">
                          {item.count}
                        </p>
                        <p className="truncate text-xs text-ink-tertiary">{item.label}</p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  );
                })}
            </div>
          ) : (
            <div className="bg-surface px-4 py-6 text-center">
              <p className="text-sm text-ink-secondary">今天暂时没有新的发现</p>
              <p className="mt-1 text-xs text-ink-muted">
                系统会持续监控客户行为与房源变化，有新机会时第一时间通知你。
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ================= 今日重点客户 ================= */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink">今天最值得联系的客户</h2>
            <p className="text-xs text-ink-tertiary">
              按成交可能性排序，每条都说明了为什么现在联系
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/customers">
              全部客户
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>

        {data.priorityCustomers.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm text-ink-secondary">今天没有需要优先联系的客户</p>
              <p className="mt-1 text-xs text-ink-muted">
                当客户产生新的浏览行为或您关注的房源有变化时，这里会出现提醒。
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {data.priorityCustomers.map((customer, index) => (
              <Card key={customer.customerId} className="transition-shadow hover:shadow-sm">
                <CardContent className="flex flex-col gap-3 pt-3 sm:flex-row sm:items-start">
                  {/* 序号：让"先联系谁"一目了然 */}
                  <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-xs font-semibold text-ink-secondary">
                    {index + 1}
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* 第一行：姓名 + 状态 + 优先级 */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={`/customers/${customer.customerId}`}
                        className="text-sm font-semibold text-ink hover:text-brand hover:underline"
                      >
                        {customer.name}
                      </Link>
                      <span className="text-2xs tabular text-ink-muted">{customer.phoneMasked}</span>

                      {customer.topOpportunityPriority && (
                        <Badge
                          variant={PRIORITY_VARIANT[customer.topOpportunityPriority] ?? 'default'}
                        >
                          {PRIORITY_LABEL[customer.topOpportunityPriority] ?? ''}
                        </Badge>
                      )}

                      {/* 意向分：产品核心指标，用显著但不刺眼的方式呈现 */}
                      <span className="ml-auto flex items-center gap-1">
                        <span className="text-2xs text-ink-muted">意向</span>
                        <span
                          className={cn(
                            'text-sm font-semibold tabular',
                            customer.intentScore >= 75
                              ? 'text-danger'
                              : customer.intentScore >= 50
                                ? 'text-warning'
                                : 'text-ink-tertiary',
                          )}
                        >
                          {customer.intentScore}
                        </span>
                      </span>
                    </div>

                    {/* 第二行：为什么联系他 */}
                    <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-ink-secondary">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                      <span>{customer.reason}</span>
                    </p>

                    {/* 第三行：建议怎么做 */}
                    <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-ink-tertiary">
                      <Sparkles className="mt-0.5 size-3 shrink-0 text-brand" />
                      <span>{customer.suggestion}</span>
                    </p>

                    {/* 元信息 */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
                      {customer.suggestedContactBy && (
                        <span className="flex items-center gap-1 font-medium text-warning">
                          <Clock className="size-3" />
                          建议 {customer.suggestedContactBy}
                        </span>
                      )}
                      {customer.daysSinceLastContact !== null && (
                        <span>已 {customer.daysSinceLastContact} 天未联系</span>
                      )}
                      {customer.lastActiveAt && <span>最近活跃 {customer.lastActiveAt}</span>}
                    </div>
                  </div>

                  {/* 操作区 */}
                  <div className="flex shrink-0 gap-1.5 sm:flex-col">
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/customers/${customer.customerId}`}>客户详情</Link>
                    </Button>
                    <Button size="sm" asChild>
                      <Link href={`/ai?customerId=${customer.customerId}`}>
                        <Sparkles className="size-3" />
                        生成话术
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ================= 今日带看 + 待跟进 ================= */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* 今日带看 */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <CalendarCheck className="size-4 text-ink-tertiary" />
              今日带看
            </h2>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/viewings">
                全部
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>

          <Card>
            {data.todayViewings.length === 0 ? (
              <CardContent className="py-6 text-center text-xs text-ink-muted">
                今天没有安排带看
              </CardContent>
            ) : (
              <ul className="divide-y divide-border">
                {data.todayViewings.map((viewing) => (
                  <li key={viewing.viewingId} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="w-11 shrink-0">
                      <p className="text-xs font-semibold tabular text-ink">{viewing.scheduledAt}</p>
                      <p className="text-2xs text-ink-muted">{viewing.propertyCount} 套</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/customers/${viewing.customerId}`}
                        className="truncate text-sm text-ink hover:text-brand hover:underline"
                      >
                        {viewing.customerName}
                      </Link>
                      {viewing.firstPropertyTitle && (
                        <p className="truncate text-2xs text-ink-muted">
                          {viewing.firstPropertyTitle}
                        </p>
                      )}
                    </div>
                    <Button size="xs" variant="ghost" asChild>
                      <Link href={`/viewings/${viewing.viewingId}`}>查看</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        {/* 待跟进 */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Phone className="size-4 text-ink-tertiary" />
              待跟进
            </h2>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/tasks">
                全部
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>

          <Card>
            {data.followUps.length === 0 ? (
              <CardContent className="py-6 text-center text-xs text-ink-muted">
                没有待跟进事项
              </CardContent>
            ) : (
              <ul className="divide-y divide-border">
                {data.followUps.map((item) => (
                  <li key={item.customerId} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/customers/${item.customerId}`}
                          className="truncate text-sm text-ink hover:text-brand hover:underline"
                        >
                          {item.customerName}
                        </Link>
                        {item.overdueDays > 0 && (
                          <Badge variant="danger">超期 {item.overdueDays} 天</Badge>
                        )}
                      </div>
                      <p className="truncate text-2xs text-ink-muted">{item.reason}</p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold tabular text-ink-tertiary">
                      {item.intentScore}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>

      {/* ================= 底部统计（次要信息，弱化展示）================= */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 pt-3">
            <div className="flex size-8 items-center justify-center rounded-md bg-surface-subtle">
              <Users className="size-4 text-ink-tertiary" />
            </div>
            <div>
              <p className="text-lg font-semibold leading-tight tabular text-ink">
                {data.myCustomerCount}
              </p>
              <p className="text-2xs text-ink-muted">我的客户</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 pt-3">
            <div className="flex size-8 items-center justify-center rounded-md bg-danger-subtle">
              <Flame className="size-4 text-danger" />
            </div>
            <div>
              <p className="text-lg font-semibold leading-tight tabular text-ink">
                {data.highIntentCount}
              </p>
              <p className="text-2xs text-ink-muted">高意向客户</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 pt-3">
            <div className="flex size-8 items-center justify-center rounded-md bg-surface-subtle">
              <CalendarCheck className="size-4 text-ink-tertiary" />
            </div>
            <div>
              <p className="text-lg font-semibold leading-tight tabular text-ink">
                {data.todayViewings.length}
              </p>
              <p className="text-2xs text-ink-muted">今日带看</p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* 数据生成时间：便于确认数据新鲜度 */}
      <p className="pb-2 text-center text-2xs text-ink-muted">
        数据生成于 {data.generatedAt} · 耗时 {data.durationMs}ms
        {!data.aiAvailable && ' · 当前未配置 AI 服务，显示规则化分析结果'}
      </p>
    </div>
  );
}
