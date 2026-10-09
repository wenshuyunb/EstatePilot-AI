/**
 * 需求增量合并服务。
 *
 * 这是整个闭环里**最容易做错、也最不能出错**的一块。
 *
 * 核心原则（需求 §8、§11）：
 *   客户每次说的话只是「**新证据**」，不是「完整画像」。
 *   新消息绝不能覆盖旧画像，除非客户**明确改口**。
 *
 * 三级预算的累加规则（这是本服务的灵魂）：
 *
 *   第 1 次：客户说"预算500万"
 *     → budgetTarget = 500
 *
 *   第 2 次：客户说"550也可以"
 *     → budgetTarget 仍然是 500（他的理想价位没变）
 *     → budgetNormalMax = 550（他愿意往上够一够）
 *     ❌ 错误做法：把 target 改成 550 —— 这丢掉了"500 是他最舒服的价位"这个关键信息，
 *        后续推荐会把 550 万的房子当成"正好符合预算"，而客户其实觉得贵。
 *
 *   第 3 次：客户说"特别好的600也能考虑"
 *     → budgetStretchMax = 600
 *     → 前两级完全不动
 *
 *   第 4 次：客户说"最多520，超过不看"
 *     → budgetStrictMax = true，且 budgetNormalMax 收缩到 520
 *     → 这是**明确改口**（覆盖语义），必须收缩，否则会推荐客户明确拒绝的房子
 *
 * 为什么数值运算不用 AI：
 *   预算是硬性过滤的依据。如果让模型算，同样的输入可能得到不同结果，
 *   会出现"这套房昨天在推荐里、今天不在"这种不可解释的行为。
 *   AI 只负责判断语义关系（哪些是覆盖、哪些是累加），数值由代码确定性计算。
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
  REQUIREMENT_DECORATION_LABELS,
  REQUIREMENT_FLOOR_LABELS,
  type MergedRequirementProfile,
  type RequirementChange,
  type RequirementExtraction,
  type RequirementMergeResult,
} from '@estatepilot/types';
import { sanitizeRegionsForCity } from './city-locations.js';

/** 合并选项 */
export interface MergeOptions {
  /**
   * 覆盖语义的字段（来自 AI 的 overrideFields，或规则解析的结果）。
   * 这些字段用新值直接替换旧值，而不是累加。
   */
  overrideFields?: string[];
  /**
   * 允许合并的范围限制。
   * 例如只允许更新 budget 相关字段时传入 ['budget']，其余字段一律保留旧值。
   */
  onlyFields?: string[];
  /** 本次来源消息 ID（用于快照溯源） */
  sourceMessageId?: string;
}

/** 空画像 */
export function createEmptyProfile(): MergedRequirementProfile {
  return {
    city: null,
    districts: [],
    subDistricts: [],
    communities: [],
    budgetTarget: null,
    budgetNormalMax: null,
    budgetStretchMax: null,
    budgetStrictMax: false,
    budgetMin: null,
    bedrooms: [],
    bedroomsStrict: false,
    livingRooms: null,
    areaMin: null,
    areaMax: null,
    buildingAgePreference: null,
    avoidOldCommunity: false,
    communityQualityPriority: null,
    subwayPriority: null,
    schoolPriority: null,
    decorationPriority: null,
    floorPreference: null,
    orientationPreference: null,
    avoidFirstFloor: false,
    avoidTopFloor: false,
    requireElevator: false,
    decorationPreference: null,
    requireFineDecoration: false,
    schoolRequired: false,
    schoolNotNeeded: false,
    schoolNote: null,
    subwayDistanceMax: null,
    commuteLocations: [],
    carConvenience: false,
    purchasePurpose: null,
    paymentMethod: null,
    purchaseTimeline: null,
    decisionMakers: [],
    familyConcerns: [],
    otherRequirements: [],
    confidence: 0,
    sourceMessageCount: 0,
  };
}

@Injectable()
export class RequirementMergeService {
  private readonly logger = new Logger(RequirementMergeService.name);

