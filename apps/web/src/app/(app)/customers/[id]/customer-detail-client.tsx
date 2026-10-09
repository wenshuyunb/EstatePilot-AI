'use client';

/**
 * 客户 360 页面。
 *
 * 布局遵循「上 → 下」的信息流（需求 §72）：
 *   1. 客户头部：是谁、意向多高、多久没联系
 *   2. **微信消息智能处理**：页面的核心操作区，必须最显眼
 *   3. 需求画像：客户当前要什么（含三级预算可视化）
 *   4. 历史分区：需求变化 / 推荐记录 / 消息记录
 */

import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowLeft,
  Calendar,
  Clock,
  Eye,
  Flame,
  Loader2,
  MessageSquare,
  Phone,
  Sparkles,
  TrendingUp,
  UserRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/feedback';
import { WeChatAssistantModule } from '@/components/customer/wechat-assistant-module';
import { RequirementProfileCard } from '@/components/customer/requirement-profile-card';
import { useCustomerDetail } from '@/lib/queries/use-customers';
import {
  useMessageHistory,
  useRecommendationHistory,
  useRequirementHistory,
  useRequirementProfile,
} from '@/lib/queries/use-wechat-assistant';
import { cn } from '@/lib/utils';

const INTENT_VARIANT: Record<string, 'urgent' | 'high' | 'medium' | 'low'> = {
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

const SOURCE_LABEL: Record<string, string> = {
  WECHAT: '微信',
  PHONE: '电话',
  REFERRAL: '转介绍',
  PORTAL: '平台',
  WALK_IN: '到店',
  OTHER: '其他',
};

/** 相对时间显示 */
function relativeTime(value: string | null): string {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

export function CustomerDetailPageClient({ customerId }: { customerId: string }) {
  const [tab, setTab] = useState('requirement');

  const { data: customer, isLoading, isError, error } = useCustomerDetail(customerId);
  const { data: history } = useRequirementHistory(customerId);
  const { data: recommendations } = useRecommendationHistory(customerId);
  const { data: messages } = useMessageHistory(customerId);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !customer) {
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <Card className="border-danger/30">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <UserRound className="size-6 text-ink-muted" />
            <p className="text-sm text-danger">
              {error instanceof Error ? error.message : '客户不存在或无权访问'}
            </p>
            <Link
              href="/customers"
              className="text-xs text-brand underline-offset-2 hover:underline"
            >
              返回客户列表
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const contactedDays = customer.behavior.lastContactAt
    ? Math.floor((Date.now() - new Date(customer.behavior.lastContactAt).getTime()) / 86_400_000)
    : null;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      {/* ================= 返回 ================= */}
      <Link
        href="/customers"
        className="mb-3 inline-flex items-center gap-1 text-xs text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        客户列表
      </Link>

      {/* ================= 客户头部 ================= */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2 p-4">
          {/* 意向分 */}
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'flex size-11 flex-col items-center justify-center rounded-lg',
                (customer.intentScore ?? 0) >= 75
                  ? 'bg-danger-subtle'
                  : (customer.intentScore ?? 0) >= 50
                    ? 'bg-warning-subtle'
                    : 'bg-surface-subtle',
              )}
            >
              <span
                className={cn(
                  'tabular text-lg font-bold leading-none',
                  (customer.intentScore ?? 0) >= 75
                    ? 'text-danger'
                    : (customer.intentScore ?? 0) >= 50
                      ? 'text-warning'
                      : 'text-ink-tertiary',
                )}
              >
                {customer.intentScore ?? '—'}
              </span>
              <span className="text-[9px] leading-tight text-ink-muted">意向分</span>
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-1.5">
                <h1 className="text-base font-semibold text-ink">{customer.name}</h1>
                {customer.intentLevel && (
                  <Badge variant={INTENT_VARIANT[customer.intentLevel] ?? 'low'}>
                    {INTENT_LABEL[customer.intentLevel] ?? customer.intentLevel}
                  </Badge>
                )}
                <Badge variant="outline">{STATUS_LABEL[customer.status] ?? customer.status}</Badge>
              </div>

              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted">
                {customer.phone && (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="size-3" />
                    {customer.phone}
                  </span>
                )}
                <span>来源：{SOURCE_LABEL[customer.source] ?? customer.source}</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  {contactedDays === null
                    ? '从未联系'
                    : contactedDays === 0
                      ? '今天联系过'
                      : `${contactedDays} 天前联系`}
                </span>
              </div>
            </div>
          </div>

          {/* 行为统计 */}
          <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="text-center">
              <p className="tabular text-sm font-semibold text-ink">
                {customer.behavior.eventCount}
              </p>
              <p className="text-[10px] text-ink-muted">行为次数</p>
            </div>
            <div className="text-center">
              <p className="tabular text-sm font-semibold text-ink">
                {customer.behavior.viewingCount}
              </p>
              <p className="text-[10px] text-ink-muted">带看次数</p>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-ink">
                {relativeTime(customer.behavior.lastActiveAt)}
              </p>
              <p className="text-[10px] text-ink-muted">最近活跃</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ================= 核心：微信消息智能处理 ================= */}
      <div className="mt-4">
        <WeChatAssistantModule customerId={customerId} customerName={customer.name} />
      </div>

      {/* ================= 历史分区 =================
          注意：需求画像只在「下方 Tab」里展示一次。
          早期实现在此处也渲染了一份画像，导致同屏出现两块完全相同的内容 ——
          重复信息不仅浪费屏幕，还会让人怀疑数据是否不一致。 */}
      <div className="mt-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="requirement">
              <Sparkles className="size-3" />
              需求画像
            </TabsTrigger>
            <TabsTrigger value="history">
              <TrendingUp className="size-3" />
              需求变化
              {history && history.items.length > 0 && (
                <span className="ml-0.5 text-[10px] text-ink-muted">
                  {history.items.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="recommendations">
              <Eye className="size-3" />
              推荐记录
              {recommendations && recommendations.items.length > 0 && (
                <span className="ml-0.5 text-[10px] text-ink-muted">
                  {recommendations.items.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="messages">
              <MessageSquare className="size-3" />
              消息记录
              {messages && messages.items.length > 0 && (
                <span className="ml-0.5 text-[10px] text-ink-muted">{messages.items.length}</span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ---- 需求画像 ---- */}
          <TabsContent value="requirement">
            <RequirementTabContent customerId={customerId} customer={customer} />
          </TabsContent>

          {/* ---- 需求变化历史 ---- */}
          <TabsContent value="history">
            {!history || history.items.length === 0 ? (
              <EmptyHint text="还没有需求变化记录。粘贴客户微信消息后，系统会自动记录每次变化。" />
            ) : (
              <div className="space-y-2">
                {history.items.map((snapshot) => (
                  <Card key={snapshot.id}>
                    <CardContent className="p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="brand">v{snapshot.version}</Badge>
                        <span className="text-xs text-ink-muted">
                          {new Date(snapshot.createdAt).toLocaleString('zh-CN')}
                        </span>
                        {snapshot.hasOverride && (
                          <Badge variant="high" className="text-[10px]">
                            含客户改口
                          </Badge>
                        )}
                      </div>

                      {snapshot.changes.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {/*
                            ⚠️ key 必须带 index（踩过的真实崩溃）。
                            原先用 `${change.field}-${change.after}` 做 key，
                            但同一字段可能产生**多条变更记录**且 after 值相同或为空：
                              · 一次「区域清洗」会丢弃多个区域 → 产生多条 districts 变更
                              · 某些变更的 after 为 undefined → key 变成 "districts-undefined"
                            结果 React 报 "two children with the same key"
                            （Duplicated keys 会导致子元素被重复或遗漏，属未定义行为）。

                            加 index 后 key 一定唯一。index 在这里是安全的：
                            列表来自快照且整体重渲染，不存在穿插排序的场景。
                          */}
                          {snapshot.changes.map((change, index) => (
                            <li
                              key={`${change.field}-${index}`}
                              className="flex flex-wrap items-baseline gap-x-1.5 text-xs"
                            >
                              <span className="font-medium text-ink">{change.label}</span>
                              <span className="text-ink-muted">{change.before ?? '—'}</span>
                              <span className="text-ink-muted">→</span>
                              <span className="text-ink">{change.after ?? '—'}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ---- 推荐记录 ---- */}
          <TabsContent value="recommendations">
            {!recommendations || recommendations.items.length === 0 ? (
              <EmptyHint text="还没有推荐记录。完成一次微信需求匹配后，这里会显示历史推荐。" />
            ) : (
              <div className="space-y-2">
                {recommendations.items.map((batch) => {
                  const latestReply = batch.replies[0];
                  return (
                    <Card key={batch.id}>
                      <CardContent className="space-y-2 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <RecommendationStatusBadge status={batch.status} />
                          <span className="text-xs text-ink-muted">
                            {new Date(batch.createdAt).toLocaleString('zh-CN')}
                          </span>
                          <span className="text-[11px] text-ink-muted">
                            候选 {batch.candidateCount} → 筛选 {batch.hardFilteredCount} → 推荐{' '}
                            {batch.recommendedPropertyIds.length} 套
                          </span>
                          {batch.durationMs && (
                            <span className="text-[11px] text-ink-muted">
                              耗时 {(batch.durationMs / 1000).toFixed(1)} 秒
                            </span>
                          )}
                        </div>

                        {latestReply && (
                          <details className="group">
                            <summary className="cursor-pointer text-xs text-brand hover:underline">
                              查看当时发送的文案
                            </summary>
                            <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface-subtle p-2.5 text-[11px] leading-relaxed text-ink-secondary">
                              {latestReply.content}
                            </pre>
                          </details>
                        )}

                        {latestReply && (
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="size-3" />
                              复制：{relativeTime(latestReply.copiedAt)}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Eye className="size-3" />
                              确认发送：{relativeTime(latestReply.sentConfirmedAt)}
                            </span>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ---- 消息记录 ---- */}
          <TabsContent value="messages">
            {!messages || messages.items.length === 0 ? (
              <EmptyHint text="还没有粘贴过客户消息。在上方粘贴框里粘贴客户微信内容即可。" />
            ) : (
              <div className="space-y-2">
                {messages.items.map((item) => (
                  <Card key={item.id}>
                    <CardContent className="p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {item.source === 'WECHAT_MANUAL_PASTE' ? '微信粘贴' : item.source}
                        </Badge>
                        <Badge
                          variant={
                            item.parseStatus === 'SUCCESS'
                              ? 'success'
                              : item.parseStatus === 'FAILED'
                                ? 'danger'
                                : 'default'
                          }
                          className="text-[10px]"
                        >
                          {item.parseStatus === 'SUCCESS'
                            ? '已解析'
                            : item.parseStatus === 'FAILED'
                              ? '解析失败'
                              : '待解析'}
                        </Badge>
                        <span className="text-[11px] text-ink-muted">
                          {new Date(item.createdAt).toLocaleString('zh-CN')}
                        </span>
                      </div>

                      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary">
                        {item.rawText}
                      </p>

                      {item.parseError && (
                        <p className="mt-1 text-[11px] text-danger">
                          解析问题：{item.parseError}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/** 需求 Tab 内容 */
function RequirementTabContent({
  customerId,
  customer,
}: {
  customerId: string;
  customer: ReturnType<typeof useCustomerDetail>['data'];
}) {
  // React Query 会去重：这里与外部组件的同名查询共用缓存，不会多发请求
  const { data: profileData, isLoading } = useRequirementProfile(customerId);

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  // 没有通过微信识别过需求 → 显示客户录入时的显性需求
  if (!profileData?.exists) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-xs text-ink-muted">
            还没有通过微信消息识别过需求。上方粘贴一条客户消息后，系统会自动建立需求画像。
          </p>

          {customer && (
            <div className="grid gap-1.5 border-t border-border pt-3 sm:grid-cols-2">
              <p className="text-xs">
                <span className="text-ink-muted">区域：</span>
                <span className="text-ink">
                  {customer.requirement.districts.join('、') || '未填写'}
                </span>
              </p>
              <p className="text-xs">
                <span className="text-ink-muted">户型：</span>
                <span className="text-ink">
                  {customer.requirement.bedrooms.length > 0
                    ? `${customer.requirement.bedrooms.join('/')} 房`
                    : '未填写'}
                </span>
              </p>
              <p className="text-xs">
                <span className="text-ink-muted">预算：</span>
                <span className="text-ink">
                  {customer.requirement.budgetMax
                    ? `${Math.round(customer.requirement.budgetMax / 10_000)} 万以内`
                    : '未填写'}
                </span>
              </p>
              <p className="text-xs">
                <span className="text-ink-muted">备注：</span>
                <span className="text-ink">{customer.requirement.notes ?? '无'}</span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <RequirementProfileCard
      profile={profileData.profile}
      summary={profileData.summary}
    />
  );
}

/** 推荐状态徽标 */
function RecommendationStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'default' | 'brand' | 'success' | 'high' }> = {
    GENERATED: { label: '待发送', variant: 'default' },
    COPIED: { label: '已复制', variant: 'brand' },
    SENT_CONFIRMED: { label: '已发送', variant: 'success' },
    DISCARDED: { label: '已放弃', variant: 'high' },
  };
  const config = map[status] ?? { label: status, variant: 'default' as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

/** 空状态提示 */
function EmptyHint({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="p-6 text-center">
        <p className="text-xs text-ink-muted">{text}</p>
      </CardContent>
    </Card>
  );
}
