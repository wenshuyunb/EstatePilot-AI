'use client';

/**
 * 微信助手查询钩子。
 *
 * 这里的类型定义与后端 `wechat-assistant.orchestrator.ts` 的返回结构一一对应。
 * 之所以在前后端各写一份（而不是共享 packages/types）：
 *   编排结果是**接口的传输结构**，包含 DTO 层面的展示字段
 *   （如 subwayText、schoolText、source 标注），
 *   它们与领域模型不完全相同。放在前端可以让界面代码有完整类型提示。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 后端返回的步骤状态（用于显示真实进度，禁止假 loading） */
export interface AssistantStepStatus {
  step: string;
  label: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'SKIPPED' | 'FAILED';
  detail: string | null;
  durationMs: number | null;
}

/** 推荐房源卡片数据 */
export interface RecommendedProperty {
  propertyId: string;
  externalId: string;
  matchScore: number;
  community: string;
  /** 城市 —— 按需加载详情时需传给贝壳接口（city_name 必填） */
  city: string;
  district: string;
  subDistrict: string | null;
  title: string;
  /**
   * ⚠️ 数值字段声明为 `number | string`，而不是 `number`。
   *
   * ============================================================================
   * 为什么（线上"复制失败"事故）
   * ============================================================================
   * 后端的 `Decimal` / `BigInt` 经 JSON 序列化后是**字符串**
   * （`totalPrice` 源自 BigInt 列，`area` 源自 Decimal 列），
   * 但前端原先声明为 `number` —— 类型声明与运行时不符。
   *
   * 后果：`area.toFixed is not a function` → 复制功能报"复制失败"。
   *
   * 声明成联合类型能让 TypeScript **强制**调用方先归一化数值，
   * 把这类 bug 挡在编译期而不是运行时。
   */
  totalPrice: number | string;
  unitPrice: number | string;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: number | string;
  floor: number | null;
  totalFloors: number | null;
  buildYear: number | null;
  decoration: string | null;
  orientation: string | null;
  subwayDistance: number | string | null;
  subwayText: string | null;
  schoolText: string | null;
  images: string[];
  coverImage: string | null;
  tags: string[];
  listingStatus: string;
  breakdown: Array<{ key: string; label: string; score: number; maxScore: number; detail: string }>;
  highlights: string[];
  cautions: string[];
  explanation: string | null;
  previouslyRecommended: boolean;
  priceChange: number;
  /** 来源标签，如「贝壳开放平台」「贝壳（本地缓存）」「安居客（用户录入）」 */
  source: string;

  // ---- 数据可信度（Phase 12，与匹配度完全独立）----
  /** 数据可信度评分 0~100 */
  dataReliabilityScore: number;
  /** 星级 0~5 */
  reliabilityStars: number;
  /** 核验状态：VERIFIED 可发 / PENDING 需确认 / EXPIRED 已过期 */
  verificationStatus: 'VERIFIED' | 'PENDING' | 'EXPIRED';
  /** 给经纪人看的可信度说明（必须展示，不能隐藏风险） */
  reliabilityNote: string;
  /** 最后核验时间（ISO，无则 null） */
  lastVerifiedAt: string | null;
  /** 时效性得分 0~100 */
  freshnessScore: number;
  /** 综合排序分 = 匹配度×0.7 + 可信度×0.2 + 时效性×0.1 */
  finalScore: number;

  // ==========================================================================
  // 完整详情（Phase 15）—— 让经纪人在**本平台**看到与贝壳 App 同等详细的信息
  //
  // 产品要求：不跳转贝壳，详情与图片在平台内展示。
  // 全部字段来自贝壳官方 entity_detail / entity_material，
  // 我们只做结构化，不做推测 —— 拿不到就是 null，界面显示"暂无数据"。
  // ==========================================================================

  /** 完整详情；为 null 表示未补全成功（限流/缓存降级），此时只展示摘要 */
  fullDetail: PropertyFullDetail | null;

  /** 图片（含房间名与类型），已按 URL 去重 */
  imageDetails: PropertyImage[];

  /** VR 看房地址（贝壳 App scheme，PC 打不开，界面须提示"手机打开"） */
  vrUrl: string | null;
}

/** 一张房源图片 */
export interface PropertyImage {
  url: string;
  /** 房间名（客厅/卧室/厨房…）；户型图与 VR 图为 null */
  roomName: string | null;
  kind: 'ROOM' | 'FLOOR_PLAN' | 'VR' | 'OTHER';
}

/** 一条周边配套（含距离） */
export interface NearbyFacility {
  name: string;
  distanceMeters: number | null;
  category: string | null;
}