  /**
   * 把新抽取的需求合并进已有画像。
   *
   * @param existing 已有画像（首次录入时传 createEmptyProfile()）
   * @param extracted 本次从新消息抽取的需求
   * @param options 合并选项
   */
  merge(
    existing: MergedRequirementProfile,
    extracted: RequirementExtraction,
    options: MergeOptions = {},
  ): RequirementMergeResult {
    // 深拷贝，避免污染调用方传入的对象
    const merged: MergedRequirementProfile = {
      ...existing,
      districts: [...existing.districts],
      subDistricts: [...existing.subDistricts],
      communities: [...existing.communities],
      bedrooms: [...existing.bedrooms],
      commuteLocations: [...existing.commuteLocations],
      decisionMakers: [...existing.decisionMakers],
      familyConcerns: [...existing.familyConcerns],
      otherRequirements: [...existing.otherRequirements],
    };

    const changes: RequirementChange[] = [];
    const overrideSet = new Set(options.overrideFields ?? extracted.overrideFields ?? []);
    const onlySet = options.onlyFields ? new Set(options.onlyFields) : null;

    /** 判断某字段是否允许被本次合并修改 */
    const canTouch = (field: string): boolean => {
      if (!onlySet) return true;
      return onlySet.has(field) || onlySet.has(field.replace(/[A-Z].*$/, ''));
    };

    /** 记录一次变化 */
    const recordChange = (
      field: string,
      label: string,
      changeType: RequirementChangeType,
      previousDisplay: string,
      newDisplay: string,
    ): void => {
      changes.push({
        field,
        label,
        changeType,
        previousDisplay,
        newDisplay,
        isOverride: changeType === RequirementChangeType.OVERRIDDEN,
      });
    };

    /** 判断本次是否为显式改口 */
    const isOverride = (field: string): boolean => overrideSet.has(field);

    // =====================================================================
    // 1. 三级预算 —— 本服务最关键的部分
    // =====================================================================
    this.mergeBudget(merged, extracted, {
      recordChange,
      isOverride,
      canTouch,
      logger: this.logger,
    });

    // =====================================================================
    // 2. 城市与区域
    // =====================================================================
    if (canTouch('city') && extracted.city && extracted.city !== merged.city) {
      if (merged.city === null) {
        recordChange('city', '城市', RequirementChangeType.ADDED, '未明确', extracted.city);
      } else if (isOverride('city')) {
        recordChange(
          'city',
          '城市',
          RequirementChangeType.OVERRIDDEN,
          merged.city,
          extracted.city,
        );
      } else {
        // 客户没改口就说了另一个城市 → 这是冲突，保留旧值并提示确认
        recordChange(
          'city',
          '城市',
          RequirementChangeType.UPDATED,
          merged.city,
          `${extracted.city}（与原有城市不一致，请确认）`,
        );
      }
      merged.city = extracted.city;
    }

    /**
     * ⚠️ 城市切换后必须清理旧城市的区域（踩过的坑）。
     *
     * 问题场景（实测）：
     *   客户先聊上海（画像记住 浦东新区 / 张江），后改口厦门。
     *   `districts` 是**追加**语义，于是画像里同时存在
     *   `["浦东新区","思明区","湖里区"]`、`subDistricts=["张江"]`。
     *
     * 后果（比看起来严重得多）：
     *   1. 生成的检索式变成「厦门 张江 2或3房」—— 厦门没有张江，
     *      经纪人在贝壳 App 里搜不到任何结果
     *   2. 硬筛用厦门的城市 + 上海的区，必然 0 条
     *   3. 这个脏数据会**永久留在画像里**，持续污染后续所有检索
     *
     * 之前只在"搜索时"临时清洗，治标不治本 —— 画像本身一直是脏的。
     * 这里从**源头**修：城市变化后立刻丢弃不属于新城市的区域。
     */
    if (merged.city) {
      const sanitized = sanitizeRegionsForCity(
        { districts: merged.districts, subDistricts: merged.subDistricts },
        merged.city,
      );

      // 只有确实丢弃了内容才记变更，避免噪音
      const droppedDistricts = merged.districts.filter((d) => !sanitized.districts.includes(d));
      const droppedSubs = merged.subDistricts.filter((s) => !sanitized.subDistricts.includes(s));

      if (droppedDistricts.length > 0 || droppedSubs.length > 0) {
        const dropped = [...droppedDistricts, ...droppedSubs];

        this.logger.log(
          `城市为「${merged.city}」，已清理不属于该城市的区域：${dropped.join('、')}`,
        );

        recordChange(
          'districts',
          '区域',
          RequirementChangeType.OVERRIDDEN,
          dropped.join('、'),
          `已移除（不属于${merged.city}）`,
        );

        merged.districts = sanitized.districts;
        merged.subDistricts = sanitized.subDistricts;
      }
    }

    // 区域：新提到的区域**追加**（客户可能扩大或转移范围）
    if (canTouch('districts') && extracted.districts.length > 0) {
      const override = isOverride('districts');
      const previous = override ? [...merged.districts] : [...merged.districts];

      if (override) {
        merged.districts = [...new Set(extracted.districts)];
      } else {
        merged.districts = [...new Set([...merged.districts, ...extracted.districts])];
      }

      if (merged.districts.join(',') !== previous.join(',')) {
        recordChange(
          'districts',
          '区域',
          override ? RequirementChangeType.OVERRIDDEN : RequirementChangeType.ADDED,
          previous.length > 0 ? previous.join('、') : '未明确',
          merged.districts.join('、'),
        );
      }
    }

    if (canTouch('subDistricts') && extracted.subDistricts.length > 0) {
      const override = isOverride('subDistricts');
      const previous = [...merged.subDistricts];

      if (override) {
        merged.subDistricts = [...new Set(extracted.subDistricts)];
      } else {
        // 板块按偏好顺序排列：最新的排前面（客户最近提到的往往是他最在意的）
        merged.subDistricts = [
          ...new Set([...extracted.subDistricts, ...merged.subDistricts]),
        ];
      }

      if (merged.subDistricts.join(',') !== previous.join(',')) {
        recordChange(
          'subDistricts',
          '板块',
          override ? RequirementChangeType.OVERRIDDEN : RequirementChangeType.UPDATED,
          previous.length > 0 ? previous.join('、') : '未明确',
          merged.subDistricts.join('、'),
        );
      }
    }

    if (canTouch('communities') && extracted.communities.length > 0) {
      const previous = [...merged.communities];
      merged.communities = [...new Set([...merged.communities, ...extracted.communities])];
      if (merged.communities.join(',') !== previous.join(',')) {
        recordChange(
          'communities',
          '小区',
          RequirementChangeType.ADDED,
          previous.length > 0 ? previous.join('、') : '未明确',
          merged.communities.join('、'),
        );
      }
    }

    // =====================================================================
    // 3. 户型
    // =====================================================================
    if (canTouch('bedrooms') && extracted.bedrooms.preferred !== null) {
      const newBedrooms = extracted.bedrooms.preferred;
      const override = isOverride('bedrooms') || extracted.bedrooms.strict;

      if (merged.bedrooms.length === 0) {
        merged.bedrooms = [newBedrooms];
        recordChange(
          'bedrooms',
          '户型',
          RequirementChangeType.ADDED,
          '未明确',
          `${newBedrooms} 房`,
        );
      } else if (override) {
        // 客户明确改口（"现在只考虑三房"）→ 替换
        const previous = [...merged.bedrooms];
        merged.bedrooms = [newBedrooms];
        if (previous.join(',') !== String(newBedrooms)) {
          recordChange(
            'bedrooms',
            '户型',
            RequirementChangeType.OVERRIDDEN,
            `${previous.join('/')} 房`,
            `${newBedrooms} 房`,
          );
        }
      } else if (!merged.bedrooms.includes(newBedrooms)) {
        // 未改口 → 追加为可接受范围（"三房最好，两房也可以"）
        const previous = [...merged.bedrooms];
        merged.bedrooms = [...merged.bedrooms, newBedrooms].sort((a, b) => a - b);
        recordChange(
          'bedrooms',
          '户型',
          RequirementChangeType.UPDATED,
          `${previous.join('/')} 房`,
          `${merged.bedrooms.join('/')} 房`,
        );
      }
    }

    if (canTouch('bedroomsStrict') && extracted.bedrooms.strict && !merged.bedroomsStrict) {
      merged.bedroomsStrict = true;
      recordChange('bedroomsStrict', '户型要求', RequirementChangeType.UPDATED, '可商量', '硬性要求');
    }

    // =====================================================================
    // 4. 面积（取并集范围，不覆盖已明确的边界）
    // =====================================================================
    if (canTouch('areaMin') && extracted.areaMin !== null) {
      if (merged.areaMin === null) {
        merged.areaMin = extracted.areaMin;
        recordChange(
          'areaMin',
          '最小面积',
          RequirementChangeType.ADDED,
          '未明确',
          `${extracted.areaMin}㎡`,
        );
      } else if (isOverride('areaMin')) {
        recordChange(
          'areaMin',
          '最小面积',
          RequirementChangeType.OVERRIDDEN,
          `${merged.areaMin}㎡`,
          `${extracted.areaMin}㎡`,
        );
        merged.areaMin = extracted.areaMin;
      } else if (extracted.areaMin < merged.areaMin) {
        recordChange(
          'areaMin',
          '最小面积',
          RequirementChangeType.UPDATED,
          `${merged.areaMin}㎡`,
          `${extracted.areaMin}㎡`,
        );
        merged.areaMin = extracted.areaMin;
      }
    }

    if (canTouch('areaMax') && extracted.areaMax !== null) {
      if (merged.areaMax === null) {
        merged.areaMax = extracted.areaMax;
        recordChange(
          'areaMax',
          '最大面积',
          RequirementChangeType.ADDED,
          '未明确',
          `${extracted.areaMax}㎡`,
        );
      } else if (isOverride('areaMax')) {
        recordChange(
          'areaMax',
          '最大面积',
          RequirementChangeType.OVERRIDDEN,
          `${merged.areaMax}㎡`,
          `${extracted.areaMax}㎡`,
        );
        merged.areaMax = extracted.areaMax;
      } else if (extracted.areaMax > merged.areaMax) {
        recordChange(
          'areaMax',
          '最大面积',
          RequirementChangeType.UPDATED,
          `${merged.areaMax}㎡`,
          `${extracted.areaMax}㎡`,
        );
        merged.areaMax = extracted.areaMax;
      }
    }

    // =====================================================================
    // 5. 房龄
    // =====================================================================
    if (canTouch('buildingAgePreference')) {
      // ANY 表示客户说"无所谓"，是有意义的信息，但不应覆盖已明确的偏好
      if (
        extracted.buildingAge.preference !== BuildingAgePreference.ANY &&
        extracted.buildingAge.preference !== merged.buildingAgePreference
      ) {
        const previous = merged.buildingAgePreference;
        merged.buildingAgePreference = extracted.buildingAge.preference;

        // 偏好收紧（如 ANY → WITHIN_5）时记录为调整
        if (previous === null) {
          recordChange(
            'buildingAgePreference',
            '房龄',
            RequirementChangeType.ADDED,
            '未明确',
            BUILDING_AGE_LABELS[extracted.buildingAge.preference],
          );
        } else if (this.isAgePreferenceTighter(extracted.buildingAge.preference, previous)) {
          recordChange(
            'buildingAgePreference',
            '房龄',
            RequirementChangeType.UPDATED,
            BUILDING_AGE_LABELS[previous],
            BUILDING_AGE_LABELS[extracted.buildingAge.preference],
          );
        }
      }
    }

    if (canTouch('avoidOldCommunity') && extracted.buildingAge.avoidOld && !merged.avoidOldCommunity) {
      merged.avoidOldCommunity = true;
      recordChange('avoidOldCommunity', '排除老小区', RequirementChangeType.ADDED, '未要求', '要求较新小区');
    }

    // =====================================================================
    // 6. 维度优先级（取更高者 —— 客户强调过就一直是重点）
    // =====================================================================
    this.mergePriority(merged, 'communityQualityPriority', '小区环境', extracted.communityQuality, {
      recordChange,
      canTouch,
    });
    this.mergePriority(merged, 'subwayPriority', '地铁交通', extracted.subway, {
      recordChange,
      canTouch,
    });
    this.mergePriority(merged, 'schoolPriority', '学区', extracted.school, {
      recordChange,
      canTouch,
    });
    this.mergePriority(merged, 'decorationPriority', '装修', extracted.decoration, {
      recordChange,
      canTouch,
    });
    this.mergePriority(merged, 'orientationPreference', '朝向', extracted.orientation, {
      recordChange,
      canTouch,
    });

    // =====================================================================
    // 7. 楼层与装修偏好
    // =====================================================================
    if (
      canTouch('floorPreference') &&
      extracted.floorPreference !== RequirementFloorPreference.ANY &&
      extracted.floorPreference !== merged.floorPreference
    ) {
      const previous = merged.floorPreference;
      merged.floorPreference = extracted.floorPreference;
      recordChange(
        'floorPreference',
        '楼层偏好',
        previous === null ? RequirementChangeType.ADDED : RequirementChangeType.UPDATED,
        previous ? REQUIREMENT_FLOOR_LABELS[previous] : '未明确',
        REQUIREMENT_FLOOR_LABELS[extracted.floorPreference],
      );
    }

    if (canTouch('decorationPreference')) {
      const newDecoration = extracted.decorationPreference;
      if (
        newDecoration !== DecorationPreferenceLevel.ANY &&
        newDecoration !== merged.decorationPreference
      ) {
        const previous = merged.decorationPreference;
        merged.decorationPreference = newDecoration;
        recordChange(
          'decorationPreference',
          '装修要求',
          previous === null ? RequirementChangeType.ADDED : RequirementChangeType.UPDATED,
          previous ? REQUIREMENT_DECORATION_LABELS[previous] : '未明确',
          REQUIREMENT_DECORATION_LABELS[newDecoration],
        );
      }
    }

    if (canTouch('requireFineDecoration') && extracted.requireFineDecoration && !merged.requireFineDecoration) {
      merged.requireFineDecoration = true;
      recordChange('requireFineDecoration', '精装要求', RequirementChangeType.ADDED, '未要求', '必须精装');
    }

    // =====================================================================
    // 8. 排除项（只增不减，除非客户明确说可以接受）
    // =====================================================================
    if (canTouch('avoidFirstFloor') && extracted.avoidFirstFloor && !merged.avoidFirstFloor) {
      merged.avoidFirstFloor = true;
      recordChange('avoidFirstFloor', '排除一楼', RequirementChangeType.ADDED, '未要求', '不要一楼');
    }
    if (canTouch('avoidTopFloor') && extracted.avoidTopFloor && !merged.avoidTopFloor) {
      merged.avoidTopFloor = true;
      recordChange('avoidTopFloor', '排除顶楼', RequirementChangeType.ADDED, '未要求', '不要顶楼');
    }
    if (canTouch('requireElevator') && extracted.requireElevator && !merged.requireElevator) {
      merged.requireElevator = true;
      recordChange('requireElevator', '电梯要求', RequirementChangeType.ADDED, '未要求', '必须有电梯');
    }

    // =====================================================================
    // 9. 学区（这里有明确的互斥逻辑）
    // =====================================================================
    if (canTouch('schoolNotNeeded') && extracted.schoolNotNeeded) {
      if (merged.schoolRequired) {
        recordChange(
          'schoolRequired',
          '学区要求',
          RequirementChangeType.REMOVED,
          '必须学区',
          '客户明确表示学区无所谓',
        );
      }
      merged.schoolNotNeeded = true;
      merged.schoolRequired = false;
    } else if (canTouch('schoolRequired') && extracted.schoolRequired && !merged.schoolRequired) {
      merged.schoolRequired = true;
      merged.schoolNotNeeded = false;
      recordChange('schoolRequired', '学区要求', RequirementChangeType.ADDED, '未要求', '需要学区');
    }

    if (canTouch('schoolNote') && extracted.schoolNote && extracted.schoolNote !== merged.schoolNote) {
      merged.schoolNote = extracted.schoolNote;
      recordChange('schoolNote', '学区说明', RequirementChangeType.UPDATED, '未明确', extracted.schoolNote);
    }

    // =====================================================================
    // 10. 交通与通勤
    // =====================================================================
    if (canTouch('subwayDistanceMax') && extracted.subwayDistanceMax !== null) {
      if (merged.subwayDistanceMax === null) {
        merged.subwayDistanceMax = extracted.subwayDistanceMax;
        recordChange(
          'subwayDistanceMax',
          '地铁距离',
          RequirementChangeType.ADDED,
          '未明确',
          `${extracted.subwayDistanceMax}米内`,
        );
      } else if (extracted.subwayDistanceMax < merged.subwayDistanceMax) {
        // 客户要求变严 → 收紧
        recordChange(
          'subwayDistanceMax',
          '地铁距离',
          RequirementChangeType.UPDATED,
          `${merged.subwayDistanceMax}米内`,
          `${extracted.subwayDistanceMax}米内`,
        );
        merged.subwayDistanceMax = extracted.subwayDistanceMax;
      } else if (isOverride('subwayDistanceMax')) {
        recordChange(
          'subwayDistanceMax',
          '地铁距离',
          RequirementChangeType.OVERRIDDEN,
          `${merged.subwayDistanceMax}米内`,
          `${extracted.subwayDistanceMax}米内`,
        );
        merged.subwayDistanceMax = extracted.subwayDistanceMax;
      }
    }

    if (canTouch('commuteLocations') && extracted.commuteLocations.length > 0) {
      const previous = [...merged.commuteLocations];
      merged.commuteLocations = [...new Set([...merged.commuteLocations, ...extracted.commuteLocations])];
      if (merged.commuteLocations.length !== previous.length) {
        recordChange(
          'commuteLocations',
          '通勤地点',
          RequirementChangeType.ADDED,
          previous.length > 0 ? previous.join('、') : '未明确',
          merged.commuteLocations.join('、'),
        );
      }
    }

    if (canTouch('carConvenience') && extracted.carConvenience && !merged.carConvenience) {
      merged.carConvenience = true;
      recordChange('carConvenience', '开车便利', RequirementChangeType.ADDED, '未要求', '重视开车便利');
    }

    // =====================================================================
    // 11. 购房意图（这些是"最后说的算"，因为客户意图会变化）
    // =====================================================================
    if (canTouch('purchasePurpose') && extracted.purchasePurpose && extracted.purchasePurpose !== merged.purchasePurpose) {
      const previous = merged.purchasePurpose;
      merged.purchasePurpose = extracted.purchasePurpose;
      recordChange(
        'purchasePurpose',
        '购房目的',
        previous === null ? RequirementChangeType.ADDED : RequirementChangeType.OVERRIDDEN,
        previous ?? '未明确',
        extracted.purchasePurpose,
      );
    }

    if (canTouch('paymentMethod') && extracted.paymentMethod && extracted.paymentMethod !== merged.paymentMethod) {
      const previous = merged.paymentMethod;
      merged.paymentMethod = extracted.paymentMethod;
      recordChange(
        'paymentMethod',
        '付款方式',
        previous === null ? RequirementChangeType.ADDED : RequirementChangeType.UPDATED,
        previous ?? '未明确',
        extracted.paymentMethod,
      );
    }

    if (
      canTouch('purchaseTimeline') &&
      extracted.purchaseTimeline &&
      extracted.purchaseTimeline !== merged.purchaseTimeline
    ) {
      const previous = merged.purchaseTimeline;
      merged.purchaseTimeline = extracted.purchaseTimeline;
      recordChange(
        'purchaseTimeline',
        '购房时间',
        previous === null ? RequirementChangeType.ADDED : RequirementChangeType.UPDATED,
        previous ?? '未明确',
        extracted.purchaseTimeline,
      );
    }

    // =====================================================================
    // 12. 决策参与者与家庭关注点
    // =====================================================================
    if (canTouch('decisionMakers') && extracted.decisionMakers.length > 0) {
      const previous = [...merged.decisionMakers];
      merged.decisionMakers = [...new Set([...merged.decisionMakers, ...extracted.decisionMakers])];
      if (merged.decisionMakers.length !== previous.length) {
        recordChange(
          'decisionMakers',
          '决策参与人',
          previous.length === 0 ? RequirementChangeType.ADDED : RequirementChangeType.UPDATED,
          previous.length > 0 ? previous.map((m) => DECISION_MAKER_LABELS[m]).join('、') : '未明确',
          merged.decisionMakers.map((m) => DECISION_MAKER_LABELS[m]).join('、'),
        );
      }
    }

    if (canTouch('familyConcerns') && extracted.familyConcerns.length > 0) {
      const previous = [...merged.familyConcerns];
      merged.familyConcerns = [...new Set([...merged.familyConcerns, ...extracted.familyConcerns])];
      if (merged.familyConcerns.length !== previous.length) {
        recordChange(
          'familyConcerns',
          '家人关注点',
          RequirementChangeType.ADDED,
          previous.length > 0 ? previous.join('；') : '未明确',
          merged.familyConcerns.join('；'),
        );
      }
    }

    if (canTouch('otherRequirements') && extracted.otherRequirements.length > 0) {
      const previous = [...merged.otherRequirements];
      merged.otherRequirements = [
        ...new Set([...merged.otherRequirements, ...extracted.otherRequirements]),
      ];
      if (merged.otherRequirements.length !== previous.length) {
        recordChange(
          'otherRequirements',
          '其它要求',
          RequirementChangeType.ADDED,
          previous.length > 0 ? previous.join('；') : '未明确',
          merged.otherRequirements.join('；'),
        );
      }
    }

    // =====================================================================
    // 13. 置信度与元信息
    // =====================================================================
    // 置信度取加权平均：新消息越明确，整体置信度越高；消息数越多，整体越可信
    const newCount = merged.sourceMessageCount + 1;
    merged.confidence =
      Math.round(((existing.confidence * existing.sourceMessageCount + extracted.confidence) / newCount) * 100) / 100;
    merged.sourceMessageCount = newCount;

    // =====================================================================
    // 14. 判断是否需要人工确认
    // =====================================================================
    const hasOverride = changes.some((change) => change.isOverride);
    const conflicts = changes.filter(
      (change) =>
        change.changeType === RequirementChangeType.OVERRIDDEN ||
        change.newDisplay.includes('请确认'),
    );

    // 预算变化幅度超过 30% 也需确认（可能是 AI 抽取错误，也可能是客户真实改口）
    const budgetChange = changes.find((change) => change.field.startsWith('budget'));
    let largeBudgetShift = false;
    if (budgetChange && existing.budgetNormalMax && merged.budgetNormalMax) {
      const shift = Math.abs(merged.budgetNormalMax - existing.budgetNormalMax) / existing.budgetNormalMax;
      largeBudgetShift = shift > 0.3;
    }

    const needsConfirmation =
      conflicts.length > 0 || extracted.confidence < 0.6 || largeBudgetShift;

    this.logger.log(
      `需求合并完成：客户变更 ${changes.length} 项` +
        `${hasOverride ? `（含 ${changes.filter((c) => c.isOverride).length} 项改口）` : ''}，` +
        `预算 target=${this.formatWan(merged.budgetTarget)} ` +
        `normalMax=${this.formatWan(merged.budgetNormalMax)} ` +
        `stretchMax=${this.formatWan(merged.budgetStretchMax)}` +
        `${merged.budgetStrictMax ? '（严格上限）' : ''}` +
        `${needsConfirmation ? '，需人工确认' : ''}`,
    );

    return { merged, changes, hasOverride, needsConfirmation };
  }

