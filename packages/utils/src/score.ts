/**
 * 评分类通用算法。
 *
 * 这些函数被行为评分引擎、匹配引擎、机会引擎共用，
 * 保持纯函数、可单测、无副作用。
 */

import { clamp01 } from './format.js';

/**
 * 加权平均。权重为 0 的项被忽略。
 * 若总权重为 0 返回 fallback。
 */
export function weightedAverage(
  items: Array<{ value: number; weight: number }>,
  fallback = 0,
): number {
  let weightSum = 0;
  let valueSum = 0;
  for (const item of items) {
    const weight = Math.max(0, item.weight);
    if (weight === 0) continue;
    weightSum += weight;
    valueSum += clamp01(item.value) * weight;
  }
  if (weightSum === 0) return fallback;
  return valueSum / weightSum;
}

/**
 * 区间匹配度 0～1。
 *
 * 语义：value 落在 [min,max] 内得满分；落在容差区按比例衰减；
 * 超出容差区得 0。用于预算、面积等区间型需求。
 *
 * @param value 待评分值
 * @param min 理想区间下界
 * @param max 理想区间上界
 * @param toleranceRatio 容差比例（相对区间宽度的百分比，0～1）
 */
export function rangeAffinity(
  value: number,
  min: number,
  max: number,
  toleranceRatio = 0.15,
): number {
  if (!Number.isFinite(value)) return 0;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (value >= low && value <= high) return 1;

  const width = Math.max(high - low, high * 0.05, 1);
  const tolerance = width * Math.max(0, toleranceRatio);
  if (tolerance === 0) return 0;

  const distance = value < low ? low - value : value - high;
  if (distance >= tolerance) return 0;
  return clamp01(1 - distance / tolerance);
}

/**
 * 单边上限匹配度：越低越好（如地铁距离、房龄、单价）。
 * value <= ideal 得满分，超过 tolerance 得 0。
 */
export function upperBoundAffinity(value: number, ideal: number, tolerance: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= ideal) return 1;
  if (tolerance <= 0) return 0;
  if (value >= ideal + tolerance) return 0;
  return clamp01(1 - (value - ideal) / tolerance);
}

/**
 * 单边下限匹配度：越高越好（如意向分、活跃度）。
 */
export function lowerBoundAffinity(value: number, ideal: number, tolerance: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= ideal) return 1;
  if (tolerance <= 0) return 0;
  if (value <= ideal - tolerance) return 0;
  return clamp01(1 - (ideal - value) / tolerance);
}

/**
 * 集合匹配度：候选集合与目标集合的重合程度（Jaccard 加权版）。
 * 目标集合中的每一项都重要，因此以目标集合为分母。
 */
export function setAffinity(candidates: readonly string[], targets: readonly string[]): number {
  if (targets.length === 0) return 0;
  if (candidates.length === 0) return 0;
  const candidateSet = new Set(candidates.map((item) => item.toLowerCase()));
  let hits = 0;
  for (const target of targets) {
    if (candidateSet.has(target.toLowerCase())) hits += 1;
  }
  return clamp01(hits / targets.length);
}

/**
 * 偏好分布打分：把「客户在该维度上的偏好分布」与「房源取值」对照。
 *
 * @param distribution 偏好分布，key 为取值、value 为归一化偏好（0～1）
 * @param value 房源在该维度的取值
 * @param defaultScore 分布中不存在该取值时的得分
 */
export function distributionAffinity(
  distribution: Record<string, number> | Map<string, number>,
  value: string | number | null | undefined,
  defaultScore = 0.15,
): number {
  if (value === null || value === undefined) return defaultScore;
  const key = String(value);
  const score =
    distribution instanceof Map ? distribution.get(key) : (distribution as Record<string, number>)[key];
  if (score === undefined || score === null || !Number.isFinite(score)) return defaultScore;
  return clamp01(score);
}

/**
 * 排序名次衰减：排名越靠后得分越低。
 * 用于区域偏好排名等序数型信号。
 */
export function rankAffinity(rank: number, totalRanks: number): number {
  if (totalRanks <= 1) return 1;
  const normalized = clamp01(rank / (totalRanks - 1));
  return clamp01(1 - normalized * 0.85);
}

/**
 * 加权求和并归一化到 0～100。
 * 这是匹配总分与机会价值分的最终计算入口。
 */
export function weightedScoreTo100(
  dimensions: Array<{ score: number; weight: number }>,
): number {
  const normalized = weightedAverage(
    dimensions.map((item) => ({ value: item.score, weight: item.weight })),
    0,
  );
  return Number((normalized * 100).toFixed(2));
}

/**
 * 时间新鲜度衰减 0～1：越新越接近 1。
 * 用于机会排序 —— 昨晚的降价比上周的降价更值得马上跟进。
 *
 * @param ageHours 距今小时数
 * @param halfLifeHours 半衰期小时数
 */
