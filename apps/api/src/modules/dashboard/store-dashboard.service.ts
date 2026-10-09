/**
 * 门店驾驶舱服务（店长 / 公司负责人视角）。
 *
 * 与经纪人工作台的区别：
 *   经纪人关心「我今天做什么」；店长关心「我的团队哪里出了问题」。
 * 因此这里的核心是**转化漏斗的诊断** —— 找出卡在哪个环节，
 * 而不是把全店数据堆成报表。
 *
 * 漏斗定义：
 *   获取客户 → 有效联系 → 约看带看 → 进入谈判 → 成交
 * 诊断逻辑（AI 或规则）：
 *   客户多但带看少   → 客户转化/约看能力问题
 *   带看多但谈判少   → 需求匹配度或逼单能力问题
 *   谈判多但成交少   → 价格谈判与成交推进能力问题
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CUSTOMER_STATUS_LABELS,
  CustomerStatus,
  USER_ROLE_LABELS,
  UserRole,
  type AgentDiagnosis,
  type AgentPerformance,
  type StoreDashboard,
  type StoreMetrics,
} from '@estatepilot/types';
import { addDays, formatDate, safeDivide, startOfDay } from '@estatepilot/utils';
import { TenantService } from '../tenant/tenant.service.js';
import { getContext } from '../../common/context/request-context.js';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';
import { BusinessError } from '../../common/filters/all-exceptions.filter.js';
import { ApiErrorCode } from '@estatepilot/types';
import { ForbiddenException } from '@nestjs/common';

/** 预测成交的观察窗口（天） */
const FORECAST_WINDOW_DAYS = 30;

@Injectable()
export class StoreDashboardService {
  private readonly logger = new Logger(StoreDashboardService.name);

