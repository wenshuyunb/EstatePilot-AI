/**
 * 需求快照服务。
 *
 * 职责：维护客户需求的版本历史，回答"客户的需求是怎么一步步变化的"。
 *
 * 为什么必须保留历史（需求 §9、§10）：
 *   1. 经纪人在跟客户沟通时需要知道"上次他说的是什么"，否则容易说错话。
 *   2. 需求变化本身是重要的销售信号 —— 预算从 500 提到 600 说明客户在认真考虑，
 *      区域从浦东转向浦西可能意味着工作变动。
 *   3. 出问题时可追溯：如果推荐结果不对，能查到是哪一次需求理解出了偏差。
 *
 * 因此这里**只追加、不修改**历史快照。每次变化产生一个新版本。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  BuildingAgePreference,
  DecisionMaker,
  DecorationPreferenceLevel,
  PreferencePriority,
  RequirementChangeType,
  RequirementFloorPreference,
  BUILDING_AGE_LABELS,
  DECISION_MAKER_LABELS,
  PREFERENCE_PRIORITY_LABELS,
  REQUIREMENT_CHANGE_LABELS,
  REQUIREMENT_DECORATION_LABELS,
  REQUIREMENT_FLOOR_LABELS,
  type MergedRequirementProfile,
  type RequirementChange,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';

/** 快照记录 */
export interface RequirementSnapshotRecord {
  id: string;
  version: number;
  changedFields: string[];
  previousValues: unknown;
  newValues: unknown;
  confidence: number;
  changeSummary: RequirementChange[];
  hasOverride: boolean;
  needsConfirmation: boolean;
  sourceMessageId: string | null;
  createdAt: Date;
}

/** 保存快照的输入 */
export interface SaveSnapshotInput {
  customerId: string;
  profile: MergedRequirementProfile;
  changes: RequirementChange[];
  previousProfile: MergedRequirementProfile | null;
  hasOverride: boolean;
  needsConfirmation: boolean;
  sourceMessageId: string | null;
}

