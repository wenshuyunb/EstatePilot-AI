/**
 * 客户需求画像读写服务。
 *
 * 职责：在「数据库记录」与「领域模型 MergedRequirementProfile」之间转换。
 *
 * 为什么要单独一层：
 *   数据库里的画像以「列」的形式存储（budgetTarget / budgetNormalMax / ...），
 *   而合并与打分逻辑需要的是一个纯数据对象。
 *   如果让合并服务直接读写 Prisma 字段，业务逻辑就会被数据库结构绑死 ——
 *   以后加一个字段要改三处（schema、合并逻辑、打分逻辑）。
 *   这里做一次映射，让两边各自演进。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  BuildingAgePreference,
  DecisionMaker,
  DecorationPreferenceLevel,
  PreferencePriority,
  RequirementFloorPreference,
  type MergedRequirementProfile,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';
import { createEmptyProfile } from './requirement-merge.service.js';

@Injectable()
export class RequirementProfileService {
  private readonly logger = new Logger(RequirementProfileService.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 读取客户需求画像。不存在时返回空画像（而不是 null）。
   *
   * 返回空画像而不是 null 的原因：调用方（合并逻辑）总是需要一个基准对象，
   * 让它到处判空会显著增加出错概率。首次沟通就是"在空画像上合并"。
   */
  async get(
    organizationId: string,
    customerId: string,
  ): Promise<{ profile: MergedRequirementProfile; exists: boolean; profileId: string | null }> {
    const scope = this.tenant.scopeFor(organizationId);

    const record = await scope.findFirst<{
      id: string;
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
      livingRooms: number | null;
      areaMin: number | null;
      areaMax: number | null;
      buildingAgePreference: string | null;
      avoidOldCommunity: boolean;
      communityQualityPriority: string | null;
      subwayPriority: string | null;
      schoolPriority: string | null;
      decorationPriority: string | null;
      floorPreference: string | null;
      orientationPreference: string | null;
      avoidFirstFloor: boolean;
      avoidTopFloor: boolean;
      requireElevator: boolean;
      decorationPreference: string | null;
      requireFineDecoration: boolean;
      schoolRequired: boolean;
      schoolNotNeeded: boolean;
      schoolNote: string | null;
      subwayDistanceMax: number | null;
      commuteLocations: unknown;
      carConvenience: boolean;
      purchasePurpose: string | null;
      paymentMethod: string | null;
      purchaseTimeline: string | null;
      decisionMakers: string[];
      familyConcerns: unknown;
      otherRequirements: string[];
      confidence: unknown;
      sourceMessageCount: number;
    }>('CustomerRequirementProfile', {
      where: { customerId },
      select: {
        id: true,
        city: true,
        districts: true,
        subDistricts: true,
        communities: true,
        budgetTarget: true,
        budgetNormalMax: true,
        budgetStretchMax: true,
        budgetStrictMax: true,
        budgetMin: true,
        bedrooms: true,
        bedroomsStrict: true,
        livingRooms: true,
        areaMin: true,
        areaMax: true,
        buildingAgePreference: true,
        avoidOldCommunity: true,
        communityQualityPriority: true,
        subwayPriority: true,
        schoolPriority: true,
        decorationPriority: true,
        floorPreference: true,
        orientationPreference: true,
        avoidFirstFloor: true,
        avoidTopFloor: true,
        requireElevator: true,
        decorationPreference: true,
        requireFineDecoration: true,
        schoolRequired: true,
        schoolNotNeeded: true,
        schoolNote: true,
        subwayDistanceMax: true,
        commuteLocations: true,
        carConvenience: true,
        purchasePurpose: true,
        paymentMethod: true,
        purchaseTimeline: true,
        decisionMakers: true,
        familyConcerns: true,
        otherRequirements: true,
        confidence: true,
        sourceMessageCount: true,
      },
    });

    if (!record) {
      return { profile: createEmptyProfile(), exists: false, profileId: null };
    }

    return {
      profile: this.toDomain(record),
      exists: true,
      profileId: record.id,
    };
  }

  /**
   * 保存画像（存在则更新，不存在则创建）。
   *
   * 用 find-then-write 而不是 upsert：
   * `customerId` 上有 @@unique，但 Prisma 的 upsert 在复合唯一约束含可空字段时
   * 行为不直观；而且这个表的数据量很小，两次查询的代价可以忽略。
   */
  async save(
    organizationId: string,
    customerId: string,
    profile: MergedRequirementProfile,
    options: { lastMessageId?: string | null } = {},
  ): Promise<{ profileId: string; created: boolean }> {
    const scope = this.tenant.scopeFor(organizationId);

    const existing = await scope.findFirst<{ id: string }>('CustomerRequirementProfile', {
      where: { customerId },
      select: { id: true },
    });

    const data = this.toDatabase(profile, options.lastMessageId ?? null);

    if (existing) {
      await scope.update('CustomerRequirementProfile', {
        where: { id: existing.id },
        data,
      });

      this.logger.log(
        `需求画像已更新：客户 ${customerId}（来源于 ${profile.sourceMessageCount} 条消息，` +
          `置信度 ${profile.confidence}）`,
      );

      return { profileId: existing.id, created: false };
    }

    const created = await scope.create<{ id: string }>('CustomerRequirementProfile', {
      data: { customerId, ...data },
      select: { id: true },
    });

    this.logger.log(
      `需求画像已创建：客户 ${customerId}（首次录入，置信度 ${profile.confidence}）`,
    );

    return { profileId: created.id, created: true };
  }

  // -------------------------------------------------------------------------
  // 映射
  // -------------------------------------------------------------------------

  /** 数据库记录 → 领域模型 */
  private toDomain(record: {
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
    livingRooms: number | null;
    areaMin: number | null;
    areaMax: number | null;
    buildingAgePreference: string | null;
    avoidOldCommunity: boolean;
    communityQualityPriority: string | null;
    subwayPriority: string | null;
    schoolPriority: string | null;
    decorationPriority: string | null;
    floorPreference: string | null;
    orientationPreference: string | null;
    avoidFirstFloor: boolean;
    avoidTopFloor: boolean;
    requireElevator: boolean;
    decorationPreference: string | null;
    requireFineDecoration: boolean;
    schoolRequired: boolean;
    schoolNotNeeded: boolean;
    schoolNote: string | null;
    subwayDistanceMax: number | null;
    commuteLocations: unknown;
    carConvenience: boolean;
    purchasePurpose: string | null;
    paymentMethod: string | null;
    purchaseTimeline: string | null;
    decisionMakers: string[];
    familyConcerns: unknown;
    otherRequirements: string[];
    confidence: unknown;
    sourceMessageCount: number;
  }): MergedRequirementProfile {
    return {
      city: record.city,
      districts: record.districts,
      subDistricts: record.subDistricts,
      communities: record.communities,
      budgetTarget: record.budgetTarget,
      budgetNormalMax: record.budgetNormalMax,
      budgetStretchMax: record.budgetStretchMax,
      budgetStrictMax: record.budgetStrictMax,
      budgetMin: record.budgetMin,
      bedrooms: record.bedrooms,
      bedroomsStrict: record.bedroomsStrict,
      livingRooms: record.livingRooms,
      areaMin: record.areaMin,
      areaMax: record.areaMax,
      buildingAgePreference: this.parseEnum(
        record.buildingAgePreference,
        BuildingAgePreference,
      ),
      avoidOldCommunity: record.avoidOldCommunity,
      communityQualityPriority: this.parseEnum(
        record.communityQualityPriority,
        PreferencePriority,
      ),
      subwayPriority: this.parseEnum(record.subwayPriority, PreferencePriority),
      schoolPriority: this.parseEnum(record.schoolPriority, PreferencePriority),
      decorationPriority: this.parseEnum(record.decorationPriority, PreferencePriority),
      floorPreference: this.parseEnum(record.floorPreference, RequirementFloorPreference),
      orientationPreference: this.parseEnum(record.orientationPreference, PreferencePriority),
      avoidFirstFloor: record.avoidFirstFloor,
      avoidTopFloor: record.avoidTopFloor,
      requireElevator: record.requireElevator,
      decorationPreference: this.parseEnum(
        record.decorationPreference,
        DecorationPreferenceLevel,
      ),
      requireFineDecoration: record.requireFineDecoration,
      schoolRequired: record.schoolRequired,
      schoolNotNeeded: record.schoolNotNeeded,
      schoolNote: record.schoolNote,
      subwayDistanceMax: record.subwayDistanceMax,
      commuteLocations: this.parseStringArray(record.commuteLocations),
      carConvenience: record.carConvenience,
      purchasePurpose: record.purchasePurpose,
      paymentMethod: record.paymentMethod,
      purchaseTimeline: record.purchaseTimeline,
      decisionMakers: record.decisionMakers
        .map((value) => this.parseEnum(value, DecisionMaker))
        .filter((value): value is DecisionMaker => value !== null),
      familyConcerns: this.parseStringArray(record.familyConcerns),
      otherRequirements: record.otherRequirements,
      confidence: this.parseNumber(record.confidence) ?? 0,
      sourceMessageCount: record.sourceMessageCount,
    };
  }

  /** 领域模型 → 数据库字段 */
  private toDatabase(
    profile: MergedRequirementProfile,
    lastMessageId: string | null,
  ): Record<string, unknown> {
    return {
      city: profile.city,
      districts: profile.districts,
      subDistricts: profile.subDistricts,
      communities: profile.communities,
      budgetTarget: profile.budgetTarget,
      budgetNormalMax: profile.budgetNormalMax,
      budgetStretchMax: profile.budgetStretchMax,
      budgetStrictMax: profile.budgetStrictMax,
      budgetMin: profile.budgetMin,
      bedrooms: profile.bedrooms,
      bedroomsStrict: profile.bedroomsStrict,
      livingRooms: profile.livingRooms,
      areaMin: profile.areaMin,
      areaMax: profile.areaMax,
      buildingAgePreference: profile.buildingAgePreference,
      avoidOldCommunity: profile.avoidOldCommunity,
      communityQualityPriority: profile.communityQualityPriority,
      subwayPriority: profile.subwayPriority,
      schoolPriority: profile.schoolPriority,
      decorationPriority: profile.decorationPriority,
      floorPreference: profile.floorPreference,
      orientationPreference: profile.orientationPreference,
      avoidFirstFloor: profile.avoidFirstFloor,
      avoidTopFloor: profile.avoidTopFloor,
      requireElevator: profile.requireElevator,
      decorationPreference: profile.decorationPreference,
      requireFineDecoration: profile.requireFineDecoration,
      schoolRequired: profile.schoolRequired,
      schoolNotNeeded: profile.schoolNotNeeded,
      schoolNote: profile.schoolNote,
      subwayDistanceMax: profile.subwayDistanceMax,
      commuteLocations: profile.commuteLocations,
      carConvenience: profile.carConvenience,
      purchasePurpose: profile.purchasePurpose,
      paymentMethod: profile.paymentMethod,
      purchaseTimeline: profile.purchaseTimeline,
      decisionMakers: profile.decisionMakers,
      familyConcerns: profile.familyConcerns,
      otherRequirements: profile.otherRequirements,
      confidence: profile.confidence,
      sourceMessageCount: profile.sourceMessageCount,
      lastMessageId,
      lastUpdatedAt: new Date(),
    };
  }

  // -------------------------------------------------------------------------
  // 类型安全解析（数据库里的字符串/JSON 需要转成领域类型）
  // -------------------------------------------------------------------------

  private parseEnum<T extends Record<string, string>>(
    value: string | null,
    enumObject: T,
  ): T[keyof T] | null {
    if (!value) return null;
    const values = Object.values(enumObject);
    return values.includes(value) ? (value as T[keyof T]) : null;
  }

  private parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    return [];
  }

  private parseNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // Prisma 的 Decimal 会以对象形式返回，带 toString
    if (value !== null && typeof value === 'object' && 'toString' in value) {
      const parsed = Number(String(value));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
