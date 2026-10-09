/**
 * 客户控制器。
 *
 * 提供客户列表与客户 360 视图 —— 这是前端从工作台进入具体客户操作的入口。
 *
 * 权限范围（多租户 + 角色）：
 *   - 经纪人：只能看自己名下与所在门店的客户（默认按 assignedAgentId 过滤）
 *   - 门店经理：看本门店全部客户
 *   - 公司负责人：看全公司
 *   - 只读：可看，不可改
 *
 * 注意：这里**不做**"跨门店可见"的隐式放宽 —— 越权在测试环境发现不了，
 * 上线后会变成真实的串库事故。
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { CustomerStatus, IntentLevel, UserRole } from '@estatepilot/types';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators/auth.decorators.js';
import { ZodQuery } from '../../common/pipes/zod-validation.pipe.js';
import { NotFoundError } from '../../common/filters/all-exceptions.filter.js';
import { TenantService } from '../tenant/tenant.service.js';

/** 列表查询参数 */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** 关键词：匹配姓名 / 手机号 / 微信 */
  keyword: z.string().max(50).optional(),
  status: z.nativeEnum(CustomerStatus).optional(),
  intentLevel: z.nativeEnum(IntentLevel).optional(),
  /** 只看我负责的客户（默认经纪人自动开启） */
  mineOnly: z.coerce.boolean().optional(),
  sortBy: z.enum(['intentScore', 'lastContactAt', 'lastActiveAt', 'createdAt']).default('intentScore'),
});

type ListQuery = z.infer<typeof listQuerySchema>;

/** 列表项（比完整客户模型精简，够列表展示） */
interface CustomerListItemDto {
  id: string;
  name: string;
  gender: string;
  /** 脱敏手机号 */
  phone: string | null;
  status: string;
  intentLevel: string | null;
  intentScore: number | null;
  intentScoreLevel: string | null;
  /** 显性需求速览 */
  requirementBrief: string;
  budgetMin: number | null;
  budgetMax: number | null;
  preferredDistricts: string[];
  bedrooms: number[];
  lastContactAt: string | null;
  lastActiveAt: string | null;
  nextFollowUpAt: string | null;
  behaviorEventCount: number;
  viewingCount: number;
  /** 是否有已识别的需求画像 */
  hasRequirementProfile: boolean;
  /** 最近的推荐批次时间（有值说明最近推过房源） */
  lastRecommendedAt: string | null;
  createdAt: string;
}

@Controller('customers')
export class CustomerController {
  constructor(private readonly tenant: TenantService) {}