/** 完整房源详情（结构与后端 PropertyFullDetail 一一对应） */
export interface PropertyFullDetail {
  base: {
    title: string | null;
    unitPrice: string | null;
    buildingArea: string | null;
    innerArea: string | null;
    totalPrice: string | null;
    layoutStructure: string | null;
    houseType: string | null;
    houseAge: string | null;
    listingStatus: string | null;
    floor: string | null;
    totalFloors: string | null;
    hasElevator: string | null;
    orientation: string | null;
    elevatorHouseholdRatio: string | null;
    buildingType: string | null;
    usage: string | null;
    /**
     * 装修：精装 / 简装 / 毛坯。
     *
     * 后端可能从 `description` 反解得到（因为贝壳搜索结果不返回"装修类型"，
     * 数据库该列实测覆盖率为 0%）。
     */
    decoration: string | null;
    downPayment: string | null;
    ownership: string | null;
    beikeScore: number | null;
    tags: string[];
  } | null;

  community: {
    name: string | null;
    aliases: string[];
    buildYears: string | null;
    totalHouseholds: number | null;
    floorAreaRatio: string | null;
    greeningRate: string | null;
    propertyFee: string | null;
    propertyCompany: string | null;
    parkingRatio: string | null;
    parkingFee: string | null;
    fixedParkingSpaces: number | null;
    separatedTraffic: string | null;
    isClosed: string | null;
    rentToSaleRatio: string | null;
    rentPrice: string | null;
    waterType: string | null;
    electricityType: string | null;
    heatingType: string | null;
    gasFee: string | null;
    businessDistrict: string | null;
    district: string | null;
  } | null;

  nearby: {
    subway: NearbyFacility[];
    bus: NearbyFacility[];
    school: NearbyFacility[];
    hospital: NearbyFacility[];
    shopping: NearbyFacility[];
    park: NearbyFacility[];
    other: NearbyFacility[];
  } | null;

  images: PropertyImage[];
  vrUrl: string | null;
}

/** 需求画像 */
export interface RequirementProfile {
  city: string | null;
  districts: string[];
  subDistricts: string[];
  communities: string[];
  budgetTarget: number | null;
  budgetNormalMax: number | null;
  budgetStretchMax: number | null;
  budgetStrictMax: boolean;
  budgetMin: number | null;
  bedrooms: number[];
  bedroomsStrict: boolean;
  areaMin: number | null;
  areaMax: number | null;
  buildingAgePreference: string | null;
  avoidOldCommunity: boolean;
  communityQualityPriority: string | null;
  subwayPriority: string | null;
  schoolPriority: string | null;
  schoolRequired: boolean;
  schoolNotNeeded: boolean;
  schoolNote?: string | null;
  decorationPreference?: string | null;
  requireFineDecoration: boolean;
  subwayDistanceMax: number | null;
  avoidFirstFloor?: boolean;
  avoidTopFloor?: boolean;
  requireElevator?: boolean;
  decisionMakers: string[];
  familyConcerns: string[];
  purchasePurpose: string | null;
  paymentTimeline?: string | null;
  confidence: number;
  sourceMessageCount: number;
}

/** 编排结果 */
export interface AssistantResult {
  messageId: string;
  snapshotId: string | null;
  snapshotVersion: number | null;
  profile: RequirementProfile;
  profileSummary: string;
  changes: Array<{
    field: string;
    label: string;
    before: string;
    after: string;
    type: string;
    isOverride: boolean;
  }>;
  needsConfirmation: boolean;
  extractionSource: 'AI' | 'RULES';
  extractionConfidence: number;
  missingCriticalFields: string[];
  searchQuery: {
    naturalQuery: string;
    rationale: string;
    hardConditions: string[];
    softConditions: string[];
  };
  beikeStats: {
    totalRecalled: number | null;
    returned: number;
    passedHardFilter: number;
    rejectedByReason: Record<string, number>;
  };
  /**
   * 房源数据来源。
   *   LIVE        = 实时调用贝壳开放平台
   *   LOCAL_CACHE = 贝壳不可用，改用本地已同步的真实房源
   *
   * 界面**必须**把它显示出来：经纪人不能把缓存数据当成实时数据，
   * 否则可能向客户承诺"这套还在卖"，而实际上房源状态可能已经变了。
   */
  dataSource?: 'LIVE' | 'LOCAL_CACHE';
  /** 缓存模式下的数据来源说明，如「本地缓存房源（41 套） · 3 小时前同步」 */
  cacheNote?: string | null;
  recommendations: RecommendedProperty[];
  reply: {
    replyId: string;
    content: string;
    style: string;
    aiGenerated: boolean;
    length: number;
  };
  batchId: string;
  zeroResultSuggestions: Array<{
    label: string;
    description: string;
    relaxField: string;
    suggestedValue: string;
  }>;
  steps: AssistantStepStatus[];
  durationMs: number;
  warnings: string[];
}