  // =========================================================================
  // 三级预算合并（单独抽出，因为它是核心逻辑，需要重点测试）
  // =========================================================================

  private mergeBudget(
    merged: MergedRequirementProfile,
    extracted: RequirementExtraction,
    context: {
      recordChange: (
        field: string,
        label: string,
        changeType: RequirementChangeType,
        previousDisplay: string,
        newDisplay: string,
      ) => void;
      isOverride: (field: string) => boolean;
      canTouch: (field: string) => boolean;
      logger: Logger;
    },
  ): void {
    const { recordChange, isOverride, canTouch } = context;
    const budget = extracted.budget;

    if (!canTouch('budget')) return;

    const previousTarget = merged.budgetTarget;
    const previousNormalMax = merged.budgetNormalMax;
    const previousStretchMax = merged.budgetStretchMax;
    const previousStrict = merged.budgetStrictMax;

    const budgetOverride = isOverride('budget');

    // ---- 严格上限：客户说"超过不看"时必须立即生效，且收缩上限 ----
    if (budget.strictMax) {
      // 严格上限的取值优先级：normalMax > stretchMax > target
      const strictValue = budget.normalMax ?? budget.stretchMax ?? budget.target;

      if (strictValue !== null) {
        // 严格上限是"天花板"，它会压过原有的 stretchMax
        if (merged.budgetStretchMax !== null && merged.budgetStretchMax > strictValue) {
          merged.budgetStretchMax = null;
        }
        if (merged.budgetNormalMax === null || merged.budgetNormalMax > strictValue || budgetOverride) {
          merged.budgetNormalMax = strictValue;
        }
      }
      merged.budgetStrictMax = true;
    }

    // ---- 理想预算（target）----
    if (budget.target !== null) {
      if (merged.budgetTarget === null) {
        merged.budgetTarget = budget.target;
      } else if (budgetOverride) {
        merged.budgetTarget = budget.target;
      } else if (budget.target < merged.budgetTarget) {
        // 客户说的理想价位比原来低 → 这是更有信息量的表达（更保守的期望）
        merged.budgetTarget = budget.target;
      }
      // 注意：target 高于原有值时**不覆盖**。
      // 理由：客户说"600以内也可以"应该进 normalMax，而不是把理想预算抬高。
      // 如果抽取器错误地把它放进了 target，这里保持原值可以避免污染核心判断。
    }

    // ---- 常规上限（normalMax）----
    if (budget.normalMax !== null) {
      if (merged.budgetNormalMax === null) {
        merged.budgetNormalMax = budget.normalMax;
      } else if (budgetOverride || budget.strictMax) {
        // 改口或严格上限 → 直接采用新值（可能是收缩）
        merged.budgetNormalMax = budget.normalMax;
      } else if (budget.normalMax > merged.budgetNormalMax) {
        // 放宽上限 → 提升
        merged.budgetNormalMax = budget.normalMax;
      } else if (
        // 客户**再次**给出一个更低的常规上限，且这次不是严格语气 → 允许回落。
        //
        // 为什么需要这个分支（踩过的坑）：
        //   早期实现里上限"只升不降"，理由是"避免抽取波动导致过滤过严"。
        //   但如果某次解析把客户的"600以内也可以"误判为严格上限（strictMax=true），
        //   normalMax 会被夹到 600，之后即使客户说"其实 550 就够了"也无法回落 ——
        //   结果是三级预算退化（最高 600 / 极限 600），推荐范围被永久撑大。
        //
        //   现在的规则：只要客户这次明确说了常规上限（非严格语气），
        //   就以最新表达为准。客户的最新表达应该优先于我们的历史推断。
        !merged.budgetStrictMax
      ) {
        merged.budgetNormalMax = budget.normalMax;
        context.logger.log(
          `预算上限按客户最新表达回落：${this.formatWan(previousNormalMax)} → ` +
            `${this.formatWan(budget.normalMax)}`,
        );
      }
    }

    // ---- 极限上限（stretchMax）----
    if (budget.stretchMax !== null) {
      if (merged.budgetStretchMax === null) {
        merged.budgetStretchMax = budget.stretchMax;
      } else if (budgetOverride) {
        merged.budgetStretchMax = budget.stretchMax;
      } else if (budget.stretchMax > merged.budgetStretchMax) {
        merged.budgetStretchMax = budget.stretchMax;
      }
    }

    // ---- 预算下限 ----
    if (budget.min !== null && canTouch('budgetMin')) {
      if (merged.budgetMin === null || budget.min > merged.budgetMin) {
        merged.budgetMin = budget.min;
      }
    }

    // ---- 一致性校验（确定性代码负责，不交给 AI）----
    // 确保 target ≤ normalMax ≤ stretchMax，否则打分逻辑会出现矛盾
    if (merged.budgetTarget !== null) {
      if (merged.budgetNormalMax !== null && merged.budgetNormalMax < merged.budgetTarget) {
        // 客户说"理想 600，最多 550" 这种矛盾表达 → 以更保守的为准
        context.logger.warn(
          `预算表达矛盾：理想 ${this.formatWan(merged.budgetTarget)} 高于常规上限 ` +
            `${this.formatWan(merged.budgetNormalMax)}，已按更保守值调整理想预算`,
        );
        merged.budgetTarget = merged.budgetNormalMax;
      }
      if (merged.budgetStretchMax !== null && merged.budgetStretchMax < merged.budgetTarget) {
        merged.budgetStretchMax = merged.budgetTarget;
      }
    }
    if (
      merged.budgetNormalMax !== null &&
      merged.budgetStretchMax !== null &&
      merged.budgetStretchMax < merged.budgetNormalMax
    ) {
      merged.budgetStretchMax = merged.budgetNormalMax;
    }

    // ---- 记录变化 ----
    const formatTriple = (
      target: number | null,
      normalMax: number | null,
      stretchMax: number | null,
      strict: boolean,
    ): string => {
      const parts: string[] = [];
      if (target !== null) parts.push(`理想 ${this.formatWan(target)}`);
      if (normalMax !== null) parts.push(`最高 ${this.formatWan(normalMax)}`);
      if (stretchMax !== null) parts.push(`极限 ${this.formatWan(stretchMax)}`);
      if (strict && normalMax !== null) parts.push('（超出不看）');
      return parts.length > 0 ? parts.join('，') : '未明确';
    };

    const previousDisplay = formatTriple(
      previousTarget,
      previousNormalMax,
      previousStretchMax,
      previousStrict,
    );
    const newDisplay = formatTriple(
      merged.budgetTarget,
      merged.budgetNormalMax,
      merged.budgetStretchMax,
      merged.budgetStrictMax,
    );

    if (previousDisplay !== newDisplay) {
      const changeType =
        previousTarget === null && previousNormalMax === null && previousStretchMax === null
          ? RequirementChangeType.ADDED
          : budgetOverride || (budget.strictMax && !previousStrict)
            ? RequirementChangeType.OVERRIDDEN
            : RequirementChangeType.UPDATED;

      recordChange('budget', '预算', changeType, previousDisplay, newDisplay);
    }
  }

