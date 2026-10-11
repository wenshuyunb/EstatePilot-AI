'use client';

/**
 * 推荐房源卡片。
 *
 * 产品要求（需求 §28）：每张卡片必须让经纪人**一眼看懂为什么推荐这套**，
 * 同时**诚实标注注意事项**（如超出预算）。
 *
 * 三条硬性规则：
 *   1. 只展示真实存在的字段。subwayText / schoolText 为空时显示"暂无数据"，
 *      绝不用"交通便利""学区优质"这类模糊话术填补（那就是编造）。
 *   2. 必须标注数据来源（贝壳），让经纪人清楚信息的出处。
 *   3. 匹配度要可解释 —— 点击可展开各维度明细，而不是只给一个数字。
 */

import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ImageIcon,
  Loader2,
  MapPin,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PropertyDetailPanel } from '@/components/customer/property-detail-panel';
import { cn } from '@/lib/utils';
import {
  formatPropertyForCopy,
  describeCopyOutput,
  normalizeNumber,
} from '@/lib/property-copy';
import { usePropertyDetail } from '@/lib/queries/use-property-detail';
import {
  describeDecoration,
  describeOrientation,
  formatWan,
  type RecommendedProperty,
} from '@/lib/queries/use-wechat-assistant';

/**
 * 星级渲染。
 *
 * 用实心/空心星号而不是图标库 —— 因为星级需要精确显示到"几颗半"
 * 这类细节用字符最省事，且不会因为图标尺寸导致对齐问题。
 */
function renderStars(stars: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(stars)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

/** 相对时间：把 ISO 时间转成「3 分钟前」这类人类可读形式 */
function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return '刚刚';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;

  return `${Math.floor(days / 30)} 个月前`;
}

interface RecommendedPropertyCardProps {
  property: RecommendedProperty;
  /** 序号（客户在微信里会用"第一套"指代） */
  index: number;
  /**
   * 客户 ID。
   *
   * 用于**按需加载**完整详情：点开卡片时才请求
   * `GET /customers/:id/properties/:externalId/detail`。
   * 这是把一次搜索从 11 次贝壳调用降到 1 次的关键。
   */
  customerId: string;
  /** 是否被经纪人移除 */
  removed?: boolean;
  onRemove?: () => void;
  onPin?: () => void;
  onMoveUp?: () => void;
  /** 是否允许人工控制（生成文案后仍可以调整顺序） */
  showControls?: boolean;
}

