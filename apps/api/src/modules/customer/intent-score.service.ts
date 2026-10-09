/**
 * 客户成交概率评分引擎（Customer Intent Score）。
 *
 * ⚠️ 免责声明：这是**AI 辅助判断**，不是成交承诺。
 * 所有对外展示该分数的地方都必须带免责说明（AI_DISCLAIMER）。
 *
 * 评分维度与权重（依据需求文档 §26）：
 *   行为活跃度      20%   —— 近期浏览频率与深度
 *   重复访问与收藏  15%   —— 高意向的强信号
 *   带看情况        15%   —— 带看次数与反馈
 *   需求明确度      15%   —— 需求越具体，成交越快
 *   预算与贷款准备  15%   —— 批贷通过是成交前兆
 *   沟通频率        10%   —— 主动联系是强信号
 *   房源匹配度      10%   —— 是否有明确满意的房源
 *
 * 设计原则：
 *   1. **纯函数计算**，输入是已聚合的数据，便于单测与复用（种子脚本也用它）。
 *   2. **数据不足时降权**，而不是给 0 分 —— 新客户不该被判定为"冷"。
 *   3. 每个因子的 explanation 必须引用具体数字，让经纪人知道依据。
 */

import {
  AI_DISCLAIMER,
  CustomerStatus,
  IntentLevel,
  LoanStatus,
  PurchaseTimeline,
  type CustomerIntentScore,
  type IntentScoreFactor,
} from '@estatepilot/types';
import { clamp01, confidenceFrom, logistic, safeRatio, weightedScoreTo100 } from '@estatepilot/utils';

/** 评分输入：全部为已聚合的原始信号 */
export interface IntentScoreInput {
  status: CustomerStatus;
  /** 意向等级（销售人工打的） */
  intentLevel: IntentLevel | null;
  /** 累计行为事件数 */
  behaviorEventCount: number;
  /** 近 14 天行为事件数 —— 时效性比总量更重要 */
  recentBehaviorCount: number;
  /** 浏览过的不同房源数 */
  viewedPropertyCount: number;
  /** 重复访问过的房源数 */
  revisitCount: number;
  /** 收藏数 */
  favoriteCount: number;
  /** 对比数 */
  compareCount: number;
  /** 带看次数 */
  viewingCount: number;
  /** 已完成带看次数 */
  completedViewingCount: number;
  /** 沟通次数 */
  communicationCount: number;
  /** 客户主动发起的沟通数 —— 比被动回复更能说明意向 */
  inboundCommunicationCount: number;
  /** 距最后一次联系的天数，null 表示从未联系 */
  daysSinceLastContact: number | null;
  /** 显性需求字段的填写完整度 0～1 */
  requirementClarity: number;
  /** 是否填写了明确预算 */
  hasBudget: boolean;
  /** 是否填写了购房时间计划 */
  hasTimeline: boolean;
  /** 购房时间计划 */
  purchaseTimeline: PurchaseTimeline | null;
  /** 贷款状态 */
  loanStatus: LoanStatus;
  /** 是否已付定金/进入谈判 */
  isNegotiating: boolean;
  /** 最高匹配分（0～100），无匹配则为 null */
  topMatchScore: number | null;
  /** 匹配分 ≥ 80 的数量 */
  highMatchCount: number;
  /** 是否查看过价格历史 —— 对价格敏感的客户更接近决策 */
  priceHistoryViewCount: number;
  /** 是否联系过经纪人 / 预约过带看 */
  hasContactedAgent: boolean;
  hasBookedViewing: boolean;
}

/** 单个维度的权重配置。可被后台覆盖 */
export const INTENT_SCORE_WEIGHTS = {
  behaviorActivity: 0.2,
  engagement: 0.15,
  viewing: 0.15,
  requirementClarity: 0.15,
  budgetReadiness: 0.15,
  communication: 0.1,
  matching: 0.1,
} as const;

/**
 * 计算客户成交概率。
 *
 * @returns 0～100 的分数与完整的分因子解释
 */
