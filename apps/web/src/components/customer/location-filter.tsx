'use client';

/**
 * 区域筛选器 —— "选择哪个地址就推荐哪个地方的房源"。
 *
 * ============================================================================
 * 为什么需要它
 * ============================================================================
 * 原先系统写死上海，且无法在界面上选区域。用户的主战场是厦门，
 * 因此需要：
 *   1. 先选城市（厦门 / 上海 / 福州 / 泉州 / 漳州）
 *   2. 再选区（可多选；不选 = 该城市全部）
 *   3. 选择后推荐结果**只包含选定区域**的房源
 *
 * ============================================================================
 * 两个刻意的设计
 * ============================================================================
 *  1. **显示各城市的可用房源数**
 *     如果厦门当前 0 套（贝壳故障且本地无缓存），提前在选项上标出来，
 *     而不是让经纪人选了、等 20 秒、再看到失败。
 *
 *  2. **选择只作用于本次搜索，不写回客户画像**
 *     筛选器是"我这次想看哪里"，客户画像记录的是"客户要什么"。
 *     混在一起会让一次临时筛选永久改变客户档案。UI 上也明确写了这一点。
 */

import { useMemo } from 'react';
import { Loader2, MapPin } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useCityCatalog } from '@/lib/queries/use-locations';
import { cn } from '@/lib/utils';

interface LocationFilterProps {
  /** 选中的城市（null = 未筛选，按客户画像/消息内容推断） */
  city: string | null;
  /** 选中的行政区（空数组 = 该城市全部） */
  districts: string[];
  onCityChange: (city: string | null) => void;
  onDistrictsChange: (districts: string[]) => void;
  disabled?: boolean;
  className?: string;
}

export function LocationFilter({
  city,
  districts,
  onCityChange,
  onDistrictsChange,
  disabled = false,
  className,
}: LocationFilterProps) {
  const { data, isLoading, isError } = useCityCatalog();

  /** 当前选中城市的档案（用于渲染区域多选） */
  const currentCity = useMemo(
    () => data?.cities.find((item) => item.city === city) ?? null,
    [data, city],
  );

  const handleCityChange = (nextCity: string): void => {
    if (nextCity === '') {
      onCityChange(null);
      onDistrictsChange([]);
      return;
    }

    // 切换城市时清空已选区 —— 区域名跨城市不通用
    // （"思明区"在厦门，切到上海后还留着会导致筛出 0 条）
    if (nextCity !== city) onDistrictsChange([]);
    onCityChange(nextCity);
  };

  const toggleDistrict = (district: string): void => {
    const next = districts.includes(district)
      ? districts.filter((item) => item !== district)
      : [...districts, district];
    onDistrictsChange(next);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
        <MapPin className="size-3.5 text-ink-muted" />
        城市
        <select
          value={city ?? ''}
          onChange={(event) => handleCityChange(event.target.value)}
          disabled={disabled || isLoading}
          className="h-7 max-w-[13rem] rounded-md border border-border bg-surface px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
        >
          <option value="">
            {isLoading ? '加载中…' : '按客户需求自动判断'}
          </option>
          {data?.cities.map((item) => (
            <option key={item.city} value={item.city}>
              {item.city}
              {item.availableProperties > 0
                ? `（${item.availableProperties} 套）`
                : '（暂无房源）'}
            </option>
          ))}
        </select>
      </label>

      {/* 区域多选：只在选了城市后出现 */}
      {city && currentCity && currentCity.districts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-ink-muted">区域</span>

          <button
            type="button"
            disabled={disabled}
            onClick={() => onDistrictsChange([])}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              districts.length === 0
                ? 'border-brand bg-brand-subtle text-brand'
                : 'border-border text-ink-secondary hover:border-brand/50',
            )}
          >
            全部
          </button>

          {currentCity.districts.map((district) => {
            const selected = districts.includes(district);
            return (
              <button
                key={district}
                type="button"
                disabled={disabled}
                onClick={() => toggleDistrict(district)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  selected
                    ? 'border-brand bg-brand-subtle text-brand'
                    : 'border-border text-ink-secondary hover:border-brand/50',
                )}
              >
                {district.replace(/[区县市]$/, '')}
              </button>
            );
          })}
        </div>
      )}

      {/* 该城市无可用房源 → 提前明确告知，不让经纪人白等 */}
      {city && currentCity && currentCity.availableProperties === 0 && (
        <Badge variant="warning" className="text-[11px]">
          {city} 暂无可用房源
        </Badge>
      )}

      {isError && (
        <span className="text-[11px] text-danger">城市列表加载失败，将按客户需求自动判断</span>
      )}

      {isLoading && (
        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
          <Loader2 className="size-3 animate-spin" />
          正在读取城市与房源分布
        </span>
      )}
    </div>
  );
}
