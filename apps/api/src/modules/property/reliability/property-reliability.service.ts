/**
 * 房源数据可信度策略（Phase 12）。
 *
 * ============================================================================
 * 为什么需要这个服务
 * ============================================================================
 * 房源数据来自不同渠道，可信度差别巨大：
 *   贝壳实时 API    → 刚查到的，可以放心发
 *   公司自有房源    → 自己维护的，可信
 *   经纪人手动录入  → 可能是几周前抄的，需要确认
 *   本地缓存        → 历史快照，可能已成交
 *   演示数据        → **绝不能进生产推荐**
 *
 * 把"这条数据有多可信"显式建模，而不是靠代码里的隐式假设 ——
 * 否则经纪人会把过期/演示房源发给客户，这是**不可接受的错误**。
 *
 * ============================================================================
 * 两条硬性规则
 * ============================================================================
 * 1. **DEMO 数据可信度恒为 0**，且生产环境禁止进入任何推荐流程。
 *    （需求 §3、§13：禁止为了展示效果加入假房源）
 *
 * 2. **可信度不参与"需求匹配度"计算**，只作为独立维度影响最终排序。
 *    （需求 §5：不要让来源名称影响评分，只影响真实性权重）
 *    因此本服务的输出永远与 MatchScore 分开传递，不混入打分函数。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  VERIFICATION_TTL,
  type PropertyProviderV2,
  type PropertySourceType,
  type ProviderCapability,
} from '@estatepilot/types';

/** 环境类型 */
export type AppEnvironment = 'development' | 'test' | 'production';

/** 可信度评估结果 */
export interface ReliabilityAssessment {
  /** 0~100 的可信度分数（已按新鲜度衰减） */
  score: number;
  /** 核验状态 */
  status: 'VERIFIED' | 'PENDING' | 'EXPIRED';
  /** 是否"可以放心发给客户" */
  isSendable: boolean;
  /** 给经纪人看的说明（必须诚实，不隐藏风险） */
  note: string;
  /** 星级 1~5（用于界面展示） */
  stars: number;
  /** 评估所用的核验时间（原样透传，便于上层展示"多久前确认的"） */
  lastVerifiedAt: Date | null;
  /** 时效性得分 0~100（与 computeFinalScore 口径一致） */
  freshnessScore: number;
}

/** 评估输入 */
export interface ReliabilityAssessmentInput {
  /** 入库时的基础可信度 */
  baseScore: number;
  /** 核验有效期（小时）。null 表示该来源**无法核验** */
  ttlHours: number | null;
  /** 最后核验时间 */
  lastVerifiedAt: Date | null;
  /** 来源形态（用于给出准确的说明文案） */
  sourceType?: PropertySourceType;
  /**
   * 来源的展示名（如「贝壳」「本公司」「安居客」）。
   *
   * 为什么需要：说明文案必须准确。
   * 踩过的坑：早期实现把所有"无法核验"的情况都写成"来自人工录入"，
   * 导致贝壳**缓存数据**被错误描述为"人工录入" —— 经纪人会以为是谁手抄的。
   */
  sourceName?: string;
  /**
   * 是否为「降级取数」（贝壳不可用时读本地缓存）。
   *
   * 这类数据的说明必须明确写出"非实时"，因为它是**历史快照**，
   * 房源可能已经成交 —— 这是最需要提醒经纪人的场景。
   */
  fromCache?: boolean;
}

/** Demo 数据策略判定结果 */
export interface DemoPolicyDecision {
  /** 是否允许 Demo 数据参与推荐 */
  allowed: boolean;
  /** 不允许时的原因（直接展示给用户/日志） */
  reason: string | null;
}

@Injectable()
export class PropertyReliabilityService {
  private readonly logger = new Logger(PropertyReliabilityService.name);

  /** 当前环境 */
  private readonly environment: AppEnvironment;

  /** 是否显式允许 Demo 数据（仅开发环境可开） */
  private readonly allowDemoExplicitly: boolean;

  constructor() {
    const raw = (process.env.NODE_ENV ?? 'development').toLowerCase();
    this.environment =
      raw === 'production' ? 'production' : raw === 'test' ? 'test' : 'development';

    // 显式开关：即使开发环境，也要显式打开才允许 Demo 进推荐
    // （避免"默认就有 Demo"这种危险默认值）
    this.allowDemoExplicitly = process.env.ALLOW_DEMO_DATA === 'true';

    if (this.environment === 'production' && this.allowDemoExplicitly) {
      this.logger.error(
        '检测到生产环境设置了 ALLOW_DEMO_DATA=true —— 该配置**不会生效**。' +
          '生产环境永远禁止演示数据进入推荐流程。',
      );
    }

    this.logger.log(
      `可信度策略已加载：env=${this.environment}，` +
        `Demo 数据${this.isDemoAllowed().allowed ? '允许' : '禁止'}进入推荐`,
    );
  }

  // ==========================================================================
  // 一、Demo 数据隔离（需求 §3）
  // ==========================================================================