export function RecommendedPropertyCard({
  property,
  index,
  customerId,
  removed = false,
  onRemove,
  onPin,
  onMoveUp,
  showControls = true,
}: RecommendedPropertyCardProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  /**
   * 复制状态。
   *
   * `idle` → `copied` 展示"已复制"，2 秒后回到 `idle`。
   * 用状态机而不是布尔值，是为了将来能加 `failed` 分支。
   */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copying, setCopying] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  /**
   * 复制时按需获取详情。
   *
   * ============================================================================
   * 为什么要在这里也取一次（而不是只用列表带回的 fullDetail）
   * ============================================================================
   * 实测：132 套房源里只有 3 套（2%）在列表里带 `fullDetail`，
   * 因为完整详情只在"点开卡片"时才落库。
   * 结果经纪人直接点复制时拿到的是**极简摘要**。
   *
   * 现在后端这个接口**不依赖贝壳**（本地 Property 行即可构造），
   * 因此这里取一次是安全的：不消耗配额、限流时也能返回。
   *
   * `enabled: false` + 手动 `refetch()`：只在点复制时发请求，
   * 不打扰正常浏览。
   */
  const detailQuery = usePropertyDetail(customerId, property.externalId, property.city, false);

  const circledNumbers = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
  const number = circledNumbers[index] ?? `${index + 1}.`;

  const decoration = describeDecoration(property.decoration);
  const orientation = describeOrientation(property.orientation);

  /**
   * 复制完整房源信息到剪贴板。
   *
   * 设计要点：
   *   · 有完整详情 → 输出含小区信息与周边配套的完整文本
   *   · 无完整详情 → 降级用列表摘要，并**如实提示**"未含完整详情"
   *   · 复制失败（浏览器权限/非 HTTPS）→ 明确告知，而不是静默失败
   */
  const handleCopy = async (): Promise<void> => {
    setCopying(true);
    setCopyHint(null);

    try {
      /**
       * 先取详情（后端已改为**不依赖贝壳**：本地 Property 行即可构造）。
       *
       * 取不到也不阻塞 —— 退化为用列表摘要复制。
       */
      let detail = property.fullDetail ?? null;

      if (!detail) {
        try {
          const result = await detailQuery.refetch();

          if (result.data?.detail) {
            detail = result.data.detail;
          }
        } catch {
          // 详情取不到就复制摘要，不中断用户操作
        }
      }

      const text = formatPropertyForCopy({
        community: property.community,
        city: property.city,
        district: property.district,
        subDistrict: property.subDistrict,
        title: property.title,
        totalPrice: property.totalPrice,
        unitPrice: property.unitPrice,
        bedrooms: property.bedrooms,
        livingRooms: property.livingRooms,
        bathrooms: property.bathrooms,
        area: property.area,
        floor: property.floor,
        totalFloors: property.totalFloors,
        buildYear: property.buildYear,
        decoration,
        orientation,
        subwayDistance: property.subwayDistance,
        schoolText: property.schoolText,
        tags: property.tags,
        listingStatus: property.listingStatus,
        fullDetail: detail,
      });

      await navigator.clipboard.writeText(text);

      setCopyState('copied');
      setCopyHint(describeCopyOutput(detail, text));

      // 2 秒后复位，避免按钮一直停在"已复制"
      setTimeout(() => {
        setCopyState('idle');
        setCopyHint(null);
      }, 2000);
    } catch (error) {
      /**
       * ⚠️ 必须把真实错误打出来。
       *
       * 踩过的坑：原实现把所有非 NotAllowedError 都归为"复制失败，请手动选中文本"，
       * 结果线上排查时**完全看不到真实原因** —— 实际错误可能发生在
       * `formatPropertyForCopy` 里（与剪贴板毫无关系），
       * 但提示却把方向引向"剪贴板权限"。
       */
      console.error('[复制房源信息] 失败：', error);

      const isClipboardError = error instanceof DOMException;

      setCopyState('failed');
      setCopyHint(
        !navigator.clipboard
          ? '当前浏览器不支持剪贴板写入，请手动选中文本'
          : isClipboardError && error.name === 'NotAllowedError'
            ? '浏览器拒绝了剪贴板权限，请允许后重试'
            : `复制失败（${error instanceof Error ? error.message : String(error)}）`,
      );

      setTimeout(() => {
        setCopyState('idle');
        setCopyHint(null);
      }, 3000);
    } finally {
      setCopying(false);
    }
  };

  /** 匹配度颜色：90+ 极佳，75+ 良好，60+ 一般 */
  const scoreTone =
    property.matchScore >= 85
      ? 'text-success'
      : property.matchScore >= 70
        ? 'text-brand'
        : 'text-ink-secondary';

  const priceDropped = property.priceChange < 0;
  const priceRaised = property.priceChange > 0;

  return (
    <Card
      className={cn(
        'overflow-hidden transition-opacity',
        removed && 'opacity-40 grayscale',
      )}
    >
      <CardContent className="p-0">
        <div className="flex flex-col sm:flex-row">
          {/* 房源图片 */}
          <div className="relative h-36 w-full shrink-0 bg-surface-subtle sm:h-auto sm:w-40">
            {property.coverImage ? (
              /* 使用原生 img 而不是 next/image：
                 图片来自贝壳 CDN，域名不在 next.config 的允许列表里，
                 用 next/image 需要逐个配置 remotePatterns。这里图片数量少、
                 不需要自动优化，原生 img 更简单可靠。 */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={property.coverImage}
                alt={`${property.community} 房源图片`}
                className="size-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-1 text-ink-muted">
                <ImageIcon className="size-5" />
                <span className="text-[10px]">暂无图片</span>
              </div>
            )}

            {/* 序号角标：与微信文案里的 ①②③ 对应 */}
            <span className="absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-ink/75 text-xs font-semibold text-white">
              {number}
            </span>

            {/* 降价角标 */}
            {priceDropped && (
              <span className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-medium text-white">
                <TrendingDown className="size-2.5" />
                降{Math.abs(Math.round(property.priceChange / 10_000))}万
              </span>
            )}
            {priceRaised && (
              <span className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-medium text-white">
                <TrendingUp className="size-2.5" />
                涨{Math.round(property.priceChange / 10_000)}万
              </span>
            )}
          </div>

          {/* 房源信息 */}
          <div className="min-w-0 flex-1 p-3">
            {/* 标题行 */}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink">{property.community}</h3>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-tertiary">
                  <span className="inline-flex items-center gap-0.5">
                    <MapPin className="size-3" />
                    {/* 区域显示策略：贝壳的详情响应有时不含行政区，但板块是有的。
                        这时只显示板块（"张江"）而不是"区域待确认 张江" —— 
                        后者读起来别扭，而且会让经纪人误以为数据有问题。
                        只有连板块都没有时才提示待确认。 */}
                    {property.district
                      ? `${property.district}${property.subDistrict ? ` ${property.subDistrict}` : ''}`
                      : property.subDistrict
                        ? property.subDistrict
                        : '区域待确认'}
                  </span>
                  {property.buildYear && <span>{property.buildYear} 年建成</span>}
                </p>
              </div>

              {/* 匹配度 */}
              <button
                type="button"
                onClick={() => setShowBreakdown((value) => !value)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-surface-hover"
                aria-expanded={showBreakdown}
                aria-label="查看匹配度明细"
              >
                <span className={cn('tabular font-semibold', scoreTone)}>
                  {property.matchScore}%
                </span>
                <span className="text-ink-muted">匹配度</span>
                <ChevronDown
                  className={cn('size-3 text-ink-muted transition-transform', showBreakdown && 'rotate-180')}
                />
              </button>
            </div>

            {/* 关键数据 */}
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="tabular text-base font-semibold text-ink">
                {formatWan(property.totalPrice)}
              </span>
              {normalizeNumber(property.unitPrice) > 0 && (
                <span className="tabular text-xs text-ink-muted">
                  {Math.round(normalizeNumber(property.unitPrice) / 1000)}千/㎡
                </span>
              )}
              <span className="text-xs text-ink-secondary">
                {property.bedrooms}室
                {property.livingRooms > 0 ? `${property.livingRooms}厅` : ''}
                {property.bathrooms > 0 ? `${property.bathrooms}卫` : ''}
              </span>
              <span className="text-xs text-ink-secondary">{property.area}㎡</span>
              {property.floor !== null && (
                <span className="text-xs text-ink-secondary">
                  {property.floor}/{property.totalFloors ?? '?'} 层
                </span>
              )}
            </div>

            {/* 补充信息：只显示真实存在的字段 */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-tertiary">
              {decoration && <span>{decoration}</span>}
              {orientation && <span>{orientation}</span>}
              {property.subwayText ? (
                <span>{property.subwayText}</span>
              ) : (
                <span className="text-ink-muted">地铁信息暂无数据</span>
              )}
            </div>

            {property.schoolText && (
              <p className="mt-1 line-clamp-1 text-xs text-ink-tertiary">
                学区：{property.schoolText}
              </p>
            )}

            {/* 推荐理由（来自打分，全部基于真实字段）。
                key 用「内容+序号」：推荐理由由多个打分维度拼装，
                存在"预算"与"交通"维度产生相同文案的可能（如都提到"距地铁约 X 米"），
                用内容做 key 会触发 React 重复 key 警告。 */}
            {property.highlights.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {property.highlights.slice(0, 4).map((highlight, index) => (
                  <li
                    key={`${highlight}-${index}`}
                    className="flex items-start gap-1 text-xs text-ink-secondary"
                  >
                    <Check className="mt-0.5 size-3 shrink-0 text-success" />
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* 注意事项：必须诚实展示，不能隐瞒超预算 */}
            {property.cautions.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {property.cautions.slice(0, 3).map((caution, index) => (
                  <li
                    key={`${caution}-${index}`}
                    className="flex items-start gap-1 text-xs text-warning"
                  >
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span>{caution}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* 标签。
                注意 key 用「标签+序号」而不是标签本身：
                后端已做去重，但前端作为渲染层不应假设数据一定干净 ——
                一旦出现重复标签，React 会报 key 冲突并可能导致子元素被丢弃。

                显示策略：贝壳的标签字段里含小区基础信息（楼龄/容积率/物业费）
                与房源标签，一条房源可能多达 30 个。全部铺开会淹没关键信息，
                因此只显示前 8 个，其余用一个「+N」指示器概括。 */}
            {property.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {property.tags.slice(0, 8).map((tag, index) => (
                  <Badge key={`${tag}-${index}`} variant="outline" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
                {property.tags.length > 8 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-ink-muted"
                    title={property.tags.slice(8).join('、')}
                  >
                    +{property.tags.length - 8}
                  </Badge>
                )}
              </div>
            )}

            {/* 匹配度明细（展开） */}
            {showBreakdown && (
              <div className="mt-2 rounded-md border border-border bg-surface-subtle p-2">
                <p className="mb-1.5 text-[11px] font-medium text-ink-secondary">匹配度明细</p>
                <div className="space-y-1">
                  {property.breakdown.map((dimension) => (
                    <div key={dimension.key} className="flex items-start gap-2 text-[11px]">
                      <span className="w-10 shrink-0 text-ink-muted">{dimension.label}</span>
                      <span className="tabular w-12 shrink-0 text-right text-ink">
                        {dimension.score}/{dimension.maxScore}
                      </span>
                      <span className="min-w-0 flex-1 text-ink-tertiary">{dimension.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ================= 数据可信度（Phase 12，需求 §6）=================
                这一块**必须显示，且不能隐藏风险**。
                经纪人在把房源发给客户之前，有权知道这条数据有多可信、是不是实时。

                设计要点：
                  - 与「匹配度」分开显示 —— 一个是"合不合适"，一个是"真不真"，不能混
                  - 星级 + 来源 + 更新时间 + 核验状态 四要素齐全
                  - 状态用颜色区分：可发（绿）/ 需确认（黄）/ 已过期（红） */}
            <div
              className={cn(
                'mt-2 rounded-md border px-2.5 py-1.5',
                property.verificationStatus === 'VERIFIED'
                  ? 'border-success/30 bg-success-subtle'
                  : property.verificationStatus === 'EXPIRED'
                    ? 'border-danger/30 bg-danger-subtle'
                    : 'border-warning/30 bg-warning-subtle',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* 星级 */}
                <span
                  className="text-xs tracking-tight"
                  title={`数据可信度 ${property.dataReliabilityScore}/100`}
                >
                  {renderStars(property.reliabilityStars)}
                </span>

                {/* 来源 */}
                <span className="text-[11px] text-ink-secondary">
                  来源：<span className="text-ink">{property.source}</span>
                </span>

                {/* 更新时间 */}
                <span className="text-[11px] text-ink-muted">
                  更新时间：
                  {property.lastVerifiedAt
                    ? formatRelativeTime(property.lastVerifiedAt)
                    : '未知'}
                </span>

                {/* 核验状态 */}
                <span
                  className={cn(
                    'text-[11px] font-medium',
                    property.verificationStatus === 'VERIFIED'
                      ? 'text-success'
                      : property.verificationStatus === 'EXPIRED'
                        ? 'text-danger'
                        : 'text-warning',
                  )}
                >
                  {property.verificationStatus === 'VERIFIED'
                    ? '在售已确认'
                    : property.verificationStatus === 'EXPIRED'
                      ? '核验已过期'
                      : '需要确认'}
                </span>
              </div>

              {/* 说明文案：诚实展示，不隐瞒 */}
              {property.reliabilityNote && (
                <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">
                  {property.reliabilityNote}
                </p>
              )}
            </div>

            {/* ============ 完整房源信息（Phase 15）============
                产品要求：**不跳转贝壳**，详情与图片在本平台内展示。

                ⚠️ 详情**按需加载**：只有经纪人点开这张卡片时才去取。
                原因（实测容量数据）：
                  列表预取全部详情 → 一次搜索 11 次贝壳调用 → 触发限流（恢复 30 分钟+）
                  按需加载         → 一次搜索 1 次调用
                而限流是按账号计的，多个经纪人共用额度。

                若列表已带回详情（缓存降级时从库中读回），则不重复请求。 */}
            <PropertyDetailPanel
              customerId={customerId}
              externalId={property.externalId}
              city={property.city ?? null}
              initialDetail={property.fullDetail}
              initialImages={property.imageDetails ?? []}
              initialVrUrl={property.vrUrl}
              defaultExpanded={index === 0}
            />

            {/* 底部：排序分说明 + 人工控制 */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
                <span title="综合排序分 = 匹配度×0.7 + 数据可信度×0.2 + 时效性×0.1">
                  综合排序分 {property.finalScore}
                </span>
                {property.previouslyRecommended && (
                  <Badge variant="outline" className="text-[10px]">
                    曾推荐过
                  </Badge>
                )}
              </div>

              {/* 复制结果反馈：明确告诉经纪人复制了什么（含/不含完整详情） */}
              {copyHint && (
                <p
                  className={cn(
                    'text-[10px]',
                    copyState === 'failed' ? 'text-danger' : 'text-success',
                  )}
                >
                  {copyState === 'failed' ? copyHint : `已复制：${copyHint}`}
                </p>
              )}

              <div className="flex items-center gap-1">
                {/**
                 * 复制房源详细信息。
                 *
                 * 产品要求：经纪人在**本平台内**拿到完整房源信息，
                 * 直接粘到微信发给客户，**不需要跳转贝壳**。
                 *
                 * 原先这里是一个跳转 `https://sh.ke.com/...` 的"详情"链接，
                 * 有两个问题：
                 *   1. 域名**硬编码成上海**（sh），厦门房源点开必然 404
                 *   2. 与"不跳转贝壳"的产品要求相悖
                 */}
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={copying}
                  className={cn(
                    'inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
                    copyState === 'copied'
                      ? 'border-success/40 bg-success/10 text-success'
                      : 'border-border text-ink-secondary hover:bg-surface-hover',
                    copying && 'opacity-60',
                  )}
                  title="复制这套房源的完整信息（含小区与周边配套）"
                >
                  {copying ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : copyState === 'copied' ? (
                    <Check className="size-3" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {copying ? '复制中' : copyState === 'copied' ? '已复制' : '复制信息'}
                </button>

                {showControls && (
                  <>
                    {onMoveUp && (
                      <button
                        type="button"
                        onClick={onMoveUp}
                        className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-secondary transition-colors hover:bg-surface-hover"
                        title="上移（调整推荐顺序）"
                      >
                        上移
                      </button>
                    )}
                    {onPin && (
                      <button
                        type="button"
                        onClick={onPin}
                        className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-brand transition-colors hover:bg-brand-subtle"
                        title="置顶"
                      >
                        置顶
                      </button>
                    )}
                    {onRemove && (
                      <button
                        type="button"
                        onClick={onRemove}
                        className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger-subtle"
                        title="从推荐中移除"
                      >
                        移除
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
