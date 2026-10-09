'use client';

/**
 * 客户需求画像卡片。
 *
 * 核心是**三级预算的视觉化**（需求 §8）：
 *   理想 500万 ─── 最高 550万 ─── 极限 600万
 *
 * 为什么要画出来：这是产品最关键的信息。经纪人需要一眼看出
 * "客户心里想花 500 万，能接受到 550 万，特别满意才会考虑 600 万"，
 * 而不是只看到一个"预算上限"。这直接决定了他怎么向客户介绍房源。
 */

import { Sparkles, Target } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  describePriority,
  formatWan,
  type RequirementProfile,
} from '@/lib/queries/use-wechat-assistant';

interface RequirementProfileCardProps {
  profile: RequirementProfile;
  /** 后端生成的中文摘要 */
  summary: string;
  /** 抽取来源：AI 或内置规则 */
  extractionSource?: 'AI' | 'RULES';
  /** 置信度 0～1 */
  confidence?: number;
  /** 缺失的关键字段 */
  missingCriticalFields?: string[];
  /** 是否紧凑模式（放在侧栏时） */
  compact?: boolean;
}

/** 三级预算可视化条 */
function BudgetBar({ profile }: { profile: RequirementProfile }) {
  const target = profile.budgetTarget;
  const normalMax = profile.budgetNormalMax;
  const stretchMax = profile.budgetStretchMax;

  // 完全没有预算信息
  if (target === null && normalMax === null && stretchMax === null) {
    return (
      <div className="rounded-md border border-dashed border-border p-2.5 text-center">
        <p className="text-xs text-ink-muted">客户尚未说明预算</p>
      </div>
    );
  }

  // 计算三个刻度在条上的相对位置（用最大值作为 100%）
  const maxValue = stretchMax ?? normalMax ?? target ?? 1;
  const targetPercent = target !== null ? (target / maxValue) * 100 : 0;
  const normalPercent = normalMax !== null ? (normalMax / maxValue) * 100 : targetPercent;

  return (
    <div className="space-y-2">
      {/* 三段式进度条：绿（理想内）→ 黄（可接受）→ 橙（极限） */}
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-subtle">
        <div
          className="absolute inset-y-0 left-0 bg-success/70"
          style={{ width: `${targetPercent}%` }}
        />
        {normalMax !== null && (
          <div
            className="absolute inset-y-0 bg-warning/60"
            style={{ left: `${targetPercent}%`, width: `${Math.max(0, normalPercent - targetPercent)}%` }}
          />
        )}
        {stretchMax !== null && (
          <div
            className="absolute inset-y-0 bg-danger/45"
            style={{ left: `${normalPercent}%`, width: `${Math.max(0, 100 - normalPercent)}%` }}
          />
        )}
      </div>

      {/* 三个刻度值 */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {target !== null && (
          <div>
            <span className="text-[10px] text-ink-muted">理想预算</span>
            <p className="tabular text-sm font-semibold text-success">{formatWan(target)}</p>
          </div>
        )}
        {normalMax !== null && (
          <div>
            <span className="text-[10px] text-ink-muted">最高可接受</span>
            <p className="tabular text-sm font-semibold text-warning">{formatWan(normalMax)}</p>
          </div>
        )}
        {stretchMax !== null && (
          <div>
            <span className="text-[10px] text-ink-muted">极限（特别满意）</span>
            <p className="tabular text-sm font-semibold text-danger">{formatWan(stretchMax)}</p>
          </div>
        )}
        {profile.budgetStrictMax && (
          <Badge variant="urgent" className="self-center">
            超出上限不看
          </Badge>
        )}
      </div>
    </div>
  );
}

/** 需求条目：标签 + 值，无值时不渲染（避免堆积"未明确"） */
function Item({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

export function RequirementProfileCard({
  profile,
  summary,
  extractionSource,
  confidence,
  missingCriticalFields,
  compact = false,
}: RequirementProfileCardProps) {
  const districts =
    profile.subDistricts.length > 0
      ? profile.subDistricts.join('、')
      : profile.districts.length > 0
        ? profile.districts.join('、')
        : null;

  const bedrooms =
    profile.bedrooms.length > 0
      ? `${profile.bedrooms.join('/')} 房${profile.bedroomsStrict ? '（硬性）' : ''}`
      : null;

  const area =
    profile.areaMin !== null && profile.areaMax !== null
      ? `${profile.areaMin}～${profile.areaMax}㎡`
      : profile.areaMin !== null
        ? `${profile.areaMin}㎡以上`
        : profile.areaMax !== null
          ? `${profile.areaMax}㎡以内`
          : null;

  // 优先级类信息汇总成一行
  const priorities: string[] = [];
  const subwayText = describePriority(profile.subwayPriority);
  if (subwayText) priorities.push(`地铁 ${subwayText}`);
  const communityText = describePriority(profile.communityQualityPriority);
  if (communityText) priorities.push(`小区环境 ${communityText}`);
  const schoolText = describePriority(profile.schoolPriority);
  if (schoolText) priorities.push(`学区 ${schoolText}`);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Target className="size-3.5 text-brand" />
          当前需求画像
          {extractionSource && (
            <Badge variant="outline" className="ml-auto text-[10px] font-normal">
              {extractionSource === 'AI' ? 'AI 识别' : '内置规则识别'}
              {confidence !== undefined ? ` · ${Math.round(confidence * 100)}%` : ''}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {/* 一句话摘要 */}
        <p className="rounded-md bg-brand-subtle px-2.5 py-1.5 text-xs leading-relaxed text-ink">
          {summary}
        </p>

        {/* 三级预算（核心） */}
        <BudgetBar profile={profile} />

        {/* 其它条件 */}
        <div className="grid gap-1.5 sm:grid-cols-2">
          <Item label="城市" value={profile.city} />
          <Item label="区域" value={districts} />
          <Item label="户型" value={bedrooms} />
          <Item label="面积" value={area} />

          <Item
            label="房龄"
            value={
              profile.avoidOldCommunity
                ? '要求较新小区'
                : profile.buildingAgePreference && profile.buildingAgePreference !== 'ANY'
                  ? profile.buildingAgePreference
                  : null
            }
          />
          <Item
            label="装修"
            value={profile.requireFineDecoration ? '必须精装' : null}
          />
          <Item
            label="地铁距离"
            value={profile.subwayDistanceMax !== null ? `${profile.subwayDistanceMax} 米内` : null}
          />
          <Item
            label="学区"
            value={
              profile.schoolRequired
                ? '需要学区'
                : profile.schoolNotNeeded
                  ? '学区无所谓'
                  : null
            }
          />
          <Item label="购房目的" value={profile.purchasePurpose} />
          <Item
            label="家人关注"
            value={profile.familyConcerns.length > 0 ? profile.familyConcerns.join('；') : null}
          />
        </div>

        {/* 优先级标签 */}
        {priorities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {/* key 用「内容+序号」以防优先级文案重复 */}
            {priorities.map((item, index) => (
              <Badge key={`${item}-${index}`} variant="brand" className="text-[10px]">
                {item}
              </Badge>
            ))}
          </div>
        )}

        {/* 缺失关键字段：提示经纪人补充，而不是让系统猜 */}
        {missingCriticalFields && missingCriticalFields.length > 0 && !compact && (
          <div className="rounded-md border border-warning/30 bg-warning-subtle px-2.5 py-1.5">
            <p className="text-[11px] text-warning">
              缺少关键信息：{missingCriticalFields.includes('city') ? '城市' : ''}
              {missingCriticalFields.includes('districts') ? ' 区域' : ''}
              。补全后推荐会更准。
            </p>
          </div>
        )}

        {/* 置信度提示 */}
        {confidence !== undefined && confidence < 0.6 && (
          <p className="flex items-center gap-1 text-[11px] text-ink-muted">
            <Sparkles className="size-3" />
            本次识别置信度较低，建议确认后再发送给客户
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 需求变化列表。
 *
 * 展示"AI 识别到以下变化"，让经纪人在发送前确认系统理解是否正确。
 * 这是需求 §10 明确要求的——不能让系统偷偷改客户资料。
 */
export function RequirementChanges({
  changes,
  needsConfirmation,
}: {
  changes: Array<{
    field: string;
    label: string;
    before: string;
    after: string;
    type: string;
    isOverride: boolean;
  }>;
  needsConfirmation: boolean;
}) {
  if (changes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2">
        <p className="text-xs text-ink-muted">本次没有识别到需求变化（已与历史画像合并）</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium text-ink-secondary">识别到的需求变化</p>
        {needsConfirmation && (
          <Badge variant="high" className="text-[10px]">
            建议确认
          </Badge>
        )}
      </div>

      <ul className="space-y-1">
        {changes.map((change) => (
          <li
            key={`${change.field}-${change.after}`}
            className={cn(
              'flex flex-wrap items-baseline gap-x-1.5 rounded-md border px-2.5 py-1.5 text-xs',
              change.isOverride
                ? 'border-warning/30 bg-warning-subtle'
                : 'border-border bg-surface-subtle',
            )}
          >
            <span className="font-medium text-ink">{change.label}</span>
            <Badge
              variant={change.isOverride ? 'high' : 'outline'}
              className="text-[10px] font-normal"
            >
              {change.type}
            </Badge>
            <span className="text-ink-muted line-through">{change.before}</span>
            <span className="text-ink-muted">→</span>
            <span className="font-medium text-ink">{change.after}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
