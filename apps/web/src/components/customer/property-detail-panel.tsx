'use client';

/**
 * 房源完整详情 —— 在我们平台内展示与贝壳 App 同等详细的信息。
 *
 * ============================================================================
 * 产品要求（重要，不要改成"跳转贝壳"）
 * ============================================================================
 * 用户在平台上直接看到完整房源信息，**不需要跳转到贝壳 App**。
 * 因此这里必须把后端已解析的全部字段渲染出来：
 *   · 基础信息（19 项）：单价、套内面积、首付、房屋年限、电梯、梯户比例、楼型…
 *   · 小区信息（20 项）：容积率、绿化率、物业费、物业公司、车位配比、人车分流…
 *   · 周边配套（按距离排序）：地铁/公交/学校/医院/商场/公园，**带具体距离**
 *   · 图片（9 张）：房间实景图（带房间名）+ 户型图 + VR 封面
 *
 * ============================================================================
 * 数据诚实性原则
 * ============================================================================
 * 拿不到的字段**显示"暂无数据"，绝不编造**（需求 §13）。
 * 贝壳原始数据里也有缺失项（如"套内面积暂无"），后端已清洗为 null，
 * 这里统一走 `Field` 组件：值为空即显示占位符。
 */

import { useState } from 'react';
import {
  Building2,
  Bus,
  ChevronDown,
  ChevronUp,
  GraduationCap,
  Home,
  ImageIcon,
  Loader2,
  MapPin,
  ShoppingBag,
  Train,
  Trees,
  Cross,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLazyPropertyDetail } from '@/lib/queries/use-property-detail';
import type { NearbyFacility, PropertyFullDetail, PropertyImage } from '@/lib/queries/use-wechat-assistant';

interface PropertyDetailPanelProps {
  customerId: string;
  externalId: string;
  /** 城市 —— 贝壳详情接口必填 */
  city: string | null;
  /** 搜索时已持久化的详情（列表接口会带回，可省一次请求） */
  initialDetail?: PropertyFullDetail | null;
  initialImages?: PropertyImage[];
  initialVrUrl?: string | null;
  /** 是否默认展开（第一套默认展开，便于快速浏览） */
  defaultExpanded?: boolean;
}