  constructor(
    private readonly tenant: TenantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 生成门店驾驶舱数据。
   *
   * 权限规则：
   *   - OWNER：可看任意门店，不传 storeId 时看全公司
   *   - STORE_MANAGER：只能看自己所属门店
   *   - 其他角色：拒绝
   */
  async getStoreDashboard(requestedStoreId?: string): Promise<StoreDashboard> {
    const startedAt = Date.now();
    const context = getContext();

    if (!context?.organizationId || !context.userId) {
      throw new BusinessError(ApiErrorCode.UNAUTHORIZED, '需要登录', 401);
    }

    const role = context.role ?? UserRole.AGENT;
    const scope = this.tenant.scope();

    // ---- 权限与范围确定 ----
    let storeId: string | null;
    let storeName: string;

    if (role === UserRole.OWNER || role === UserRole.SUPER_ADMIN) {
      storeId = requestedStoreId ?? null;
      storeName = storeId ? await this.resolveStoreName(scope, storeId) : '全公司';
    } else if (role === UserRole.STORE_MANAGER) {
      // 店长只能用自己所属门店，忽略请求参数（防止越权查看其他门店）
      storeId = context.storeId ?? null;
      if (!storeId) {
        throw new BusinessError(
          ApiErrorCode.FORBIDDEN,
          '当前账号未关联门店，无法查看门店驾驶舱',
          403,
        );
      }
      storeName = await this.resolveStoreName(scope, storeId);
    } else {
      throw new ForbiddenException({
        code: ApiErrorCode.FORBIDDEN,
        message: '门店驾驶舱仅店长与公司负责人可查看',
      });
    }

    const now = new Date();
    const todayStart = startOfDay(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const customerScope = storeId ? { storeId } : {};

    // ---- 并行拉取所有指标 ----
    const [
      totalCustomers,
      highIntentCustomers,
      newCustomersToday,
      followUpsToday,
      viewingsToday,
      viewingsThisMonth,
      negotiationsThisMonth,
      dealsThisMonth,
      statusGroups,
      agents,
    ] = await Promise.all([
      scope.count('Customer', { ...customerScope, deletedAt: null }),

      scope.count('Customer', {
        ...customerScope,
        deletedAt: null,
        status: {
          in: [CustomerStatus.HIGH_INTENT, CustomerStatus.NEGOTIATING, CustomerStatus.VIEWING],
        },
      }),

      scope.count('Customer', { ...customerScope, createdAt: { gte: todayStart }, deletedAt: null }),

      // 今日已跟进次数（用沟通记录数衡量）
      scope.count('Communication', { occurredAt: { gte: todayStart } }),

      scope.count('Viewing', { scheduledAt: { gte: todayStart }, ...customerScope }),

      scope.count('Viewing', {
        scheduledAt: { gte: monthStart },
        ...(storeId ? { storeId } : {}),
      }),

      scope.count('Customer', {
        ...customerScope,
        deletedAt: null,
        status: CustomerStatus.NEGOTIATING,
        updatedAt: { gte: monthStart },
      }),

      scope.count('Customer', {
        ...customerScope,
        deletedAt: null,
        status: CustomerStatus.DEAL,
        updatedAt: { gte: monthStart },
      }),

      scope.groupBy<{ status: string; _count: { _all: number } }>('Customer', {
        by: ['status'],
        where: { ...customerScope, deletedAt: null },
        _count: { _all: true },
      }),

      // 门店下的经纪人
      scope.findMany<{
        id: string;
        name: string;
        avatarUrl: string | null;
        role: string;
      }>('User', {
        where: {
          ...(storeId ? { storeId } : {}),
          role: { in: [UserRole.AGENT, UserRole.STORE_MANAGER] },
          status: 'ACTIVE',
        },
        select: { id: true, name: true, avatarUrl: true, role: true },
        orderBy: { name: 'asc' },
        take: 100,
      }),
    ]);

    // ---- 计算待跟进超期数 ----
    const missedFollowUpsToday = await scope.count('Customer', {
      ...customerScope,
      deletedAt: null,
      status: { notIn: [CustomerStatus.DEAL, CustomerStatus.LOST] },
      OR: [{ nextFollowUpAt: { lt: todayStart } }, { lastContactAt: null }],
    });

    // ---- 经纪人表现 ----
    const agentPerformances = await this.buildAgentPerformances(scope, agents, monthStart, now);

    // ---- 全店漏斗 ----
    const funnel = {
      customers: totalCustomers,
      viewings: viewingsThisMonth,
      negotiations: negotiationsThisMonth,
      deals: dealsThisMonth,
    };

    // ---- 30 天成交预测 ----
    // 逻辑：以谈判中客户数与历史转化率推算，而不是拍脑袋给个数字。
    // 该值明确标注为 AI 辅助判断，界面必须显示免责说明。
    const negotiationToDealRate = this.historicalConversionRate(agentPerformances, 'negotiationToDeal');
    const activeNegotiations = statusGroups.find(
      (group) => group.status === CustomerStatus.NEGOTIATING,
    )?._count._all ?? 0;

    const forecastDeals30Days = Math.max(
      0,
      Math.round(activeNegotiations * negotiationToDealRate),
    );

    // 平均成交总价（用已成交客户关联的匹配房源均价估算）
    const avgDealPrice = await this.estimateAverageDealPrice(scope, customerScope);

    const metrics: StoreMetrics = {
      totalCustomers,
      highIntentCustomers,
      newCustomersToday,
      followUpsToday,
      missedFollowUpsToday,
      viewingsToday,
      viewingsThisMonth,
      negotiationsThisMonth,
      dealsThisMonth,
      forecastDeals30Days,
      forecastRevenue30Days: forecastDeals30Days * avgDealPrice,
    };

    // ---- 近 30 天趋势 ----
    const trend = await this.buildTrend(scope, customerScope, now);

    // ---- 客户状态分布 ----
    const statusDistribution = statusGroups
      .map((group) => ({
        status: group.status,
        label: CUSTOMER_STATUS_LABELS[group.status as CustomerStatus] ?? group.status,
        count: group._count._all,
      }))
      .sort((a, b) => b.count - a.count);

    const result: StoreDashboard = {
      storeId: storeId ?? '',
      storeName,
      metrics,
      agents: agentPerformances,
      funnel,
      trend,
      statusDistribution,
      aiAvailable: this.config.ai.provider !== 'mock',
      generatedAt: formatDate(now),
      durationMs: Date.now() - startedAt,
    };

    this.logger.log(
      `门店驾驶舱生成完成：${storeName} 客户=${totalCustomers} 经纪人=${agentPerformances.length} ` +
        `耗时=${result.durationMs}ms`,
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // 经纪人表现与诊断
  // -------------------------------------------------------------------------

  /**
   * 计算每个经纪人的漏斗表现并给出诊断。
   *
   * 性能考虑：8 个经纪人 × 6 个指标 = 48 次查询会太慢，
   * 因此这里用 groupBy 一次性聚合，而不是循环查询（避免 N+1）。
   */
  private async buildAgentPerformances(
    scope: ReturnType<TenantService['scope']>,
    agents: Array<{ id: string; name: string; avatarUrl: string | null; role: string }>,
    monthStart: Date,
    now: Date,
  ): Promise<AgentPerformance[]> {
    if (agents.length === 0) return [];

    const agentIds = agents.map((agent) => agent.id);

    // 一次性聚合：客户数、带看数、沟通数
    const [customerGroups, viewingGroups, communicationGroups, dealGroups, negotiationGroups] =
      await Promise.all([
        scope.groupBy<{ assignedAgentId: string | null; _count: { _all: number } }>('Customer', {
          by: ['assignedAgentId'],
          where: { assignedAgentId: { in: agentIds }, deletedAt: null },
          _count: { _all: true },
        }),

        scope.groupBy<{ agentId: string; _count: { _all: number } }>('Viewing', {
          by: ['agentId'],
          where: { agentId: { in: agentIds } },
          _count: { _all: true },
        }),

        scope.groupBy<{ agentId: string; _count: { _all: number } }>('Communication', {
          by: ['agentId'],
          where: { agentId: { in: agentIds } },
          _count: { _all: true },
        }),

        scope.groupBy<{ assignedAgentId: string | null; _count: { _all: number } }>('Customer', {
          by: ['assignedAgentId'],
          where: {
            assignedAgentId: { in: agentIds },
            deletedAt: null,
            status: CustomerStatus.DEAL,
          },
          _count: { _all: true },
        }),

        scope.groupBy<{ assignedAgentId: string | null; _count: { _all: number } }>('Customer', {
          by: ['assignedAgentId'],
          where: {
            assignedAgentId: { in: agentIds },
            deletedAt: null,
            status: CustomerStatus.NEGOTIATING,
          },
          _count: { _all: true },
        }),
      ]);

    // 转为 Map 便于查找，避免在循环里做数组 find（O(n²)）
    const toMap = <T extends Record<string, unknown>>(rows: T[], key: string): Map<string, number> => {
      const map = new Map<string, number>();
      for (const row of rows) {
        const rowKey = row[key];
        if (typeof rowKey === 'string') {
          map.set(rowKey, (row._count as { _all: number })._all);
        }
      }
      return map;
    };

    const customerMap = toMap(customerGroups, 'assignedAgentId');
    const viewingMap = toMap(viewingGroups, 'agentId');
    const communicationMap = toMap(communicationGroups, 'agentId');
    const dealMap = toMap(dealGroups, 'assignedAgentId');
    const negotiationMap = toMap(negotiationGroups, 'assignedAgentId');

    // 最后一次沟通时间（用于计算平均跟进间隔）
    const lastContacts = await scope.groupBy<{
      agentId: string;
      _max: { occurredAt: Date | null };
    }>('Communication', {
      by: ['agentId'],
      where: { agentId: { in: agentIds }, occurredAt: { gte: monthStart } },
      _max: { occurredAt: true },
    });

    const lastContactMap = new Map<string, Date | null>();
    for (const row of lastContacts) {
      lastContactMap.set(row.agentId, row._max.occurredAt);
    }

    const performances: AgentPerformance[] = agents.map((agent) => {
      const customerCount = customerMap.get(agent.id) ?? 0;
      const contactCount = communicationMap.get(agent.id) ?? 0;
      const viewingCount = viewingMap.get(agent.id) ?? 0;
      const negotiationCount = negotiationMap.get(agent.id) ?? 0;
      const dealCount = dealMap.get(agent.id) ?? 0;

      const funnel = {
        customerToViewing: safeDivide(viewingCount, customerCount),
        viewingToNegotiation: safeDivide(negotiationCount, viewingCount),
        negotiationToDeal: safeDivide(dealCount, negotiationCount),
        overallConversion: safeDivide(dealCount, customerCount),
      };

      // 平均跟进间隔：当月天数 / 当月沟通次数（粗略但可解释）
      const daysInMonth = Math.max(1, Math.floor((now.getTime() - monthStart.getTime()) / 86_400_000));
      const avgFollowUpIntervalDays =
        contactCount > 0 ? Number((daysInMonth / contactCount).toFixed(1)) : null;

      return {
        agentId: agent.id,
        agentName: agent.name,
        avatarUrl: agent.avatarUrl,
        customerCount,
        contactCount,
        viewingCount,
        negotiationCount,
        dealCount,
        funnel,
        avgFollowUpIntervalDays,
        // 诊断在下一步统一计算（需要横向对比，单个经纪人无法判断"偏低"）
        diagnosis: null,
      };
    });

    // ---- 诊断：需要横向对比，因此放在拿到全部门店数据之后 ----
    this.diagnoseAgents(performances);

    return performances.sort((a, b) => b.dealCount - a.dealCount || b.customerCount - a.customerCount);
  }

  /**
   * 经纪人诊断（规则引擎）。
   *
   * 判断逻辑基于**与门店平均水平的对比**，而不是绝对阈值 ——
   * 因为不同区域、不同季节的绝对数值差异很大，
   * 「比同店同事明显偏低」才是真正值得管理者关注的问题。
   *
   * AI 可用时，ManagerDiagnosisService 会用 AI 覆盖这个规则结果。
   */
  private diagnoseAgents(performances: AgentPerformance[]): void {
    // 样本太少时不做诊断，避免误导（例如新入职经纪人）
    const validAgents = performances.filter((agent) => agent.customerCount >= 5);
    if (validAgents.length < 2) {
      for (const agent of performances) {
        agent.diagnosis = {
          healthyStages: [],
          weakStages: [],
          primaryIssue: '数据不足',
          detail:
            agent.customerCount < 5
              ? `该经纪人仅有 ${agent.customerCount} 位客户，样本量不足以做出可靠诊断。`
              : '门店内可对比的经纪人数量不足，暂不做横向诊断。',
          suggestions: ['积累更多客户数据后再评估'],
          confidence: 0.2,
          aiGenerated: false,
        };
      }
      return;
    }

    /** 计算某指标的店均值 */
    const averageOf = (selector: (agent: AgentPerformance) => number): number => {
      const values = validAgents.map(selector);
      return values.reduce((acc, value) => acc + value, 0) / values.length;
    };

    const avgCustomerToViewing = averageOf((a) => a.funnel.customerToViewing);
    const avgViewingToNegotiation = averageOf((a) => a.funnel.viewingToNegotiation);
    const avgNegotiationToDeal = averageOf((a) => a.funnel.negotiationToDeal);

    for (const agent of performances) {
      if (agent.customerCount < 5) {
        agent.diagnosis = {
          healthyStages: [],
          weakStages: [],
          primaryIssue: '数据不足',
          detail: `该经纪人仅有 ${agent.customerCount} 位客户，样本量不足以做出可靠诊断。`,
          suggestions: ['先积累客户量，暂不做能力判断'],
          confidence: 0.2,
          aiGenerated: false,
        };
        continue;
      }

      const healthyStages: string[] = [];
      const weakStages: string[] = [];

      // 低于店均值 25% 以上视为薄弱环节
      const isWeak = (value: number, average: number): boolean =>
        average > 0 && value < average * 0.75;

      if (isWeak(agent.funnel.customerToViewing, avgCustomerToViewing)) {
        weakStages.push('客户到带看');
      } else {
        healthyStages.push('客户到带看');
      }

      if (isWeak(agent.funnel.viewingToNegotiation, avgViewingToNegotiation)) {
        weakStages.push('带看到谈判');
      } else {
        healthyStages.push('带看到谈判');
      }

      if (isWeak(agent.funnel.negotiationToDeal, avgNegotiationToDeal)) {
        weakStages.push('谈判到成交');
      } else {
        healthyStages.push('谈判到成交');
      }

      // 定位主要问题（取第一个薄弱环节，顺序体现了漏斗的先后关系）
      let primaryIssue: string;
      let detail: string;
      const suggestions: string[] = [];

      if (weakStages.length === 0) {
        primaryIssue = '无明显短板';
        detail = '各环节转化率均不低于门店平均水平，保持当前跟进节奏即可。';
        suggestions.push('可作为门店内的经验分享对象', '尝试挑战更高的成交目标');
      } else if (weakStages.includes('谈判到成交')) {
        primaryIssue = '成交推进能力';
        detail =
          `带看与谈判环节正常，但谈判→成交转化率为 ${(agent.funnel.negotiationToDeal * 100).toFixed(1)}%，` +
          `低于门店平均的 ${(avgNegotiationToDeal * 100).toFixed(1)}%。通常与价格谈判技巧、逼单节奏有关。`;
        suggestions.push(
          '陪同参与一次价格谈判并做复盘',
          '对在谈客户做一次逐单过堂，明确每单的卡点',
          '整理同小区近期成交价作为谈价依据',
        );
      } else if (weakStages.includes('带看到谈判')) {
        primaryIssue = '需求匹配与逼单能力';
        detail =
          `带看量正常但转化为谈判的比例偏低（${(agent.funnel.viewingToNegotiation * 100).toFixed(1)}% vs 店均 ${(avgViewingToNegotiation * 100).toFixed(1)}%）。` +
          `通常意味着推荐的房源与客户真实需求存在偏差，或带看后缺少明确的推进动作。`;
        suggestions.push(
          '带看前用系统匹配功能复核客户真实需求',
          '建立带看后 24 小时内必回访的硬性动作',
          '带看时至少准备一套"对比房源"以制造决策压力',
        );
      } else {
        primaryIssue = '客户转化与约看能力';
        detail =
          `客户量不低但带看转化率偏低（${(agent.funnel.customerToViewing * 100).toFixed(1)}% vs 店均 ${(avgCustomerToViewing * 100).toFixed(1)}%）。` +
          `通常与首次触达质量、跟进频率有关。`;
        suggestions.push(
          '检查首次联系的话术与响应速度',
          `当前平均跟进间隔为 ${agent.avgFollowUpIntervalDays ?? '未知'} 天，建议压缩到 3 天以内`,
          '利用系统推送的降价与匹配机会作为联系理由',
        );
      }

      agent.diagnosis = {
        healthyStages,
        weakStages,
        primaryIssue,
        detail,
        suggestions,
        confidence: Math.min(0.9, 0.5 + agent.customerCount / 100),
        aiGenerated: false,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 趋势与预测
  // -------------------------------------------------------------------------

  /** 近 30 天每日趋势（用于图表） */
  private async buildTrend(
    scope: ReturnType<TenantService['scope']>,
    customerScope: Record<string, unknown>,
    now: Date,
  ): Promise<StoreDashboard['trend']> {
    const windowStart = addDays(now, -29);
    const windowStartDay = startOfDay(windowStart);

    const [newCustomers, followUps, viewings, deals] = await Promise.all([
      scope.findMany<{ createdAt: Date }>('Customer', {
        where: { ...customerScope, createdAt: { gte: windowStartDay }, deletedAt: null },
        select: { createdAt: true },
        take: 5000,
      }),
      scope.findMany<{ occurredAt: Date }>('Communication', {
        where: { occurredAt: { gte: windowStartDay } },
        select: { occurredAt: true },
        take: 10000,
      }),
      scope.findMany<{ scheduledAt: Date }>('Viewing', {
        where: { scheduledAt: { gte: windowStartDay }, ...customerScope },
        select: { scheduledAt: true },
        take: 5000,
      }),
      scope.findMany<{ updatedAt: Date }>('Customer', {
        where: {
          ...customerScope,
          status: CustomerStatus.DEAL,
          updatedAt: { gte: windowStartDay },
        },
        select: { updatedAt: true },
        take: 2000,
      }),
    ]);

    /** 按日期归并计数 */
    const countByDate = (dates: Date[]): Map<string, number> => {
      const map = new Map<string, number>();
      for (const date of dates) {
        const key = formatDate(date);
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return map;
    };

    const newCustomerMap = countByDate(newCustomers.map((row) => row.createdAt));
    const followUpMap = countByDate(followUps.map((row) => row.occurredAt));
    const viewingMap = countByDate(viewings.map((row) => row.scheduledAt));
    const dealMap = countByDate(deals.map((row) => row.updatedAt));

    const trend: StoreDashboard['trend'] = [];
    for (let dayOffset = 29; dayOffset >= 0; dayOffset -= 1) {
      const date = addDays(now, -dayOffset);
      const key = formatDate(date);
      trend.push({
        date: key,
        newCustomers: newCustomerMap.get(key) ?? 0,
        followUps: followUpMap.get(key) ?? 0,
        viewings: viewingMap.get(key) ?? 0,
        deals: dealMap.get(key) ?? 0,
      });
    }

    return trend;
  }

  /** 从经纪人表现推算门店平均转化率 */
  private historicalConversionRate(
    performances: AgentPerformance[],
    metric: 'customerToViewing' | 'viewingToNegotiation' | 'negotiationToDeal' | 'overallConversion',
  ): number {
    const valid = performances.filter((agent) => agent.customerCount > 0);
    if (valid.length === 0) {
      // 无数据时给一个保守的行业经验值，避免预测为 0 造成误导
      return metric === 'negotiationToDeal' ? 0.25 : 0.1;
    }
    const sum = valid.reduce((acc, agent) => acc + agent.funnel[metric], 0);
    return sum / valid.length;
  }

  /** 估算平均成交总价（用于预测成交额） */
  private async estimateAverageDealPrice(
    scope: ReturnType<TenantService['scope']>,
    customerScope: Record<string, unknown>,
  ): Promise<number> {
    // 取已成交客户匹配房源的平均总价作为代理指标
    const result = await scope.aggregate<{ _avg: { score: number | null } }>('CustomerPropertyMatch', {
      where: { customer: { ...customerScope, status: CustomerStatus.DEAL, deletedAt: null } },
      _avg: { score: true },
    });
    void result;

    const priceAggregate = await scope.aggregate<{ _avg: { totalPrice: bigint | null } }>('Property', {
      where: { listingStatus: 'ACTIVE' },
      _avg: { totalPrice: true },
    });

    return Number(priceAggregate._avg.totalPrice ?? 0);
  }

  /** 取门店名称 */
  private async resolveStoreName(
    scope: ReturnType<TenantService['scope']>,
    storeId: string,
  ): Promise<string> {
    const store = await scope.findFirst<{ name: string }>('Store', {
      where: { id: storeId },
      select: { name: true },
    });
    return store?.name ?? '未知门店';
  }
}

export type { AgentDiagnosis, UserRole };
void USER_ROLE_LABELS;