/** 需求版本历史项 */
export interface RequirementSnapshotItem {
  id: string;
  version: number;
  changedFields: string[];
  changes: Array<{
    field: string;
    label: string;
    before: string;
    after: string;
    type: string;
    isOverride: boolean;
  }>;
  hasOverride: boolean;
  needsConfirmation: boolean;
  sourceMessageId: string | null;
  createdAt: string;
}

/** 推荐批次 */
export interface RecommendationBatchItem {
  id: string;
  customerId: string;
  status: string;
  candidateCount: number;
  hardFilteredCount: number;
  recommendedPropertyIds: string[];
  scoreBreakdowns: unknown;
  searchQuery: unknown;
  beikeTotalRecalled: number | null;
  durationMs: number | null;
  createdAt: string;
  replies: Array<{
    id: string;
    content: string;
    style: string;
    propertyIds: string[];
    copiedAt: string | null;
    sentConfirmedAt: string | null;
    aiGenerated: boolean;
    createdAt: string;
  }>;
}

/** 消息历史项 */
export interface MessageImportItem {
  id: string;
  rawText: string;
  source: string;
  sourceType: string;
  parseStatus: string;
  parseError: string | null;
  parsedRequirements: unknown;
  snapshotId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export const wechatAssistantKeys = {
  requirement: (customerId: string) => ['requirement', customerId] as const,
  history: (customerId: string) => ['requirement-history', customerId] as const,
  messages: (customerId: string) => ['messages', customerId] as const,
  recommendations: (customerId: string) => ['recommendations', customerId] as const,
  capabilities: (customerId: string) => ['assistant-capabilities', customerId] as const,
};

/** 当前需求画像 */
export function useRequirementProfile(customerId: string) {
  return useQuery({
    queryKey: wechatAssistantKeys.requirement(customerId),
    queryFn: () =>
      api.get<{ exists: boolean; profile: RequirementProfile; summary: string }>(
        `/customers/${customerId}/requirement`,
      ),
    enabled: Boolean(customerId),
  });
}

/** 需求版本历史 */
export function useRequirementHistory(customerId: string) {
  return useQuery({
    queryKey: wechatAssistantKeys.history(customerId),
    queryFn: () =>
      api.get<{ items: RequirementSnapshotItem[]; total: number }>(
        `/customers/${customerId}/requirement-history?pageSize=20`,
      ),
    enabled: Boolean(customerId),
  });
}

/** 粘贴消息历史 */
export function useMessageHistory(customerId: string) {
  return useQuery({
    queryKey: wechatAssistantKeys.messages(customerId),
    queryFn: () =>
      api.get<{ items: MessageImportItem[]; total: number }>(
        `/customers/${customerId}/messages?pageSize=20`,
      ),
    enabled: Boolean(customerId),
  });
}

/** 推荐历史 */
export function useRecommendationHistory(customerId: string) {
  return useQuery({
    queryKey: wechatAssistantKeys.recommendations(customerId),
    queryFn: () =>
      api.get<{ items: RecommendationBatchItem[]; total: number }>(
        `/customers/${customerId}/recommendations?pageSize=10`,
      ),
    enabled: Boolean(customerId),
  });
}

/** AI 能力状态（用于提示"当前使用内置规则"） */
export function useAssistantCapabilities(customerId: string) {
  return useQuery({
    queryKey: wechatAssistantKeys.capabilities(customerId),
    queryFn: () =>
      api.get<{
        ai: {
          provider: string;
          model: string;
          live: boolean;
          degraded: boolean;
          degradedReason: string | null;
        };
        /** 贝壳数据源的实时探测结果 */
        beike: {
          ok: boolean;
          /** NONE = 正常；SERVICE = 对方服务不可用（等待即可）；CONNECTION = 我们的配置问题 */
          failureKind: string;
          message: string;
          durationMs: number;
        } | null;
        notes: string[];
      }>(`/customers/${customerId}/assistant-capabilities`),
    enabled: Boolean(customerId),
    // 探测会真实调用贝壳，因此缓存久一点，避免每次切页面都探测
    staleTime: 3 * 60_000,
    // 贝壳服务可能随时恢复，因此定期重探（5 分钟）
    refetchInterval: 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// 变更
// ---------------------------------------------------------------------------

/**
 * 执行完整闭环。
 *
 * 这是前端最核心的一个调用：粘贴客户微信消息 → 得到真实房源与微信文案。
 */
export function useRunAssistant(customerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      message: string;
      recommendationCount?: number;
      replyStyle?: 'NATURAL_PROFESSIONAL' | 'CONCISE' | 'DETAILED';
      portalUrl?: string;
      /** 城市筛选（区域筛选器选择）。不传 = 按客户需求自动判断 */
      cityOverride?: string | null;
      /** 区域筛选。空数组或未传 = 该城市全部 */
      districtOverride?: string[] | null;
    }) =>
      api.post<AssistantResult>(`/customers/${customerId}/wechat-assistant`, input, {
        // 全流程可能 10～30 秒，给足超时
        timeoutMs: 180_000,
      }),

    onSuccess: () => {
      // 需求画像、历史、消息都变了，全部失效重取
      void queryClient.invalidateQueries({ queryKey: wechatAssistantKeys.requirement(customerId) });
      void queryClient.invalidateQueries({ queryKey: wechatAssistantKeys.history(customerId) });
      void queryClient.invalidateQueries({ queryKey: wechatAssistantKeys.messages(customerId) });
      void queryClient.invalidateQueries({
        queryKey: wechatAssistantKeys.recommendations(customerId),
      });
    },
  });
}