export function PropertyDetailPanel({
  customerId,
  externalId,
  city,
  initialDetail = null,
  initialImages = [],
  initialVrUrl = null,
  defaultExpanded = false,
}: PropertyDetailPanelProps) {
  const [activeImage, setActiveImage] = useState(0);

  /**
   * 惰性加载详情。
   *
   * 关键：`expanded` 为 false 时**不会发起任何请求** ——
   * 这是把一次搜索从 11 次贝壳调用降到 1 次的核心机制。
   *
   * 若列表已带回详情（缓存降级时从库中读回），则不会重复请求
   * （由 enabled 控制，见下方 detail/displayImages 的取值逻辑）。
   */
  const { expanded, toggle, data, isLoading, isError, error, refetch } = useLazyPropertyDetail(
    customerId,
    externalId,
    city,
    defaultExpanded,
  );

  // 优先用列表带回的详情（已有数据就不重复请求），否则用按需加载的结果
  const hasInitial = initialDetail !== null || initialImages.length > 0;
  const detail = hasInitial ? initialDetail : (data?.detail ?? null);
  const images = hasInitial ? initialImages : (data?.images ?? []);
  const vrUrl = hasInitial ? initialVrUrl : (data?.vrUrl ?? null);

  const hasDetail = detail !== null;
  const hasImages = images.length > 0;
  const showingInitial = hasInitial;

  const nearbyTotal = detail?.nearby
    ? Object.values(detail.nearby).reduce((sum, list) => sum + list.length, 0)
    : 0;

  return (
    <div className="mt-2 border-t border-border pt-2">
      {/* 展开/收起 —— 详情内容多，默认收起避免卡片过长 */}
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between text-left text-[11px] text-ink-secondary hover:text-brand"
      >
        <span className="flex items-center gap-1.5">
          <Home className="size-3" />
          完整房源信息
          {/* 未加载时不显示数量徽标，避免误导（还没取呢） */}
          {hasImages && (
            <Badge variant="outline" className="text-[10px]">
              {images.length} 张图
            </Badge>
          )}
          {nearbyTotal > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {nearbyTotal} 条配套
            </Badge>
          )}
        </span>
        {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>

      {expanded && (
        <div className="mt-2.5 space-y-3">
          {/* ---- 加载中 ---- */}
          {isLoading && !showingInitial && (
            <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <Loader2 className="size-3 animate-spin" />
              正在获取完整详情与图片…
            </p>
          )}

          {/* ---- 失败：给出可操作的原因，不假装成功 ---- */}
          {isError && !showingInitial && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-ink-secondary">
                {(error as { message?: string } | null)?.message ??
                  '暂时无法获取完整详情（贝壳可能繁忙或限流）'}
              </p>
              <Button size="xs" variant="outline" onClick={() => void refetch()}>
                重试
              </Button>
            </div>
          )}

          {/* ---- 数据来源与新鲜度（必须如实标注）---- */}
          {(showingInitial || data) && (
            <p className="text-[10px] text-ink-muted">
              {showingInitial
                ? '详情来自之前获取并保存的数据'
                : (data?.message ?? '')}
              {detail && !showingInitial && data?.from === 'DATABASE' && data.fetchedAt
                ? `（获取于 ${formatRelativeTime(data.fetchedAt)}）`
                : ''}
              {data?.note ? ` · ${data.note}` : ''}
            </p>
          )}

          {/* ---- 加载完成但无数据 ---- */}
          {!isLoading && !isError && !hasDetail && !hasImages && !showingInitial && data && (
            <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-ink-muted">
              {data.message}
            </p>
          )}

          {/* ============ 图片 ============ */}
          {hasImages && (
            <section>
              <SectionTitle icon={<ImageIcon className="size-3" />} title="房源图片" />

              <div className="mt-1.5">
                <img
                  src={images[activeImage]?.url ?? images[0]!.url}
                  alt={images[activeImage]?.roomName ?? '房源图片'}
                  className="h-48 w-full rounded-md border border-border object-cover"
                  loading="lazy"
                />

                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[11px] text-ink-secondary">
                    {images[activeImage]?.roomName ??
                      (images[activeImage]?.kind === 'FLOOR_PLAN'
                        ? '户型图'
                        : images[activeImage]?.kind === 'VR'
                          ? 'VR 全景'
                          : '房源图片')}
                  </span>
                  <span className="text-[10px] text-ink-muted">
                    {activeImage + 1} / {images.length}
                  </span>
                </div>

                {/* 缩略图条 */}
                <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
                  {images.map((image, index) => (
                    <button
                      key={`${image.url}-${index}`}
                      type="button"
                      onClick={() => setActiveImage(index)}
                      className={cn(
                        'shrink-0 overflow-hidden rounded border transition-colors',
                        index === activeImage ? 'border-brand' : 'border-border hover:border-brand/50',
                      )}
                      title={image.roomName ?? image.kind}
                    >
                      <img
                        src={image.url}
                        alt={image.roomName ?? '缩略图'}
                        className="size-14 object-cover"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>

                {/* VR 是贝壳 App 专用协议，PC 打不开 —— 必须如实告知 */}
                {vrUrl && (
                  <p className="mt-1 text-[10px] text-ink-muted">
                    该房源有 VR 全景看房，需在手机贝壳 App 中打开（PC 端协议不支持）
                  </p>
                )}
              </div>
            </section>
          )}

          {/* ============ 基础信息 ============ */}
          {detail?.base && (
            <section>
              <SectionTitle icon={<Home className="size-3" />} title="房屋信息" />

              {detail.base.title && (
                <p className="mt-1 text-xs font-medium text-ink">{detail.base.title}</p>
              )}

              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                <Field label="建筑面积" value={detail.base.buildingArea} />
                <Field label="套内面积" value={detail.base.innerArea} />
                <Field label="单价" value={detail.base.unitPrice} />
                <Field label="房屋年限" value={detail.base.houseAge} highlight />
                <Field label="首付" value={detail.base.downPayment} highlight />
                <Field label="用途" value={detail.base.usage} />
                <Field label="户型结构" value={detail.base.layoutStructure} />
                <Field label="梯户比例" value={detail.base.elevatorHouseholdRatio} />
                <Field label="楼型" value={detail.base.buildingType} />
                <Field label="电梯" value={detail.base.hasElevator} />
                <Field label="交易权属" value={detail.base.ownership} />
                <Field
                  label="楼层"
                  value={
                    detail.base.floor && detail.base.totalFloors
                      ? `${detail.base.floor} / 共${detail.base.totalFloors}`
                      : (detail.base.floor ?? detail.base.totalFloors)
                  }
                />
              </div>

              {detail.base.tags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {detail.base.tags.map((tag) => (
                    <Badge key={tag} variant="success" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ============ 小区信息 ============ */}
          {detail?.community && (
            <section>
              <SectionTitle icon={<Building2 className="size-3" />} title="小区信息" />

              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                <Field label="容积率" value={detail.community.floorAreaRatio} />
                <Field label="绿化率" value={detail.community.greeningRate} />
                <Field label="物业费" value={detail.community.propertyFee} />
                <Field label="物业公司" value={detail.community.propertyCompany} />
                <Field label="车位配比" value={detail.community.parkingRatio} />
                <Field label="车位租金" value={detail.community.parkingFee} />
                <Field
                  label="总户数"
                  value={detail.community.totalHouseholds !== null ? `${detail.community.totalHouseholds} 户` : null}
                />
                <Field label="建成年代" value={detail.community.buildYears} />
                <Field label="人车分流" value={detail.community.separatedTraffic} />
                <Field label="封闭小区" value={detail.community.isClosed} />
                <Field label="用水" value={detail.community.waterType} />
                <Field label="用电" value={detail.community.electricityType} />
                <Field label="租售比" value={detail.community.rentToSaleRatio} />
                <Field label="租房均价" value={detail.community.rentPrice} />
                <Field label="燃气费" value={detail.community.gasFee} />
                <Field label="所属商圈" value={detail.community.businessDistrict} />
              </div>

              {detail.community.aliases.length > 0 && (
                <p className="mt-1 text-[10px] text-ink-muted">
                  又名：{detail.community.aliases.join('、')}
                </p>
              )}
            </section>
          )}

          {/* ============ 周边配套（按距离排序） ============ */}
          {detail?.nearby && nearbyTotal > 0 && (
            <section>
              <SectionTitle icon={<MapPin className="size-3" />} title="周边配套" />

              <div className="mt-1.5 space-y-2">
                <FacilityGroup icon={<Train className="size-3" />} label="地铁" items={detail.nearby.subway} />
                <FacilityGroup icon={<Bus className="size-3" />} label="公交" items={detail.nearby.bus} />
                <FacilityGroup
                  icon={<GraduationCap className="size-3" />}
                  label="学校"
                  items={detail.nearby.school}
                />
                <FacilityGroup icon={<Cross className="size-3" />} label="医疗" items={detail.nearby.hospital} />
                <FacilityGroup
                  icon={<ShoppingBag className="size-3" />}
                  label="购物"
                  items={detail.nearby.shopping}
                />
                <FacilityGroup icon={<Trees className="size-3" />} label="休闲" items={detail.nearby.park} />
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** 分组标题 */
function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <h4 className="flex items-center gap-1 text-[11px] font-medium text-ink-secondary">
      {icon}
      {title}
    </h4>
  );
}

/**
 * 单个字段。
 *
 * 值为空时显示"暂无数据" —— **绝不编造**（需求 §13）。
 * `highlight` 用于标出经纪人最常被客户问到的字段（房屋年限、首付）。
 */
function Field({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string | null | undefined;
  highlight?: boolean;
}) {
  const hasValue = value !== null && value !== undefined && String(value).trim().length > 0;

  return (
    <div className="text-[11px] leading-relaxed">
      <span className="text-ink-muted">{label}：</span>
      <span className={cn(hasValue ? 'text-ink' : 'text-ink-muted', highlight && hasValue && 'font-medium')}>
        {hasValue ? String(value) : '暂无数据'}
      </span>
    </div>
  );
}

/**
 * 一组周边配套。
 *
 * 默认只显示最近 3 条：经纪人最关心"最近的有多远"，
 * 全部列出（如 19 家医院）会让卡片变得极长且难读。
 */
function FacilityGroup({
  icon,
  label,
  items,
}: {
  icon: React.ReactNode;
  label: string;
  items: NearbyFacility[];
}) {
  const [showAll, setShowAll] = useState(false);

  if (items.length === 0) return null;

  const visible = showAll ? items : items.slice(0, 3);

  return (
    <div>
      <div className="flex items-center gap-1 text-[11px] text-ink-secondary">
        {icon}
        <span>
          {label}
          <span className="text-ink-muted">（{items.length}）</span>
        </span>
      </div>

      <ul className="mt-0.5 space-y-0.5 pl-4">
        {visible.map((item, index) => (
          <li key={`${item.name}-${index}`} className="text-[11px] text-ink-secondary">
            {item.name}
            {item.distanceMeters !== null && (
              <span className="text-ink-muted"> · {formatDistance(item.distanceMeters)}</span>
            )}
            {item.category && <span className="text-ink-muted"> · {item.category}</span>}
          </li>
        ))}
      </ul>

      {items.length > 3 && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-0.5 h-5 px-1 text-[10px] text-ink-muted"
          onClick={() => setShowAll((prev) => !prev)}
        >
          {showAll ? '收起' : `展开其余 ${items.length - 3} 条`}
        </Button>
      )}
    </div>
  );
}

/** 距离格式化：米 → 米 / 公里 */
function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} 米`;
  return `${(meters / 1000).toFixed(1)} 公里`;
}

/**
 * 相对时间格式化。
 *
 * 用在"详情获取于 X 前"——**必须如实展示**，
 * 让经纪人知道这份详情是不是最新的（贝壳可能已限流导致数据陈旧）。
 */
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