export function calculateIntentScore(input: IntentScoreInput): CustomerIntentScore {
  const factors: IntentScoreFactor[] = [];

  // -------------------------------------------------------------------------
  // 1. 行为活跃度（20%）
  //    用近期行为数而非总量：一个两年前看过 100 次、最近毫无动静的客户，
  //    成交概率远低于最近 3 天看了 10 次的客户。
  // -------------------------------------------------------------------------
  {
    // 近 14 天 30 次行为视为满分（约每天 2 次）
    const activityScore = clamp01(input.recentBehaviorCount / 30) * 100;
    // 深度加成：看过的房源数越多说明越认真（但边际递减）
    const depthBonus = clamp01(input.viewedPropertyCount / 15) * 15;
    const rawScore = Math.min(100, activityScore + depthBonus);

    factors.push({
      key: 'behaviorActivity',
      label: '行为活跃度',
      rawScore: Number(rawScore.toFixed(1)),
      weight: INTENT_SCORE_WEIGHTS.behaviorActivity,
      contribution: 0,
      explanation:
        input.recentBehaviorCount > 0
          ? `最近 14 天产生 ${input.recentBehaviorCount} 条浏览行为，累计查看 ${input.viewedPropertyCount} 套房源。`
          : `最近 14 天没有浏览行为（历史累计 ${input.behaviorEventCount} 条）。`,
    });
  }

  // -------------------------------------------------------------------------
  // 2. 重复访问与收藏（15%）
  //    这是最可靠的强意向信号：客户反复看同一套房，通常在做决策比较。
  // -------------------------------------------------------------------------
  {
    const revisitScore = clamp01(input.revisitCount / 3) * 60;
    const favoriteScore = clamp01(input.favoriteCount / 3) * 30;
    const compareScore = clamp01(input.compareCount / 2) * 10;
    const rawScore = Math.min(100, revisitScore + favoriteScore + compareScore);

    factors.push({
      key: 'engagement',
      label: '重复访问与收藏',
      rawScore: Number(rawScore.toFixed(1)),
      weight: INTENT_SCORE_WEIGHTS.engagement,
      contribution: 0,
      explanation:
        input.revisitCount + input.favoriteCount + input.compareCount > 0
          ? `重复访问 ${input.revisitCount} 套房源、收藏 ${input.favoriteCount} 套、加入对比 ${input.compareCount} 套。`
          : '尚无重复访问、收藏或对比行为。',
    });
  }

  // -------------------------------------------------------------------------
  // 3. 带看情况（15%）
  //    带看是最接近成交的行为。已完成带看权重最高。
  // -------------------------------------------------------------------------
  {
    const completedScore = clamp01(input.completedViewingCount / 3) * 70;
    const plannedScore = clamp01(input.viewingCount / 5) * 30;
    const rawScore = Math.min(100, completedScore + plannedScore);

    factors.push({
      key: 'viewing',
      label: '带看情况',
      rawScore: Number(rawScore.toFixed(1)),
      weight: INTENT_SCORE_WEIGHTS.viewing,
      contribution: 0,
      explanation:
        input.viewingCount > 0
          ? `已安排 ${input.viewingCount} 次带看，其中 ${input.completedViewingCount} 次已完成。`
          : '尚未产生带看，建议尽快邀约实地看房。',
    });
  }

  // -------------------------------------------------------------------------
  // 4. 需求明确度（15%）
  //    需求越具体，越容易匹配到合适房源，成交周期越短。
  // -------------------------------------------------------------------------
  {
    const clarityScore = clamp01(input.requirementClarity) * 70;
    const budgetClarity = input.hasBudget ? 20 : 0;
    const timelineClarity = input.hasTimeline ? 10 : 0;
    const rawScore = Math.min(100, clarityScore + budgetClarity + timelineClarity);

    factors.push({
      key: 'requirementClarity',
      label: '需求明确度',
      rawScore: Number(rawScore.toFixed(1)),
      weight: INTENT_SCORE_WEIGHTS.requirementClarity,
      contribution: 0,
      explanation:
        `需求字段填写完整度 ${(input.requirementClarity * 100).toFixed(0)}%` +
        `${input.hasBudget ? '，已明确预算' : '，预算未明确'}` +
        `${input.hasTimeline ? '，已明确购房时间' : '，购房时间未明确'}。`,
    });
  }

  // -------------------------------------------------------------------------
  // 5. 预算与贷款准备（15%）
  //    贷款批下来是成交的强前兆；资金未落实的客户容易在最后关头卡住。
  // -------------------------------------------------------------------------
  {
    let loanScore = 0;
    let loanNote = '';

    switch (input.loanStatus) {
      case LoanStatus.APPROVED:
        loanScore = 55;
        loanNote = '贷款已批，资金已落实';
        break;
      case LoanStatus.NOT_NEEDED:
        loanScore = 55;
        loanNote = '全款购房，无贷款环节';
        break;
      case LoanStatus.SUBMITTED:
        loanScore = 40;
        loanNote = '贷款已提交，审批中';
        break;
      case LoanStatus.PREPARING:
        loanScore = 25;
        loanNote = '正在准备贷款材料';
        break;
      case LoanStatus.REJECTED:
        loanScore = 5;
        loanNote = '贷款曾被拒绝，需要重新评估购房能力';
        break;
      default:
        loanScore = 10;
        loanNote = '贷款尚未启动';
    }

    // 谈判中或已成交：预算落实程度直接加分
    if (input.isNegotiating) loanScore = Math.min(100, loanScore + 30);

    const timelineScore =
      input.purchaseTimeline === PurchaseTimeline.URGENT
        ? 20
        : input.purchaseTimeline === PurchaseTimeline.ONE_MONTH
          ? 15
          : input.purchaseTimeline === PurchaseTimeline.THREE_MONTHS
            ? 10
            : input.purchaseTimeline === PurchaseTimeline.UNDECIDED
              ? 0
              : 5;

    const rawScore = Math.min(100, loanScore + timelineScore);

    factors.push({
      key: 'budgetReadiness',
      label: '预算与贷款准备',
      rawScore: Number(rawScore.toFixed(1)),
      weight: INTENT_SCORE_WEIGHTS.budgetReadiness,
      contribution: 0,
      explanation: `${loanNote}${input.purchaseTimeline ? `；购房计划为「${timelineLabel(input.purchaseTimeline)}」` : ''}。`,
    });
  }

  // -------------------------------------------------------------------------
  // 6. 沟通频率（10%）
  //    客户主动联系是强信号；长期失联则说明可能在别处看房。
  // -------------------------------------------------------------------------
  {
    const frequencyScore = clamp01(input.communicationCount / 8) * 50;
    // 主动沟通权重翻倍
    const inboundScore = clamp01(input.inboundCommunicationCount / 3) * 30;
    // 近期有联系加分
    const recencyScore =
      input.daysSinceLastContact === null
        ? 0
        : input.daysSinceLastContact <= 3
          ? 20
          : input.daysSinceLastContact <= 7
            ? 12
            : input.daysSinceLastContact <= 21
              ? 5
              : 0;

    const rawScore = Math.min(100, frequencyScore + inboundScore + recencyScore);

    factors.push({
      key: 'communication',
      label: '沟通频率',
      rawScore: Number(rawScore.toFixed(1)),
      weight: INTENT_SCORE_WEIGHTS.communication,
      contribution: 0,
      explanation:
        input.communicationCount > 0
          ? `累计沟通 ${input.communicationCount} 次（客户主动 ${input.inboundCommunicationCount} 次），` +
            `${input.daysSinceLastContact === null ? '从未联系' : `距上次联系 ${input.daysSinceLastContact} 天`}。`
          : '尚无沟通记录。',
    });
  }

  // -------------------------------------------------------------------------
  // 7. 房源匹配度（10%）
  //    有明确满意的房源，才谈得上成交。
  // -------------------------------------------------------------------------
  {
    const topScore = input.topMatchScore !== null ? clamp01(input.topMatchScore / 100) * 70 : 0;
    const countScore = clamp01(input.highMatchCount / 3) * 30;
    const rawScore = Math.min(100, topScore + countScore);

    factors.push({
      key: 'matching',
      label: '房源匹配度',
      rawScore: Number(rawScore.toFixed(1)),
      weight: INTENT_SCORE_WEIGHTS.matching,
      contribution: 0,
      explanation:
        input.topMatchScore !== null
          ? `最高匹配分 ${input.topMatchScore}，其中 ${input.highMatchCount} 套匹配度达 80 分以上。`
          : '系统尚未生成有效匹配结果。',
    });
  }

  // -------------------------------------------------------------------------
  // 特殊信号加成：客户主动联系经纪人 / 预约带看是最强的转化信号
  // -------------------------------------------------------------------------
  if (input.hasBookedViewing || input.hasContactedAgent) {
    const label = input.hasBookedViewing ? '预约带看' : '主动联系经纪人';
    factors.push({
      key: 'strongSignal',
      label: '强转化信号',
      rawScore: input.hasBookedViewing ? 100 : 85,
      weight: 0.05,
      contribution: 0,
      explanation: `客户已${label}，这是意图最强的行为信号。`,
    });
  }

  // 价格历史查看：对价格敏感的客户往往在权衡，接近决策
  if (input.priceHistoryViewCount > 0) {
    factors.push({
      key: 'priceSensitivity',
      label: '价格关注度',
      rawScore: Math.min(100, input.priceHistoryViewCount * 25),
      weight: 0.03,
      contribution: 0,
      explanation: `查看价格历史 ${input.priceHistoryViewCount} 次，说明客户在评估价格合理性。`,
    });
  }

  // -------------------------------------------------------------------------
  // 加权汇总
  // -------------------------------------------------------------------------
  const totalWeight = factors.reduce((acc, factor) => acc + factor.weight, 0);

  // 归一化权重（因为可能追加了额外因子），并计算每项的贡献
  for (const factor of factors) {
    const normalizedWeight = totalWeight > 0 ? factor.weight / totalWeight : 0;
    factor.weight = Number(normalizedWeight.toFixed(4));
    factor.contribution = Number((factor.rawScore * normalizedWeight).toFixed(2));
  }

  let score = weightedScoreTo100(factors.map((f) => ({ score: f.rawScore / 100, weight: f.weight })));

  // -------------------------------------------------------------------------
  // 状态修正：已进入谈判/成交的客户，成交概率不应被"行为活跃度低"拉低
  // （到了谈判阶段，客户反而不怎么浏览网站了 —— 这是正常现象）
  // -------------------------------------------------------------------------
  if (input.status === CustomerStatus.NEGOTIATING) {
    score = Math.max(score, 78);
  } else if (input.status === CustomerStatus.DEAL) {
    score = 100;
  } else if (input.status === CustomerStatus.LOST) {
    score = Math.min(score, 12);
  } else if (input.status === CustomerStatus.DORMANT) {
    score = Math.min(score, 35);
  }

  // 销售人工标注的 A 类客户，给一个下限（人的判断也重要）
  if (input.intentLevel === IntentLevel.A) {
    score = Math.max(score, 72);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // -------------------------------------------------------------------------
  // 置信度：样本量越大越可信
  // -------------------------------------------------------------------------
  const sampleSize =
    input.behaviorEventCount + input.communicationCount * 3 + input.viewingCount * 5;
  const confidence = confidenceFrom(sampleSize, 15, 1);

  const level: CustomerIntentScore['level'] =
    score >= 75 ? 'HOT' : score >= 50 ? 'WARM' : score >= 25 ? 'COOL' : 'COLD';

  const levelLabels: Record<CustomerIntentScore['level'], string> = {
    HOT: '热（建议优先跟进）',
    WARM: '温（保持节奏）',
    COOL: '凉（需要激活）',
    COLD: '冷（低优先级）',
  };

  // 找出贡献最高与最低的因子，用于生成一句话结论
  const sorted = [...factors].sort((a, b) => b.contribution - a.contribution);
  const topFactor = sorted[0];
  const bottomFactor = sorted[sorted.length - 1];

  const summary = buildSummary(score, level, topFactor, bottomFactor, confidence, input);

  return {
    customerId: '', // 由调用方填充
    score,
    level,
    levelLabel: levelLabels[level],
    factors,
    summary,
    aiGenerated: false,
    disclaimer: AI_DISCLAIMER,
    calculatedAt: new Date().toISOString(),
  };
}

/** 生成一句话结论 */
function buildSummary(
  score: number,
  level: CustomerIntentScore['level'],
  topFactor: IntentScoreFactor | undefined,
  bottomFactor: IntentScoreFactor | undefined,
  confidence: number,
  input: IntentScoreInput,
): string {
  if (confidence < 0.3) {
    return (
      `当前信号量不足（累计 ${input.behaviorEventCount} 条行为事件），评分置信度较低，` +
      `建议先通过专属链接推送房源以积累行为数据。`
    );
  }

  const parts: string[] = [];

  if (level === 'HOT') {
    parts.push('该客户意向强烈');
  } else if (level === 'WARM') {
    parts.push('该客户意向中等偏上');
  } else if (level === 'COOL') {
    parts.push('该客户意向偏弱，需要重新激活');
  } else {
    parts.push('该客户当前意向较低');
  }

  if (topFactor) {
    parts.push(`主要支撑来自「${topFactor.label}」（${topFactor.rawScore.toFixed(0)} 分）`);
  }
  if (bottomFactor && bottomFactor.rawScore < 40 && bottomFactor.key !== topFactor?.key) {
    parts.push(`明显短板是「${bottomFactor.label}」，可优先从这里入手改善`);
  }

  return `${parts.join('，')}。综合评分 ${score} 分。`;
}

function timelineLabel(timeline: PurchaseTimeline): string {
  const labels: Record<PurchaseTimeline, string> = {
    [PurchaseTimeline.URGENT]: '一周内',
    [PurchaseTimeline.ONE_MONTH]: '1 个月内',
    [PurchaseTimeline.THREE_MONTHS]: '3 个月内',
    [PurchaseTimeline.HALF_YEAR]: '半年内',
    [PurchaseTimeline.ONE_YEAR]: '一年内',
    [PurchaseTimeline.UNDECIDED]: '未确定',
  };
  return labels[timeline] ?? '未确定';
}

/**
 * 计算需求明确度（0～1）。
 * 依据显性需求字段的填写完整度。由调用方传入字段列表。
 */
export function calculateRequirementClarity(fields: {
  budgetMin?: unknown;
  budgetMax?: unknown;
  preferredDistricts?: unknown;
  bedrooms?: unknown;
  areaMin?: unknown;
  areaMax?: unknown;
  purchasePurpose?: unknown;
  paymentMethod?: unknown;
  purchaseTimeline?: unknown;
  subwayDistanceMax?: unknown;
  decorationPreference?: unknown;
  schoolPreference?: unknown;
}): number {
  const checks = [
    fields.budgetMin !== null && fields.budgetMin !== undefined,
    fields.budgetMax !== null && fields.budgetMax !== undefined,
    Array.isArray(fields.preferredDistricts) && fields.preferredDistricts.length > 0,
    Array.isArray(fields.bedrooms) && fields.bedrooms.length > 0,
    fields.areaMin !== null && fields.areaMin !== undefined,
    fields.areaMax !== null && fields.areaMax !== undefined,
    fields.purchasePurpose !== null && fields.purchasePurpose !== undefined,
    fields.paymentMethod !== null && fields.paymentMethod !== undefined,
    fields.purchaseTimeline !== null && fields.purchaseTimeline !== undefined,
    fields.subwayDistanceMax !== null && fields.subwayDistanceMax !== undefined,
    fields.decorationPreference !== null && fields.decorationPreference !== undefined,
    fields.schoolPreference !== null &&
      fields.schoolPreference !== undefined &&
      fields.schoolPreference !== '',
  ];

  const filled = checks.filter(Boolean).length;
  return Number(safeRatio(filled, checks.length).toFixed(3));
}

/**
 * 把原始计数转成"活跃度衰减"系数。
 * 用于机会价值分：昨晚的行为比上周的行为重要得多。
 */
export function recencyDecay(lastActiveHoursAgo: number | null): number {
  if (lastActiveHoursAgo === null) return 0.2;
  // 24 小时内接近 1，之后对数衰减
  return clamp01(logistic(-lastActiveHoursAgo / 48, -0.5, 2));
}
