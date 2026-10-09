/**
 * 经纪人工作台服务。
 *
 * 这是产品最重要的一个接口 —— 它回答的问题是「我今天该做什么」。
 *
 * 设计原则：
 * 1. **不是把数据库里的数字堆到首页**，而是经过筛选与排序，只留下需要行动的项。
 * 2. 每一条重点客户都必须带「为什么联系他」与「建议怎么做」，
 *    因为经纪人需要的是判断依据，不是又一个列表。
 * 3. AI 不可用时必须有**规则降级方案**，且结果依然可用（而不是显示"AI 不可用"就完了）。
 * 4. 全部数据按 organizationId + 经纪人作用域过滤，绝不越权。
 *
 * 排序逻辑（这是"今天先联系谁"的核心）：
 *   机会优先级（紧急>高>中>低）
 *   → 机会价值分
 *   → 客户意向分
 *   → 最近活跃时间
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CustomerStatus,
  OPPORTUNITY_PRIORITY_RANK,
  OPPORTUNITY_TYPE_LABELS,
  OpportunityPriority,
  OpportunityStatus,
  OpportunityType,
  USER_ROLE_LABELS,
  UserRole,
  type AgentDashboard,
  type DashboardDiscovery,
  type DashboardFollowUpItem,
  type DashboardPriorityCustomer,
  type DashboardViewingItem,
  type StoreDashboard,
} from '@estatepilot/types';
import {
  addDays,
  daysBetween,
  endOfDay,
  formatDate,
  formatRelativeTime,
  greetingByHour,
  maskPhone,
  startOfDay,
} from '@estatepilot/utils';
import { TenantService } from '../tenant/tenant.service.js';
import { getContext } from '../../common/context/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';
import { StoreDashboardService } from './store-dashboard.service.js';

/** 视为「沉睡」的未联系天数 */
const DORMANT_DAYS = 21;

/** 首页展示的重点客户上限。太多会让"优先级"失去意义 */
const MAX_PRIORITY_CUSTOMERS = 8;