  /**
   * 判定 Demo 数据是否可以参与推荐。
   *
   * 规则（严格）：
   *   production → **永远禁止**（即使显式设置 ALLOW_DEMO_DATA=true 也不生效）
   *   test       → **永远禁止**（测试应验证真实逻辑）
   *   development → 需要 ALLOW_DEMO_DATA=true 才允许
   *
   * 为什么生产环境无视显式开关：
   *   这是一个"一票否决"的安全设计。演示数据出现在真实销售推荐里，
   *   会让经纪人把假房源发给客户 —— 后果比"少几个演示房源"严重得多。
   */
  isDemoAllowed(): DemoPolicyDecision {
    if (this.environment === 'production') {
      return {
        allowed: false,
        reason:
          '生产环境禁止演示数据进入推荐流程。请配置真实数据源' +
          '（贝壳官方凭证、本公司房源、或经纪人录入房源）。',
      };
    }

    if (this.environment === 'test') {
      return {
        allowed: false,
        reason: '测试环境禁止演示数据，以确保测试验证的是真实逻辑。',
      };
    }

    if (!this.allowDemoExplicitly) {
      return {
        allowed: false,
        reason:
          '开发环境默认也禁止演示数据进入推荐。如确需演示，' +
          '请显式设置环境变量 ALLOW_DEMO_DATA=true。',
      };
    }

    return { allowed: true, reason: null };
  }

  /** 便捷判定：某个来源类型是否为演示数据 */
  isDemoSource(sourceType: PropertySourceType): boolean {
    return sourceType === 'DEMO';
  }

  /** 当前环境 */
  getEnvironment(): AppEnvironment {
    return this.environment;
  }

  // ==========================================================================
  // 二、可信度评分
  // ==========================================================================

  /**
   * 根据 Provider 能力计算基础可信度（不做新鲜度衰减）。
   *
   * 用于**写入时**落库到 `Property.dataReliabilityScore`。
   */
  baseScoreOf(capability: ProviderCapability): number {
    return Math.max(0, Math.min(100, Math.round(capability.baseReliabilityScore)));
  }

  /** 从 Provider 实例取基础可信度 */
  baseScoreOfProvider(provider: PropertyProviderV2): number {
    return this.baseScoreOf(provider.capability);
  }

  /**
   * 完整评估（含新鲜度衰减）。
   *
   * 用于**读取时**决定"这条房源现在还能不能发"。
   *
   * @param baseScore       入库时的可信度
   * @param ttlHours        核验有效期（null = 无法核验）
   * @param lastVerifiedAt  最后核验时间
   */
  assess(params: ReliabilityAssessmentInput): ReliabilityAssessment {
    const { baseScore, ttlHours, lastVerifiedAt, sourceType, sourceName, fromCache } = params;
    const label = sourceName ?? '该来源';

    // ---- DEMO 恒为 0，且永远不可发送 ----
    if (sourceType === 'DEMO' || baseScore <= 0) {
      return {
        score: 0,
        status: 'PENDING',
        isSendable: false,
        note: '演示数据，禁止用于真实客户推荐',
        stars: 0,
        lastVerifiedAt,
        freshnessScore: 0,
      };
    }

    // ---- 降级取数（读本地缓存）----
    //
    // 这是**最需要提醒经纪人**的场景：数据是历史快照，房源可能已经成交。
    // 必须明确写出"非实时"，而不是含糊地说"需要确认"。
    //
    // 注意：文案里**不要用 markdown 标记**（如 **加粗**）——
    // 这些文字会原样显示在界面上，星号会露出来。
    if (fromCache) {
      return {
        score: baseScore,
        status: 'PENDING',
        isSendable: true,
        note: `${label}当前不可用，这是此前同步的历史快照，房源状态可能已变化。发送给客户前请先确认是否仍在售。`,
        stars: this.toStars(baseScore),
        lastVerifiedAt,
        freshnessScore: this.freshnessScore(lastVerifiedAt),
      };
    }

    // ---- 无法核验的来源（如经纪人手动上传）----
    // 诚实处理：不能假装它可信，也不能假装它过期 —— 就是"需要确认"
    if (ttlHours === null || lastVerifiedAt === null) {
      // 文案按来源类型区分，避免把所有情况都写成"人工录入"
      const reason =
        sourceType === 'USER_PROVIDED'
          ? '来自人工录入，系统无法实时核验'
          : '系统暂无渠道核验其在售状态';

      return {
        score: baseScore,
        status: 'PENDING',
        isSendable: true,
        note: `此房源${reason}。发送前请自行确认是否仍在售。`,
        stars: this.toStars(baseScore),
        lastVerifiedAt: null,
        freshnessScore: 0,
      };
    }

    // ---- 按新鲜度衰减 ----
    const ageHours = (Date.now() - lastVerifiedAt.getTime()) / 3_600_000;
    const freshnessScore = this.freshnessScore(lastVerifiedAt);

    if (ageHours <= ttlHours) {
      // 在有效期内：新鲜度越高分数越接近基础分
      // 线性衰减：刚核验时 = baseScore，到期时 = baseScore * 0.85
      const freshness = 1 - (ageHours / ttlHours) * 0.15;
      const score = Math.round(baseScore * freshness);

      return {
        score,
        status: 'VERIFIED',
        isSendable: true,
        note: `已在 ${this.describeAge(ageHours)}前确认在售`,
        stars: this.toStars(score),
        lastVerifiedAt,
        freshnessScore,
      };
    }

    // ---- 超过有效期：EXPIRED ----
    // 分数按超出时长继续衰减，但不归零（房源本身可能仍有效，只是需要重新确认）
    const overdueHours = ageHours - ttlHours;
    const decayFactor = Math.max(0.4, 1 - overdueHours / (ttlHours * 4));
    const score = Math.round(baseScore * decayFactor);

    return {
      score,
      status: 'EXPIRED',
      isSendable: true, // 仍可推荐，但界面必须提示需重新确认
      note: `最后一次确认在 ${this.describeAge(ageHours)}前，已超出核验时效（${ttlHours} 小时）。发送前请重新确认是否仍在售。`,
      stars: this.toStars(score),
      lastVerifiedAt,
      freshnessScore,
    };
  }