/** 记录「已复制」。注意：这只表示复制到了剪贴板，不代表客户已收到。 */
export function useMarkCopied(customerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (replyId: string) =>
      api.post<{ copiedAt: string; status: string; message: string }>(
        `/recommendations/${replyId}/copy`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: wechatAssistantKeys.recommendations(customerId),
      });
    },
  });
}

/** 记录「我已发送」（人工确认，唯一可信的已触达信号） */
export function useConfirmSent(customerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (replyId: string) =>
      api.post<{ sentConfirmedAt: string; status: string; message: string }>(
        `/recommendations/${replyId}/confirm-sent`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: wechatAssistantKeys.recommendations(customerId),
      });
    },
  });
}

/** 记录客户反馈 */
export function useRecordFeedback(customerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { batchId: string; message: string }) =>
      api.post<{
        recorded: number;
        unresolved: number;
        summary: string;
        items: Array<{ community: string | null; sentiment: string; resolved: boolean }>;
        preferenceUpdates: Array<{ field: string; newValue: string; reason: string }>;
        notice: string | null;
      }>(`/recommendations/${input.batchId}/feedback`, { message: input.message }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: wechatAssistantKeys.requirement(customerId) });
    },
  });
}

/** 换风格重新生成文案（不重新搜索房源） */
export function useRegenerateReply(customerId: string) {
  return useMutation({
    mutationFn: (input: {
      batchId: string;
      style: 'NATURAL_PROFESSIONAL' | 'CONCISE' | 'DETAILED';
      propertyIds?: string[];
      portalUrl?: string;
    }) =>
      api.post<{ content: string; style: string; aiGenerated: boolean; length: number }>(
        `/recommendations/${input.batchId}/regenerate`,
        {
          style: input.style,
          ...(input.propertyIds ? { propertyIds: input.propertyIds } : {}),
          ...(input.portalUrl ? { portalUrl: input.portalUrl } : {}),
        },
      ),
  });
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 万元格式化 */
/**
 * 金额 → "X万"。
 *
 * ⚠️ 参数类型是 `number | string`，因为后端的 `BigInt`/`Decimal`
 *    经 JSON 序列化后是**字符串**。直接做 `/ 10_000` 会得到 NaN，
 *    `.toFixed` 则会抛 `is not a function`（踩过真实的"复制失败"事故）。
 */
export function formatWan(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';

  /**
   * 归一化。
   *
   * 这里不复用 `property-copy` 的 `normalizeNumber`：
   * 那一层是"展示格式化"的领域模块，而本文件是数据查询层，
   * 让查询层依赖展示层会造成循环依赖。归一化逻辑很短，重复一份可接受 ——
   * 但**必须是同一个语义**（见 property-copy.ts 的说明）。
   */
  const numeric = typeof amount === 'number' ? amount : Number(String(amount).trim());

  if (!Number.isFinite(numeric)) return '—';

  const wan = numeric / 10_000;
  return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
}

/** 装修枚举 → 中文 */
export function describeDecoration(decoration: string | null): string | null {
  if (!decoration) return null;
  const map: Record<string, string> = {
    ROUGH: '毛坯',
    SIMPLE: '简装',
    FINE: '精装',
    LUXURY: '豪装',
  };
  return map[decoration] ?? decoration;
}

/** 朝向枚举 → 中文 */
export function describeOrientation(orientation: string | null): string | null {
  if (!orientation) return null;
  const map: Record<string, string> = {
    SOUTH: '朝南',
    NORTH: '朝北',
    EAST: '朝东',
    WEST: '朝西',
    SOUTHEAST: '东南',
    SOUTHWEST: '西南',
    NORTHEAST: '东北',
    NORTHWEST: '西北',
    SOUTH_NORTH: '南北通透',
  };
  return map[orientation] ?? orientation;
}

/** 优先级枚举 → 中文 */
export function describePriority(priority: string | null): string | null {
  if (!priority || priority === 'UNKNOWN') return null;
  const map: Record<string, string> = {
    HIGH: '很在意',
    MEDIUM: '一般',
    LOW: '不太在意',
  };
  return map[priority] ?? null;
}