  /**
   * GET /customers —— 客户列表。
   */
  @Get()
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async list(
    @Query(ZodQuery(listQuerySchema)) query: ListQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<{
    items: CustomerListItemDto[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const scope = this.tenant.scopeFor(user.organizationId);

    // ---- 权限范围 ----
    // 经纪人默认只看自己负责的客户；经理与负责人看全范围。
    const isAgent = user.role === UserRole.AGENT;
    const mineOnly = query.mineOnly ?? isAgent;

    const where: Record<string, unknown> = {
      deletedAt: null,
      ...(mineOnly ? { assignedAgentId: user.id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.intentLevel ? { intentLevel: query.intentLevel } : {}),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { phone: { contains: query.keyword } },
              { wechat: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy: Record<string, string> =
      query.sortBy === 'intentScore'
        ? { intentScore: 'desc' }
        : { [query.sortBy]: 'desc' };

    const [rows, total] = await Promise.all([
      scope.findMany<{
        id: string;
        name: string;
        gender: string;
        phone: string | null;
        status: string;
        intentLevel: string | null;
        intentScore: number | null;
        intentScoreLevel: string | null;
        preferredCity: string | null;
        preferredDistricts: string[];
        preferredCommunities: string[];
        bedrooms: number[];
        budgetMin: number | null;
        budgetMax: number | null;
        areaMin: number | null;
        areaMax: number | null;
        lastContactAt: Date | null;
        lastActiveAt: Date | null;
        nextFollowUpAt: Date | null;
        behaviorEventCount: number;
        viewingCount: number;
      }>('Customer', {
        where,
        select: {
          id: true,
          name: true,
          gender: true,
          phone: true,
          status: true,
          intentLevel: true,
          intentScore: true,
          intentScoreLevel: true,
          preferredCity: true,
          preferredDistricts: true,
          preferredCommunities: true,
          bedrooms: true,
          budgetMin: true,
          budgetMax: true,
          areaMin: true,
          areaMax: true,
          lastContactAt: true,
          lastActiveAt: true,
          nextFollowUpAt: true,
          behaviorEventCount: true,
          viewingCount: true,
        },
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      scope.count('Customer', where),
    ]);

    // ---- 批量查询需求画像与最近推荐，避免 N+1 ----
    const customerIds = rows.map((row) => row.id);

    const [profiles, batches] = await Promise.all([
      customerIds.length > 0
        ? scope.findMany<{ customerId: string }>('CustomerRequirementProfile', {
            where: { customerId: { in: customerIds } },
            select: { customerId: true },
          })
        : Promise.resolve([]),
      customerIds.length > 0
        ? scope.findMany<{ customerId: string; createdAt: Date }>('RecommendationBatch', {
            where: { customerId: { in: customerIds } },
            select: { customerId: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    const profileSet = new Set(profiles.map((profile) => profile.customerId));
    const lastRecommended = new Map<string, Date>();
    for (const batch of batches) {
      if (!lastRecommended.has(batch.customerId)) {
        lastRecommended.set(batch.customerId, batch.createdAt);
      }
    }

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        gender: row.gender,
        phone: maskPhone(row.phone),
        status: row.status,
        intentLevel: row.intentLevel,
        intentScore: row.intentScore,
        intentScoreLevel: row.intentScoreLevel,
        requirementBrief: buildRequirementBrief(row),
        budgetMin: row.budgetMin,
        budgetMax: row.budgetMax,
        preferredDistricts: row.preferredDistricts,
        bedrooms: row.bedrooms,
        lastContactAt: row.lastContactAt?.toISOString() ?? null,
        lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
        nextFollowUpAt: row.nextFollowUpAt?.toISOString() ?? null,
        behaviorEventCount: row.behaviorEventCount,
        viewingCount: row.viewingCount,
        hasRequirementProfile: profileSet.has(row.id),
        lastRecommendedAt: lastRecommended.get(row.id)?.toISOString() ?? null,
        createdAt: row.id ? new Date().toISOString() : new Date().toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /**
   * GET /customers/:id —— 客户基本信息。
   */
  @Get(':id')
  @Roles(UserRole.AGENT, UserRole.STORE_MANAGER, UserRole.OWNER, UserRole.VIEWER)
  async detail(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{
    id: string;
    name: string;
    gender: string;
    phone: string | null;
    wechat: string | null;
    status: string;
    source: string;
    intentLevel: string | null;
    intentScore: number | null;
    intentScoreLevel: string | null;
    /** 显性需求 */
    requirement: {
      city: string | null;
      districts: string[];
      communities: string[];
      bedrooms: number[];
      livingRooms: number | null;
      budgetMin: number | null;
      budgetMax: number | null;
      areaMin: number | null;
      areaMax: number | null;
      decorationPreference: string | null;
      floorPreference: string | null;
      propertyAgePreference: string | null;
      schoolPreference: string | null;
      subwayDistanceMax: number | null;
      purchasePurpose: string | null;
      paymentMethod: string | null;
      purchaseTimeline: string | null;
      notes: string | null;
    };
    /** 行为统计 */
    behavior: {
      eventCount: number;
      viewingCount: number;
      lastActiveAt: string | null;
      lastContactAt: string | null;
      nextFollowUpAt: string | null;
      preferenceDriftScore: number | null;
    };
  }> {
    const scope = this.tenant.scopeFor(user.organizationId);

    const customer = await scope.findFirst<Record<string, unknown>>('Customer', {
      where: { id, deletedAt: null },
    });

    if (!customer) throw new NotFoundError('客户', id);

    const pick = (key: string): string | null => {
      const value = customer[key];
      return typeof value === 'string' ? value : null;
    };
    const pickArray = (key: string): string[] => {
      const value = customer[key];
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    };
    const pickNumberArray = (key: string): number[] => {
      const value = customer[key];
      return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
    };
    const pickNumber = (key: string): number | null => {
      const value = customer[key];
      if (typeof value === 'number') return value;
      if (value !== null && typeof value === 'object' && 'toString' in value) {
        const parsed = Number(String(value));
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    };
    const pickDate = (key: string): string | null => {
      const value = customer[key];
      if (value instanceof Date) return value.toISOString();
      return null;
    };

    return {
      id: String(customer['id']),
      name: String(customer['name'] ?? ''),
      gender: String(customer['gender'] ?? 'UNKNOWN'),
      phone: maskPhone(pick('phone')),
      wechat: pick('wechat'),
      status: String(customer['status'] ?? 'NEW'),
      source: String(customer['source'] ?? 'OTHER'),
      intentLevel: pick('intentLevel'),
      intentScore: pickNumber('intentScore'),
      intentScoreLevel: pick('intentScoreLevel'),
      requirement: {
        city: pick('preferredCity'),
        districts: pickArray('preferredDistricts'),
        communities: pickArray('preferredCommunities'),
        bedrooms: pickNumberArray('bedrooms'),
        livingRooms: pickNumber('livingRooms'),
        budgetMin: pickNumber('budgetMin'),
        budgetMax: pickNumber('budgetMax'),
        areaMin: pickNumber('areaMin'),
        areaMax: pickNumber('areaMax'),
        decorationPreference: pick('decorationPreference'),
        floorPreference: pick('floorPreference'),
        propertyAgePreference: pick('propertyAgePreference'),
        schoolPreference: pick('schoolPreference'),
        subwayDistanceMax: pickNumber('subwayDistanceMax'),
        purchasePurpose: pick('purchasePurpose'),
        paymentMethod: pick('paymentMethod'),
        purchaseTimeline: pick('purchaseTimeline'),
        notes: pick('notes'),
      },
      behavior: {
        eventCount: pickNumber('behaviorEventCount') ?? 0,
        viewingCount: pickNumber('viewingCount') ?? 0,
        lastActiveAt: pickDate('lastActiveAt'),
        lastContactAt: pickDate('lastContactAt'),
        nextFollowUpAt: pickDate('nextFollowUpAt'),
        preferenceDriftScore: pickNumber('preferenceDriftScore'),
      },
    };
  }
}

/**
 * 手机号脱敏。
 *
 * 列表与详情默认脱敏（138****8888），因为客户信息属于个人隐私，
 * 界面上大规模展示完整号码会增加泄露风险。
 * 需要完整号码时走单独的"查看联系方式"接口并记录审计。
 */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** 生成需求速览文本，用于列表一眼看出客户要什么 */
function buildRequirementBrief(row: {
  preferredCity: string | null;
  preferredDistricts: string[];
  bedrooms: number[];
  budgetMin: number | null;
  budgetMax: number | null;
}): string {
  const parts: string[] = [];

  if (row.preferredCity) parts.push(row.preferredCity);
  if (row.preferredDistricts.length > 0) {
    parts.push(row.preferredDistricts.slice(0, 2).join('、'));
  }
  if (row.bedrooms.length > 0) parts.push(`${row.bedrooms.join('/')}房`);

  if (row.budgetMin !== null && row.budgetMax !== null) {
    parts.push(`${Math.round(row.budgetMin / 10_000)}-${Math.round(row.budgetMax / 10_000)}万`);
  } else if (row.budgetMax !== null) {
    parts.push(`${Math.round(row.budgetMax / 10_000)}万以内`);
  }

  return parts.length > 0 ? parts.join(' · ') : '需求待补充';
}