@Injectable()
export class RequirementSnapshotService {
  private readonly logger = new Logger(RequirementSnapshotService.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 保存一个新的需求版本。
   *
   * 只有**确实发生变化**时才创建快照 —— 否则客户每次发"好的""在吗"都会产生一个版本，
   * 历史会变得毫无意义。
   */
  async save(
    organizationId: string,
    input: SaveSnapshotInput,
  ): Promise<RequirementSnapshotRecord | null> {
    // 没有变化 → 不产生新版本
    if (input.changes.length === 0) {
      this.logger.log(`客户 ${input.customerId} 需求无变化，跳过快照创建`);
      return null;
    }

    const scope = this.tenant.scopeFor(organizationId);

    // ---- 取当前最大版本号 ----
    const latest = await scope.findFirst<{ version: number }>('CustomerRequirementSnapshot', {
      where: { customerId: input.customerId },
      select: { version: true },
      orderBy: { version: 'desc' },
    });

    const nextVersion = (latest?.version ?? 0) + 1;

    // ---- 计算前后值（只记录发生变化的字段，避免快照膨胀）----
    const changedFields = input.changes.map((change) => change.field);
    const previousValues = input.previousProfile
      ? this.pickFields(input.previousProfile, changedFields)
      : {};
    const newValues = this.pickFields(input.profile, changedFields);

    const created = await scope.create<{
      id: string;
      version: number;
      createdAt: Date;
    }>('CustomerRequirementSnapshot', {
      data: {
        customerId: input.customerId,
        version: nextVersion,
        sourceMessageId: input.sourceMessageId,
        structuredRequirements: input.profile as unknown as object,
        changedFields,
        previousValues: previousValues as unknown as object,
        newValues: newValues as unknown as object,
        confidence: input.profile.confidence,
        changeSummary: input.changes as unknown as object,
        hasOverride: input.hasOverride,
        needsConfirmation: input.needsConfirmation,
      },
      select: { id: true, version: true, createdAt: true },
    });

    this.logger.log(
      `需求快照已保存：客户 ${input.customerId} 版本 v${nextVersion}，` +
        `变更 ${input.changes.length} 项（${changedFields.slice(0, 6).join('、')}）` +
        `${input.hasOverride ? '，含改口' : ''}`,
    );

    return {
      id: created.id,
      version: created.version,
      changedFields,
      previousValues,
      newValues,
      confidence: input.profile.confidence,
      changeSummary: input.changes,
      hasOverride: input.hasOverride,
      needsConfirmation: input.needsConfirmation,
      sourceMessageId: input.sourceMessageId,
      createdAt: created.createdAt,
    };
  }

  /** 取客户的版本历史（倒序，最新在前） */
  async list(
    organizationId: string,
    customerId: string,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      version: number;
      changedFields: string[];
      changeSummary: unknown;
      hasOverride: boolean;
      needsConfirmation: boolean;
      sourceMessageId: string | null;
      createdAt: Date;
    }>
  > {
    const scope = this.tenant.scopeFor(organizationId);

    return scope.findMany<{
      id: string;
      version: number;
      changedFields: string[];
      changeSummary: unknown;
      hasOverride: boolean;
      needsConfirmation: boolean;
      sourceMessageId: string | null;
      createdAt: Date;
    }>('CustomerRequirementSnapshot', {
      where: { customerId },
      select: {
        id: true,
        version: true,
        changedFields: true,
        changeSummary: true,
        hasOverride: true,
        needsConfirmation: true,
        sourceMessageId: true,
        createdAt: true,
      },
      orderBy: { version: 'desc' },
      take: limit,
    });
  }

  /** 取指定版本 */
  async findByVersion(
    organizationId: string,
    customerId: string,
    version: number,
  ): Promise<{ id: string; structuredRequirements: unknown; createdAt: Date } | null> {
    const scope = this.tenant.scopeFor(organizationId);

    return scope.findFirst<{ id: string; structuredRequirements: unknown; createdAt: Date }>(
      'CustomerRequirementSnapshot',
      {
        where: { customerId, version },
        select: { id: true, structuredRequirements: true, createdAt: true },
      },
    );
  }

  /**
   * 生成人类可读的需求变化描述。
   *
   * 这是界面上「AI 识别到以下变化」区块的数据源。
   * 格式：{ label: "预算", before: "理想 500万", after: "理想 500万，最高 600万", type: "调整" }
   */
  static describeChanges(changes: RequirementChange[]): Array<{
    field: string;
    label: string;
    before: string;
    after: string;
    type: string;
    isOverride: boolean;
  }> {
    return changes.map((change) => ({
      field: change.field,
      label: change.label,
      before: change.previousDisplay,
      after: change.newDisplay,
      type: REQUIREMENT_CHANGE_LABELS[change.changeType],
      isOverride: change.isOverride,
    }));
  }

  /** 从画像里挑出指定字段的值（用于记录变化前后） */
  private pickFields(
    profile: MergedRequirementProfile,
    fields: string[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const field of fields) {
      // budget 是一个逻辑字段，展开成三个具体字段便于对比
      if (field === 'budget') {
        result['budgetTarget'] = profile.budgetTarget;
        result['budgetNormalMax'] = profile.budgetNormalMax;
        result['budgetStretchMax'] = profile.budgetStretchMax;
        result['budgetStrictMax'] = profile.budgetStrictMax;
        continue;
      }

      const value = (profile as unknown as Record<string, unknown>)[field];
      if (value !== undefined) result[field] = value;
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// 画像的展示格式化（界面与文案都用它，保证口径一致）
// ---------------------------------------------------------------------------

/** 把画像格式化成一段给经纪人/客户看的中文摘要 */
export function describeProfile(profile: MergedRequirementProfile): string {
  const parts: string[] = [];

  if (profile.city) parts.push(profile.city);
  if (profile.subDistricts.length > 0) parts.push(profile.subDistricts.join('、'));
  else if (profile.districts.length > 0) parts.push(profile.districts.join('、'));
  if (profile.communities.length > 0) parts.push(profile.communities.join('、'));

  if (profile.bedrooms.length > 0) {
    parts.push(`${profile.bedrooms.join('/')}房${profile.bedroomsStrict ? '（硬性）' : ''}`);
  }

  // 预算：三级分别表述，让经纪人一眼看出客户的真实心理价位
  const budgetParts: string[] = [];
  if (profile.budgetTarget !== null) budgetParts.push(`理想${formatWan(profile.budgetTarget)}`);
  if (profile.budgetNormalMax !== null) budgetParts.push(`最高${formatWan(profile.budgetNormalMax)}`);
  if (profile.budgetStretchMax !== null) budgetParts.push(`极限${formatWan(profile.budgetStretchMax)}`);
  if (budgetParts.length > 0) parts.push(budgetParts.join('，'));

  if (profile.areaMin !== null || profile.areaMax !== null) {
    const areaText =
      profile.areaMin !== null && profile.areaMax !== null
        ? `${profile.areaMin}～${profile.areaMax}㎡`
        : profile.areaMin !== null
          ? `${profile.areaMin}㎡以上`
          : `${profile.areaMax}㎡以内`;
    parts.push(areaText);
  }

  if (profile.buildingAgePreference && profile.buildingAgePreference !== BuildingAgePreference.ANY) {
    parts.push(BUILDING_AGE_LABELS[profile.buildingAgePreference]);
  }
  if (profile.avoidOldCommunity) parts.push('排除老小区');

  if (profile.subwayDistanceMax !== null) parts.push(`地铁${profile.subwayDistanceMax}米内`);
  if (profile.subwayPriority === PreferencePriority.HIGH) parts.push('重视地铁');
  if (profile.schoolRequired) parts.push('需要学区');
  if (profile.schoolNotNeeded) parts.push('学区无所谓');
  if (profile.communityQualityPriority === PreferencePriority.HIGH) parts.push('重视小区环境');

  if (profile.decorationPreference && profile.decorationPreference !== DecorationPreferenceLevel.ANY) {
    parts.push(REQUIREMENT_DECORATION_LABELS[profile.decorationPreference]);
  }
  if (profile.requireFineDecoration) parts.push('必须精装');

  if (profile.floorPreference && profile.floorPreference !== RequirementFloorPreference.ANY) {
    parts.push(REQUIREMENT_FLOOR_LABELS[profile.floorPreference]);
  }
  if (profile.avoidFirstFloor) parts.push('不要一楼');
  if (profile.avoidTopFloor) parts.push('不要顶楼');
  if (profile.requireElevator) parts.push('需电梯');

  if (profile.familyConcerns.length > 0) {
    parts.push(`家人关注：${profile.familyConcerns.join('；')}`);
  }
  if (profile.decisionMakers.filter((maker) => maker !== DecisionMaker.SELF).length > 0) {
    const others = profile.decisionMakers
      .filter((maker) => maker !== DecisionMaker.SELF)
      .map((maker) => DECISION_MAKER_LABELS[maker]);
    parts.push(`${others.join('、')}参与决策`);
  }

  return parts.length > 0 ? parts.join('，') : '客户需求尚未明确';
}

/** 格式化优先级（用于需求变化展示） */
export function describePriority(value: PreferencePriority | null): string {
  return value ? PREFERENCE_PRIORITY_LABELS[value] : '未提及';
}

/** 万元格式化 */
export function formatWan(amount: number): string {
  const wan = amount / 10_000;
  // 不足 1 万或非整数时保留一位小数
  return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
}