export function freshnessScore(ageHours: number, halfLifeHours = 24): number {
  if (!Number.isFinite(ageHours) || ageHours < 0) return 1;
  if (halfLifeHours <= 0) return ageHours === 0 ? 0 : 1;
  return clamp01(0.5 ** (ageHours / halfLifeHours));
}

/**
 * 逻辑斯蒂函数，把任意实数映射到 0～1。
 * 用于把「超期天数」等无界信号压到有界分数。
 */
export function logistic(x: number, midpoint = 0, steepness = 1): number {
  return clamp01(1 / (1 + Math.exp(-steepness * (x - midpoint))));
}

/**
 * 凸组合：把显性需求得分与行为画像得分融合。
 * behaviorWeight 越大越信任行为数据。
 */
export function blendScores(
  explicitScore: number,
  behavioralScore: number,
  behaviorWeight: number,
): number {
  const weight = clamp01(behaviorWeight);
  return clamp01(explicitScore * (1 - weight) + behavioralScore * weight);
}

/**
 * 置信度计算：样本量越多、分布越集中，置信度越高。
 *
 * @param sampleSize 样本量
 * @param minSamples 达到中等置信度所需的样本量
 * @param concentration 分布集中度 0～1（1 表示完全集中）
 */
export function confidenceFrom(sampleSize: number, minSamples = 10, concentration = 1): number {
  if (sampleSize <= 0) return 0;
  const sampleFactor = clamp01(sampleSize / Math.max(1, minSamples * 3));
  const sampleCurve = Math.sqrt(sampleFactor);
  return clamp01(sampleCurve * (0.6 + 0.4 * clamp01(concentration)));
}

/**
 * 计算一组数字的集中度（1 - 变异系数，截断到 0～1）。
 * 用于判断客户偏好是否明确 —— 预算忽高忽低说明需求不清晰。
 */
export function concentration(values: number[]): number {
  if (values.length < 2) return 1;
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  if (mean === 0) return 1;
  const variance =
    values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.abs(mean);
  return clamp01(1 - cv);
}

/**
 * 归一化一组分数到 0～1（按最大值）。全为 0 时全部返回 0。
 */
export function normalizeScores(scores: number[]): number[] {
  const max = Math.max(...scores, 0);
  if (max <= 0) return scores.map(() => 0);
  return scores.map((score) => clamp01(score / max));
}

/**
 * 将一组权重归一化到和为 1。
 */
export function normalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (total <= 0) return weights.map(() => 0);
  return weights.map((weight) => Math.max(0, weight) / total);
}

/**
 * Z-Score 标准化，用于需求漂移检测中判断某维度是否显著变化。
 * 标准差为 0 时返回全 0。
 */
export function zScores(values: number[]): number[] {
  if (values.length < 2) return values.map(() => 0);
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return values.map(() => 0);
  return values.map((value) => (value - mean) / stdDev);
}

/**
 * 计算两个偏好分布的漂移强度 0～1。
 * 使用 L1 距离的一半（即总变差距离），对分布变化敏感且可解释。
 */
export function distributionDrift(
  baseline: Record<string, number>,
  recent: Record<string, number>,
): number {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(recent)]);
  let totalVariation = 0;
  for (const key of keys) {
    const b = clamp01(baseline[key] ?? 0);
    const r = clamp01(recent[key] ?? 0);
    totalVariation += Math.abs(b - r);
  }
  // 总变差距离最大为 2，除以 2 归一化到 0～1
  return clamp01(totalVariation / 2);
}

/**
 * 相对变化率，安全处理除零与负基数。
 */
export function relativeChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : after > 0 ? 1 : -1;
  return (after - before) / Math.abs(before);
}

/**
 * 将分布计数转换为归一化比例（和为 1）。
 */
export function toDistribution(counts: Record<string, number>): Record<string, number> {
  const total = Object.values(counts).reduce((acc, count) => acc + Math.max(0, count), 0);
  if (total <= 0) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    out[key] = Number((Math.max(0, count) / total).toFixed(4));
  }
  return out;
}

/**
 * 对分布做「占比归一化」：把计数型分布的最大值拉到 1，便于作为偏好权重使用。
 */
export function normalizeDistribution(counts: Record<string, number>): Record<string, number> {
  const max = Math.max(...Object.values(counts), 0);
  if (max <= 0) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    out[key] = Number((Math.max(0, count) / max).toFixed(4));
  }
  return out;
}

/**
 * 取分布中排名前 N 的项，按分值降序。
 */
export function topDistribution(
  distribution: Record<string, number>,
  n: number,
): Array<{ key: string; score: number }> {
  return Object.entries(distribution)
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, n));
}