  // =========================================================================
  // 辅助
  // =========================================================================

  /**
   * 合并优先级维度。
   *
   * 规则：**取更高者**。
   * 理由：客户说过"很在意地铁"，这个信息不会因为他下次没提就消失。
   * 如果每次都用新值覆盖，客户提过一次的重点会在下一次消息后丢失。
   */
  private mergePriority(
    merged: MergedRequirementProfile,
    field:
      | 'communityQualityPriority'
      | 'subwayPriority'
      | 'schoolPriority'
      | 'decorationPriority'
      | 'orientationPreference',
    label: string,
    newValue: PreferencePriority,
    context: {
      recordChange: (
        field: string,
        label: string,
        changeType: RequirementChangeType,
        previousDisplay: string,
        newDisplay: string,
      ) => void;
      canTouch: (field: string) => boolean;
    },
  ): void {
    if (!context.canTouch(field)) return;
    if (newValue === PreferencePriority.UNKNOWN) return;

    const current = merged[field];
    const rank: Record<PreferencePriority, number> = {
      [PreferencePriority.HIGH]: 3,
      [PreferencePriority.MEDIUM]: 2,
      [PreferencePriority.LOW]: 1,
      [PreferencePriority.UNKNOWN]: 0,
    };

    if (rank[newValue] > rank[current ?? PreferencePriority.UNKNOWN]) {
      const previousDisplay = current
        ? PREFERENCE_PRIORITY_LABELS[current]
        : '未提及';
      merged[field] = newValue;
      context.recordChange(
        field,
        label,
        current === null ? RequirementChangeType.ADDED : RequirementChangeType.UPDATED,
        previousDisplay,
        PREFERENCE_PRIORITY_LABELS[newValue],
      );
    }
  }

  /** 判断房龄偏好是否变得更严格 */
  private isAgePreferenceTighter(
    next: BuildingAgePreference,
    previous: BuildingAgePreference,
  ): boolean {
    const strictness: Record<BuildingAgePreference, number> = {
      [BuildingAgePreference.WITHIN_5]: 4,
      [BuildingAgePreference.WITHIN_10]: 3,
      [BuildingAgePreference.NEWER]: 2,
      [BuildingAgePreference.WITHIN_20]: 1,
      [BuildingAgePreference.ANY]: 0,
    };
    return strictness[next] > strictness[previous];
  }

  /** 金额格式化（万元） */
  private formatWan(amount: number | null): string {
    if (amount === null) return '—';
    return `${Math.round(amount / 10_000)}万`;
  }
}