/** 未跟进判定：超过这个天数未联系即进入待跟进 */
const FOLLOW_UP_THRESHOLD_DAYS = 7;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly tenant: TenantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storeDashboard: StoreDashboardService,
  ) {}

  /**
   * 门店驾驶舱。
   * 权限与指标计算逻辑在 StoreDashboardService（门店视角与经纪人视角关注点不同，故拆分）。
   */
  async getStoreDashboard(storeId?: string): Promise<StoreDashboard> {
    return this.storeDashboard.getStoreDashboard(storeId);
  }

  /**
   * 生成经纪人工作台数据。
   *
   * 数据来源全部是真实数据库查询，没有任何 mock：
   * - 机会来自 opportunities 表（由机会引擎写入）
   * - 客户意向分来自 customers.intentScore（由评分引擎写入）
   * - 行为数据来自 customer_behavior_events
   */
  async getAgentDashboard(): Promise<AgentDashboard> {
    const startedAt = Date.now();
    const context = getContext();

    if (!context?.organizationId || !context.userId) {
      throw new Error('工作台需要登录上下文');
    }

    const scope = this.tenant.scope();
    const agentId = context.userId;
    const role = context.role ?? UserRole.AGENT;

    // 店长与负责人看到的是门店/公司层面的客户，经纪人只看自己的
    const isManager = role === UserRole.OWNER || role === UserRole.STORE_MANAGER;
    const isSuperAdmin = role === UserRole.SUPER_ADMIN;
    const seesAllCustomers = isManager || isSuperAdmin;

    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    // ---- 并行拉取所有需要的数据，避免串行等待 ----
    const [
      openOpportunities,
      myCustomerCount,
      highIntentCount,
      todayViewings,
      followUpCandidates,
      unreadNotificationCount,
      activeCustomerIds,
    ] = await Promise.all([
      // 未处理的机会，按优先级与价值分排序
      scope.findMany<{
        id: string;
        customerId: string | null;
        propertyId: string | null;
        type: string;
        priority: string;
        status: string;
        title: string;
        reason: string;
        suggestion: string;
        valueScore: number;
        suggestedContactBy: Date | null;
        matchScore: number | null;
        evidence: unknown;
        createdAt: Date;
      }>('Opportunity', {
        where: {
          status: { in: [OpportunityStatus.OPEN, OpportunityStatus.ACKNOWLEDGED] },
          ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
          ...(context.storeId && role === UserRole.STORE_MANAGER ? { storeId: context.storeId } : {}),
        },
        orderBy: [{ valueScore: 'desc' }, { createdAt: 'desc' }],
        take: 60,
      }),

      // 我的客户总数
      scope.count('Customer', {
        deletedAt: null,
        ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
      }),

      // 高意向客户数
      scope.count('Customer', {
        deletedAt: null,
        ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
        status: { in: [CustomerStatus.HIGH_INTENT, CustomerStatus.NEGOTIATING, CustomerStatus.VIEWING] },
      }),

      // 今日带看
      scope.findMany<{
        id: string;
        customerId: string;
        scheduledAt: Date;
        status: string;
        customer: { name: string } | null;
        properties: Array<{ property: { title: string } | null }>;
      }>('Viewing', {
        where: {
          scheduledAt: { gte: todayStart, lte: todayEnd },
          ...(seesAllCustomers ? {} : { agentId }),
        },
        orderBy: { scheduledAt: 'asc' },
        select: {
          id: true,
          customerId: true,
          scheduledAt: true,
          status: true,
          customer: { select: { name: true } },
          properties: {
            select: { property: { select: { title: true } } },
            orderBy: { visitOrder: 'asc' },
            take: 1,
          },
        },
      }),

      // 待跟进候选：有跟进计划或长期未联系的活跃客户
      scope.findMany<{
        id: string;
        name: string;
        phone: string;
        status: string;
        intentScore: number | null;
        lastContactAt: Date | null;
        nextFollowUpAt: Date | null;
        lastActiveAt: Date | null;
        behaviorEventCount: number;
      }>('Customer', {
        where: {
          deletedAt: null,
          ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
          // 排除已成交与已流失
          status: { notIn: [CustomerStatus.DEAL, CustomerStatus.LOST] },
          OR: [
            { nextFollowUpAt: { lte: todayEnd } },
            { lastContactAt: { lt: addDays(now, -FOLLOW_UP_THRESHOLD_DAYS) } },
            { lastContactAt: null },
          ],
        },
        orderBy: [{ lastActiveAt: 'desc' }],
        take: 30,
      }),

      // 未读通知数
      scope.count('Notification', {
        userId: agentId,
        isRead: false,
      }),

      // 近期活跃客户（用于"沉睡客户重新活跃"发现项）
      scope.findMany<{ customerId: string }>('CustomerBehaviorEvent', {
        where: { createdAt: { gte: addDays(now, -3) } },
        select: { customerId: true },
        distinct: ['customerId'],
        take: 500,
      }),
    ]);

    // ---- 计算发现项（AI 发现摘要）----
    const discoveries = await this.buildDiscoveries(scope, openOpportunities, activeCustomerIds, {
      seesAllCustomers,
      agentId,
      now,
    });

    // ---- 计算重点客户 ----
    const priorityCustomers = await this.buildPriorityCustomers(
      scope,
      openOpportunities,
      seesAllCustomers,
      agentId,
    );

    // ---- 计算待跟进 ----
    const followUps: DashboardFollowUpItem[] = followUpCandidates
      .map((customer) => {
        const lastContact = customer.lastContactAt;
        const overdueDays = lastContact ? daysBetween(lastContact, now) : 999;

        return {
          customerId: customer.id,
          customerName: customer.name,
          phoneMasked: maskPhone(customer.phone),
          overdueDays: overdueDays === 999 ? 0 : Math.max(0, overdueDays - FOLLOW_UP_THRESHOLD_DAYS),
          reason: lastContact
            ? `已 ${daysBetween(lastContact, now)} 天未联系`
            : '从未联系过，需要首次触达',
          lastContactAt: lastContact ? formatRelativeTime(lastContact, now) : null,
          intentScore: customer.intentScore ?? 0,
        };
      })
      // 意向分高的排前面 —— 有限时间里优先跟进更可能成交的客户
      .sort((a, b) => b.intentScore - a.intentScore)
      .slice(0, 8);

    // ---- 今日带看 ----
    const todayViewingItems: DashboardViewingItem[] = todayViewings.map((viewing) => {
      const hours = String(viewing.scheduledAt.getHours()).padStart(2, '0');
      const minutes = String(viewing.scheduledAt.getMinutes()).padStart(2, '0');
      return {
        viewingId: viewing.id,
        customerId: viewing.customerId,
        customerName: viewing.customer?.name ?? '未知客户',
        scheduledAt: `${hours}:${minutes}`,
        status: viewing.status,
        propertyCount: viewing.properties.length,
        firstPropertyTitle: viewing.properties[0]?.property?.title ?? null,
      };
    });

    const roleLabel = USER_ROLE_LABELS[role] ?? '经纪人';

    const result: AgentDashboard = {
      greeting: greetingByHour(),
      agentName: context.userId ? await this.resolveAgentName(scope, agentId) : '',
      today: `${formatDate(now)} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}`,
      discoveries,
      priorityCustomers,
      todayViewings: todayViewingItems,
      followUps,
      highIntentCount,
      myCustomerCount,
      unreadNotificationCount,
      // AI 是否可用由配置决定；不可用时前端会标注"显示规则化结果"
      aiAvailable: this.config.ai.provider !== 'mock',
      generatedAt: formatRelativeTime(now, now),
      durationMs: Date.now() - startedAt,
    };

    this.logger.log(
      `工作台数据生成完成：角色=${roleLabel} 机会=${openOpportunities.length} ` +
        `重点客户=${priorityCustomers.length} 带看=${todayViewingItems.length} 耗时=${result.durationMs}ms`,
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // 发现项
  // -------------------------------------------------------------------------

  /**
   * 构建「今天 AI 帮你发现了什么」。
   *
   * 这些数字必须来自真实查询，不能是装饰性的假数据 ——
   * 经纪人会照着它决定今天干什么。
   */
  private async buildDiscoveries(
    scope: ReturnType<TenantService['scope']>,
    opportunities: Array<{ type: string; customerId: string | null; propertyId: string | null }>,
    activeCustomerIds: Array<{ customerId: string }>,
    options: { seesAllCustomers: boolean; agentId: string; now: Date },
  ): Promise<DashboardDiscovery[]> {
    const { seesAllCustomers, agentId, now } = options;

    // 按类型统计机会
    const countByType = new Map<string, number>();
    for (const opportunity of opportunities) {
      countByType.set(opportunity.type, (countByType.get(opportunity.type) ?? 0) + 1);
    }

    // 新出现的高匹配房源：最近 3 天内生成、分数 ≥ 80 的匹配
    const newHighMatches = await scope.count('CustomerPropertyMatch', {
      score: { gte: 80 },
      createdAt: { gte: addDays(now, -3) },
      ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
    });

    // 沉睡客户重新活跃：状态为 DORMANT 但近 3 天有行为的客户
    const dormantReactivated = await scope.count('Customer', {
      deletedAt: null,
      status: CustomerStatus.DORMANT,
      lastActiveAt: { gte: addDays(now, -3) },
      ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
    });

    // 需求变化：近 7 天检测到漂移的客户
    const preferenceChanged = await scope.count('Customer', {
      deletedAt: null,
      preferenceDriftScore: { gte: 0.35 },
      profileUpdatedAt: { gte: addDays(now, -7) },
      ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
    });

    // 重复查看同一套房源的客户（强意向信号）
    const revisitOpportunities = countByType.get(OpportunityType.CUSTOMER_REVISIT) ?? 0;

    // 活跃客户数（近 3 天有行为）
    const activeCustomerCount = activeCustomerIds.length;

    const discoveries: DashboardDiscovery[] = [
      {
        key: 'opportunities_total',
        label: '个待处理的成交机会',
        count: opportunities.length,
        link: '/opportunities',
        emphasis: 'PRIMARY',
      },
      {
        key: 'price_drop',
        label: '套客户关注房源降价',
        count: countByType.get(OpportunityType.PRICE_DROP) ?? 0,
        link: '/opportunities?type=PRICE_DROP',
        emphasis: 'PRIMARY',
      },
      {
        key: 'new_match',
        label: '套新房源高度匹配客户',
        count: newHighMatches,
        link: '/matches',
        emphasis: 'PRIMARY',
      },
      {
        key: 'preference_drift',
        label: '个客户需求发生变化',
        count: preferenceChanged,
        link: '/customers?filter=drift',
        emphasis: 'SECONDARY',
      },
      {
        key: 'dormant_reactivated',
        label: '个沉睡客户重新活跃',
        count: dormantReactivated,
        link: '/customers?status=DORMANT',
        emphasis: 'SECONDARY',
      },
      {
        key: 'revisit',
        label: '个客户重复查看同一套房',
        count: revisitOpportunities,
        link: '/opportunities?type=CUSTOMER_REVISIT',
        emphasis: 'SECONDARY',
      },
      {
        key: 'active_customers',
        label: '个客户近 3 天有浏览行为',
        count: activeCustomerCount,
        link: '/customers?sortBy=lastActiveAt',
        emphasis: 'SECONDARY',
      },
    ];

    return discoveries;
  }

  // -------------------------------------------------------------------------
  // 重点客户
  // -------------------------------------------------------------------------

  /**
   * 构建今日重点客户列表。
   *
   * 核心逻辑：从机会反查客户，聚合每个客户的所有机会，
   * 用最高优先级的机会作为"为什么要联系他"。
   * 没有任何机会但有高意向分的客户也会被纳入（避免遗漏）。
   */
  private async buildPriorityCustomers(
    scope: ReturnType<TenantService['scope']>,
    opportunities: Array<{
      id: string;
      customerId: string | null;
      type: string;
      priority: string;
      title: string;
      reason: string;
      suggestion: string;
      valueScore: number;
      suggestedContactBy: Date | null;
      matchScore: number | null;
      createdAt: Date;
    }>,
    seesAllCustomers: boolean,
    agentId: string,
  ): Promise<DashboardPriorityCustomer[]> {
    // 按客户聚合机会，保留最高优先级的那条
    const byCustomer = new Map<
      string,
      {
        topOpportunity: (typeof opportunities)[number];
        opportunityCount: number;
      }
    >();

    for (const opportunity of opportunities) {
      if (!opportunity.customerId) continue;

      const existing = byCustomer.get(opportunity.customerId);
      if (!existing) {
        byCustomer.set(opportunity.customerId, { topOpportunity: opportunity, opportunityCount: 1 });
        continue;
      }

      existing.opportunityCount += 1;

      // 比较优先级，相同则比值分
      const currentRank = OPPORTUNITY_PRIORITY_RANK[opportunity.priority as OpportunityPriority] ?? 0;
      const existingRank =
        OPPORTUNITY_PRIORITY_RANK[existing.topOpportunity.priority as OpportunityPriority] ?? 0;

      if (
        currentRank > existingRank ||
        (currentRank === existingRank && opportunity.valueScore > existing.topOpportunity.valueScore)
      ) {
        existing.topOpportunity = opportunity;
      }
    }

    const customerIds = [...byCustomer.keys()];
    if (customerIds.length === 0) return [];

    // 一次查出所有相关客户，避免 N+1
    const customers = await scope.findMany<{
      id: string;
      name: string;
      phone: string;
      status: string;
      intentLevel: string | null;
      intentScore: number | null;
      lastContactAt: Date | null;
      lastActiveAt: Date | null;
    }>('Customer', {
      where: {
        id: { in: customerIds },
        deletedAt: null,
        ...(seesAllCustomers ? {} : { assignedAgentId: agentId }),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        status: true,
        intentLevel: true,
        intentScore: true,
        lastContactAt: true,
        lastActiveAt: true,
      },
    });

    const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
    const now = new Date();

    const priorityCustomers: DashboardPriorityCustomer[] = [];

    for (const [customerId, aggregate] of byCustomer) {
      const customer = customerMap.get(customerId);
      if (!customer) continue;

      const opportunity = aggregate.topOpportunity;

      // 建议联系时间：优先用机会上的，其次按优先级给默认值
      let suggestedContactBy = opportunity.suggestedContactBy
        ? this.formatContactDeadline(opportunity.suggestedContactBy, now)
        : null;

      if (!suggestedContactBy) {
        const priority = opportunity.priority as OpportunityPriority;
        suggestedContactBy =
          priority === OpportunityPriority.URGENT
            ? '今天上午 10 点前'
            : priority === OpportunityPriority.HIGH
              ? '今天内'
              : '两天内';
      }

      priorityCustomers.push({
        customerId: customer.id,
        name: customer.name,
        phoneMasked: maskPhone(customer.phone),
        status: customer.status,
        intentLevel: customer.intentLevel,
        intentScore: customer.intentScore ?? 0,
        // 多个机会时把数量说清楚，让经纪人知道这个客户"很热"
        reason:
          aggregate.opportunityCount > 1
            ? `${opportunity.reason}（另有 ${aggregate.opportunityCount - 1} 条相关机会）`
            : opportunity.reason,
        suggestion: opportunity.suggestion,
        suggestedContactBy,
        topOpportunityType:
          OPPORTUNITY_TYPE_LABELS[opportunity.type as OpportunityType] ?? opportunity.type,
        topOpportunityPriority: opportunity.priority,
        opportunityId: opportunity.id,
        lastActiveAt: customer.lastActiveAt ? formatRelativeTime(customer.lastActiveAt, now) : null,
        daysSinceLastContact: customer.lastContactAt ? daysBetween(customer.lastContactAt, now) : null,
        // 用于排序
        ...({ _valueScore: opportunity.valueScore } as object),
      } as DashboardPriorityCustomer);
    }

    // 排序：优先级 → 价值分 → 意向分 → 最近活跃
    //
    // 注意这里用的是**综合排序分**而不是单纯比较优先级。
    // 原因（这是一个真实踩过的坑）：如果只看优先级，一个意向分 35 的客户
    // 会因为"降价 30 万"被判为紧急，而排在意向分 78 的客户前面 ——
    // 但经纪人有限的时间应该给更可能成交的客户。
    // 因此把意向分与机会价值分融合进排序分，让"高意向 + 高价值机会"浮到顶部。
    const withScore = priorityCustomers as Array<
      DashboardPriorityCustomer & { _valueScore: number }
    >;

    withScore.sort((a, b) => {
      const rankA = OPPORTUNITY_PRIORITY_RANK[a.topOpportunityPriority as OpportunityPriority] ?? 0;
      const rankB = OPPORTUNITY_PRIORITY_RANK[b.topOpportunityPriority as OpportunityPriority] ?? 0;

      // 综合排序分：机会价值分权重更高（它已包含时效性），意向分作为修正
      const sortScoreA = a._valueScore * 0.6 + a.intentScore * 0.4;
      const sortScoreB = b._valueScore * 0.6 + b.intentScore * 0.4;

      // 优先级相差一级以上时才让优先级说了算，避免同级别内的次序被它主导
      if (Math.abs(rankA - rankB) >= 2) return rankB - rankA;
      if (Math.abs(sortScoreA - sortScoreB) > 3) return sortScoreB - sortScoreA;
      if (rankA !== rankB) return rankB - rankA;
      return b.intentScore - a.intentScore;
    });

    // 清理排序用的临时字段，避免泄漏到 API 响应
    return withScore.slice(0, MAX_PRIORITY_CUSTOMERS).map((item) => {
      const { _valueScore: _ignored, ...rest } = item;
      return rest;
    });
  }

  /**
   * 把建议联系时间转成人类可读文案。
   * 例：今天 09:30 → "今天上午 9:30 前"；已过期 → "已超时"
   */
  private formatContactDeadline(deadline: Date, now: Date): string {
    const diffHours = (deadline.getTime() - now.getTime()) / 3_600_000;

    if (diffHours < 0) return '已超时，尽快联系';
    if (diffHours <= 3) return '现在就该联系';

    const hours = String(deadline.getHours()).padStart(2, '0');
    const minutes = String(deadline.getMinutes()).padStart(2, '0');
    const timeText = `${hours}:${minutes}`;

    if (daysBetween(now, deadline) === 0) {
      const hour = deadline.getHours();
      const period = hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上';
      return `今天${period} ${timeText} 前`;
    }

    return `${formatDate(deadline)} ${timeText} 前`;
  }

  /** 取经纪人姓名用于问候语 */
  private async resolveAgentName(
    scope: ReturnType<TenantService['scope']>,
    agentId: string,
  ): Promise<string> {
    const user = await scope.findFirst<{ name: string }>('User', {
      where: { id: agentId },
      select: { name: true },
    });
    return user?.name ?? '';
  }
}