  /**
   * 计算**综合排序分**（需求 §5）。
   *
   *   FinalScore = 需求匹配度 × 0.7 + 数据可信度 × 0.2 + 时效性 × 0.1
   *
   * 为什么这样分配权重：
   *   - 需求匹配度 70%：产品的核心价值是"给客户找到对的房子"，
   *     匹配度必须主导排序，否则会推出"可信但不合适"的房源
   *   - 数据可信度 20%：同样匹配的两套，更可信的优先
   *   - 时效性 10%：刚核验过的排前面
   *
   * ⚠️ **来源名称不参与任何计算** —— 只有量化的可信度分数参与。
   * 这满足了需求 §5「不要让来源名称影响评分，只影响真实性权重」。
   */
  computeFinalScore(params: {
    matchScore: number;
    dataReliabilityScore: number;
    lastVerifiedAt: Date | null;
  }): { finalScore: number; matchComponent: number; reliabilityComponent: number; freshnessComponent: number } {
    const matchComponent = Math.max(0, Math.min(100, params.matchScore)) * 0.7;
    const reliabilityComponent =
      Math.max(0, Math.min(100, params.dataReliabilityScore)) * 0.2;
    const freshnessComponent = this.freshnessScore(params.lastVerifiedAt) * 0.1;

    return {
      finalScore: Math.round((matchComponent + reliabilityComponent + freshnessComponent) * 10) / 10,
      matchComponent: Math.round(matchComponent * 10) / 10,
      reliabilityComponent: Math.round(reliabilityComponent * 10) / 10,
      freshnessComponent: Math.round(freshnessComponent * 10) / 10,
    };
  }

  /**
   * 时效性得分 0~100。
   *
   * 阶梯式而非线性 —— 因为经纪人的判断是定性的：
   * "刚查的"和"一小时前查的"没区别，但"三天前查的"就要警惕了。
   */
  freshnessScore(lastVerifiedAt: Date | null): number {
    if (!lastVerifiedAt) return 0;

    const ageHours = (Date.now() - lastVerifiedAt.getTime()) / 3_600_000;

    if (ageHours <= 1) return 100; // 1 小时内
    if (ageHours <= 6) return 95; // 半天内
    if (ageHours <= 24) return 85; // 一天内
    if (ageHours <= 72) return 70; // 三天内
    if (ageHours <= 168) return 50; // 一周内
    if (ageHours <= 720) return 30; // 一个月内
    return 10;
  }

  /** 取某个 Provider 声明的核验有效期 */
  ttlOfProvider(capability: ProviderCapability): number | null {
    return capability.verificationTtlHours;
  }

  /** 标准档位（供 Provider 声明时引用，避免各写各的数字） */
  static readonly TIERS = {
    officialRealtime: {
      baseReliabilityScore: 100,
      verificationTtlHours: VERIFICATION_TTL.OFFICIAL_REALTIME,
    },
    companyOwned: {
      baseReliabilityScore: 95,
      verificationTtlHours: VERIFICATION_TTL.COMPANY_OWNED,
    },
    agentUploaded: {
      baseReliabilityScore: 80,
      verificationTtlHours: VERIFICATION_TTL.AGENT_UPLOADED,
    },
    localCache: {
      baseReliabilityScore: 70,
      verificationTtlHours: VERIFICATION_TTL.COMPANY_OWNED,
    },
    demo: {
      baseReliabilityScore: 0,
      verificationTtlHours: null,
    },
  } as const;

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  /** 0~100 → 1~5 星 */
  private toStars(score: number): number {
    if (score >= 90) return 5;
    if (score >= 75) return 4;
    if (score >= 60) return 3;
    if (score >= 40) return 2;
    if (score > 0) return 1;
    return 0;
  }

  /** 人类可读的时间间隔 */
  private describeAge(hours: number): string {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
    if (hours < 24) return `${Math.round(hours)} 小时`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} 天`;
    return `${Math.round(days / 30)} 个月`;
  }
}
