'use client';

/**
 * 城市与区域查询钩子 —— 支撑"地址筛选"功能。
 *
 * 需求背景：经纪人需要**选定区域后只推荐该区域的房源**。
 * 用户的主战场是厦门，而系统原先只支持上海，因此加了多城市地址目录。
 *
 * 设计要点：
 *   - 城市列表变化很少（只有运营调整时才会变），因此 staleTime 设长
 *   - `availableProperties` 让界面能提前提示"该城市当前无可用房源"，
 *     避免经纪人选了厦门、等 20 秒才发现一套都推不出来
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface CityCatalogItem {
  city: string;
  beikeCityCode: string | null;
  districts: string[];
  subDistricts: string[];
  /** 该城市在本地库里实际可用的真实房源数 */
  availableProperties: number;
  /** 是否有本地房源可立即推荐 */
  hasLocalInventory: boolean;
}

export interface CityCatalogResponse {
  cities: CityCatalogItem[];
  beike: { configured: boolean; reachable: boolean; message: string };
}

export interface CityAreasResponse {
  city: string;
  districts: string[];
  subDistricts: string[];
  availableProperties: number;
  districtCounts: Array<{ district: string; count: number }>;
}

export const locationKeys = {
  all: ['locations'] as const,
  cities: () => [...locationKeys.all, 'cities'] as const,
  areas: (city: string) => [...locationKeys.all, 'areas', city] as const,
};

/** 城市列表（含各区/板块与可用房源数） */
export function useCityCatalog() {
  return useQuery({
    queryKey: locationKeys.cities(),
    queryFn: () => api.get<CityCatalogResponse>('/locations/cities'),
    // 地址数据极少变化，缓存 5 分钟
    staleTime: 5 * 60_000,
  });
}

/** 单个城市的区域详情 */
export function useCityAreas(city: string | null) {
  return useQuery({
    queryKey: locationKeys.areas(city ?? ''),
    queryFn: () =>
      api.get<CityAreasResponse>('/locations/areas', {
        query: { city: city ?? '' },
      }),
    enabled: Boolean(city),
    staleTime: 60_000,
  });
}
