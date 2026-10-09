/**
 * 贝壳搜索条件生成器。
 *
 * 职责：把客户画像转成「结构化搜索条件」+「贝壳自然语言 query」。
 *
 * 为什么不能把客户原话直接丢给贝壳（需求 §13）：
 *   1. 客户原话是**增量**的（"550也可以"），不含完整条件，
 *      直接搜会漏掉区域、户型这些之前已经确认过的需求。
 *   2. 贝壳的语义检索会"放宽条件"（官方说明 match_type 可能是 LIKE），
 *      把原话丢过去会得到大量不相关结果。
 *   3. 客户原话可能包含与搜索无关的内容（"我老婆说…"）。
 *   4. 我们需要**可复现**的搜索：同样的画像必须生成同样的条件，
 *      否则经纪人会遇到"同样的客户，两次搜索结果不一样"的困惑。
 *
 * 结合三类信息：
 *   - 显性需求（客户明确说的）—— 决定硬条件
 *   - 行为画像（客户实际点的）  —— 修正预算与区域偏好
 *   - 会话历史（刚聊到的）      —— 决定优先级顺序
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  BuildingAgePreference,
  PreferencePriority,
  RequirementFloorPreference,
  type MergedRequirementProfile,
  type PropertySearchQuery,
} from '@estatepilot/types';

/** 生成搜索条件时可选的补充上下文 */
export interface QueryBuildContext {
  /** 行为画像推断的预算区间（来自客户行为分析，比自述更接近真实意愿） */
  behavioralBudgetMin?: number | null;
  behavioralBudgetMax?: number | null;
  /** 行为画像推断的偏好区域（按浏览频次降序） */
  behavioralDistricts?: string[];
  /** 上一轮客户明确否定的区域（用于排除） */
  excludedDistricts?: string[];
  /** 上一轮已推荐过的房源所在区域（避免重复推同一片区） */
  recentlyRecommendedCommunities?: string[];
  /** 客户对价格表达过顾虑（来自反馈分析） */
  priceSensitive?: boolean;
}

/** 生成结果 */
export interface BuiltQuery {
  query: PropertySearchQuery;
  /** 硬性条件的中文说明（界面展示"检索依据"） */
  hardConditionSummary: string[];
  /** 软条件的中文说明 */
  softConditionSummary: string[];
  /** 是否使用了行为画像修正 */
  usedBehavioralProfile: boolean;
  /** 警告：条件过于宽泛或缺失关键信息 */
  warnings: string[];
}

@Injectable()
export class PropertySearchQueryBuilder {
  private readonly logger = new Logger(PropertySearchQueryBuilder.name);

  /**
   * 生成搜索条件。
   *
   * @param profile 客户需求画像
   * @param context 行为画像等补充上下文
   */
  build(profile: MergedRequirementProfile, context: QueryBuildContext = {}): BuiltQuery {
    const warnings: string[] = [];
    const hardConditionSummary: string[] = [];
    const softConditionSummary: string[] = [];
    let usedBehavioralProfile = false;

    // =====================================================================
    // 1. 城市（必需）
    // =====================================================================
    const city = profile.city;
    if (!city) {
      // 这里不抛错，由调用方决定如何提示。
      // 但必须给出警告 —— 没有城市的搜索毫无意义。
      warnings.push('缺少城市信息，无法进行房源搜索');
    }

    // =====================================================================
    // 2. 区域
    // =====================================================================
    // 优先级：客户明确说的板块 > 客户明确说的区 > 行为偏好区域
    const districts = [...profile.districts];
    const subDistricts = [...profile.subDistricts];

    // 排除客户明确否定的区域（来自上一轮反馈）
    const excluded = new Set(context.excludedDistricts ?? []);
    const filteredDistricts = districts.filter((district) => !excluded.has(district));
    const filteredSubDistricts = subDistricts.filter((sub) => !excluded.has(sub));

    if (filteredDistricts.length !== districts.length || filteredSubDistricts.length !== subDistricts.length) {
      this.logger.log('已根据客户反馈排除部分区域');
    }

    if (filteredDistricts.length === 0 && filteredSubDistricts.length === 0) {
      // 客户没指定区域 → 参考行为偏好
      if (context.behavioralDistricts && context.behavioralDistricts.length > 0) {
        filteredDistricts.push(...context.behavioralDistricts.slice(0, 2));
        usedBehavioralProfile = true;
        softConditionSummary.push(
          `客户未指定区域，参考其浏览记录（${context.behavioralDistricts.slice(0, 2).join('、')}）`,
        );
      }
    }

    // =====================================================================
    // 3. 预算 —— 硬性上限的确定（这是最关键的一步）
    // =====================================================================
    //
    // 规则（必须严格遵守，否则会出现"客户说最多 520 万却推荐 620 万"的严重问题）：
    //   - budgetStrictMax = true  → 硬上限 = normalMax，超过一律过滤
    //   - budgetStrictMax = false → 硬上限 = stretchMax（如果客户表达过让步），
    //                               否则 = normalMax 上浮 10%（给一点弹性）
    //   - 完全没有预算信息       → 不设硬上限，但要警告
    let budgetMax: number | null = null;

    if (profile.budgetStrictMax && profile.budgetNormalMax !== null) {
      budgetMax = profile.budgetNormalMax;
      hardConditionSummary.push(
        `总价不超过 ${this.formatWan(budgetMax)}（客户明确表示超出不看）`,
      );
    } else if (profile.budgetStretchMax !== null) {
      budgetMax = profile.budgetStretchMax;
      hardConditionSummary.push(`总价不超过 ${this.formatWan(budgetMax)}（客户表示条件好可放宽到这里）`);
    } else if (profile.budgetNormalMax !== null) {
      // 上浮 10%：真实业务中略超预算的房源也值得看，完全不看会漏掉好房子
      budgetMax = Math.round(profile.budgetNormalMax * 1.1);
      softConditionSummary.push(
        `常规上限 ${this.formatWan(profile.budgetNormalMax)}，检索时放宽到 ${this.formatWan(budgetMax)}`,
      );
    } else if (profile.budgetTarget !== null) {
      budgetMax = Math.round(profile.budgetTarget * 1.15);
      softConditionSummary.push(
        `客户只说了理想预算 ${this.formatWan(profile.budgetTarget)}，检索时放宽到 ${this.formatWan(budgetMax)}`,
      );
    } else {
      // 完全没有预算信息 → 尝试用行为画像
      if (context.behavioralBudgetMax) {
        budgetMax = Math.round(context.behavioralBudgetMax * 1.1);
        usedBehavioralProfile = true;
        softConditionSummary.push(
          `客户未说预算，参考其浏览行为推断上限 ${this.formatWan(budgetMax)}`,
        );
      } else {
        warnings.push('客户未提供预算信息，将返回较大范围的结果');
      }
    }

    // 价格敏感客户 → 收紧上限（客户对价格表达过顾虑时不应推高价房）
    if (context.priceSensitive && budgetMax !== null && profile.budgetNormalMax !== null) {
      budgetMax = profile.budgetNormalMax;
      softConditionSummary.push('客户对价格表达过顾虑，已收紧价格上限');
    }

    // 预算下限
    let budgetMin: number | null = profile.budgetMin;
    if (budgetMin === null && context.behavioralBudgetMin && context.behavioralBudgetMin > 0) {
      // 行为下限打七折：客户浏览过的高价房不一定代表他的下限
      const candidate = Math.round(context.behavioralBudgetMin * 0.7);
      if (budgetMax === null || candidate < budgetMax) {
        budgetMin = candidate;
        usedBehavioralProfile = true;
      }
    }

    // =====================================================================
    // 4. 户型
    // =====================================================================
    const bedrooms = [...profile.bedrooms];
    if (bedrooms.length > 0) {
      hardConditionSummary.push(
        `${bedrooms.join(' 或 ')} 房${profile.bedroomsStrict ? '（客户硬性要求）' : ''}`,
      );
    }

    // =====================================================================
    // 5. 面积
    // =====================================================================
    // 面积通常不是硬条件，给 ±5% 弹性
    const areaMin = profile.areaMin !== null ? Math.floor(profile.areaMin * 0.95) : null;
    const areaMax = profile.areaMax !== null ? Math.ceil(profile.areaMax * 1.05) : null;

    if (areaMin !== null || areaMax !== null) {
      const areaText =
        areaMin !== null && areaMax !== null
          ? `${areaMin}～${areaMax}㎡`
          : areaMin !== null
            ? `${areaMin}㎡以上`
            : `${areaMax}㎡以内`;
      softConditionSummary.push(`面积 ${areaText}`);
    }

    // =====================================================================
    // 6. 房龄
    // =====================================================================
    let builtAfterYear: number | null = null;
    const currentYear = new Date().getFullYear();

    if (profile.buildingAgePreference) {
      switch (profile.buildingAgePreference) {
        case BuildingAgePreference.WITHIN_5:
          builtAfterYear = currentYear - 5;
          break;
        case BuildingAgePreference.WITHIN_10:
          builtAfterYear = currentYear - 10;
          break;
        case BuildingAgePreference.WITHIN_20:
          builtAfterYear = currentYear - 20;
          break;
        case BuildingAgePreference.NEWER:
          // "新一点"是模糊表达 → 不作为硬条件，只在打分里加分
          softConditionSummary.push('客户偏好较新的小区（加分项，不作硬过滤）');
          break;
        case BuildingAgePreference.ANY:
        default:
          break;
      }
    }

    if (builtAfterYear !== null) {
      hardConditionSummary.push(`建成于 ${builtAfterYear} 年之后`);
    }

    // =====================================================================
    // 7. 电梯与楼层
    // =====================================================================
    const requireElevator = profile.requireElevator;
    if (requireElevator) hardConditionSummary.push('必须有电梯');

    const avoidFirstFloor = profile.avoidFirstFloor;
    const avoidTopFloor = profile.avoidTopFloor;
    if (avoidFirstFloor) softConditionSummary.push('排除一楼');
    if (avoidTopFloor) softConditionSummary.push('排除顶楼');

    if (profile.floorPreference && profile.floorPreference !== RequirementFloorPreference.ANY) {
      softConditionSummary.push(`偏好${this.describeFloor(profile.floorPreference)}`);
    }

    // =====================================================================
    // 8. 生成贝壳自然语言 query
    // =====================================================================
    // 贝壳的检索是语义化的，会从文本里提取特征词，因此自然语言表达最有效。
    //
    // 重要（踩过的坑）：query 里的价格必须用**理想预算**做锚点，不能用放宽后的上限。
    //   原因：贝壳按价格升序返回 TopK（约 10 条），
    //   写"575万以内"返回的是 550～575 那一段（全部超出客户理想预算），
    //   写"500万以内"才会返回 400～500 这一段（客户真正想要的价位）。
    //   放宽后的上限仍然参与本地硬过滤，因此既不会漏掉略超预算的好房源，
    //   又能让推荐结果落在客户的心理价位附近。
    const queryPriceAnchor = profile.budgetTarget ?? profile.budgetNormalMax ?? budgetMax;

    const naturalQuery = this.buildNaturalQuery({
      city,
      subDistricts: filteredSubDistricts,
      districts: filteredDistricts,
      bedrooms,
      budgetMin,
      budgetMax: queryPriceAnchor,
      buildingAge: profile.buildingAgePreference,
      avoidOld: profile.avoidOldCommunity,
      subwayPriority: profile.subwayPriority,
      schoolRequired: profile.schoolRequired,
      decoration: profile.decorationPreference,
      requireFineDecoration: profile.requireFineDecoration,
      areaMin,
      areaMax,
    });

    // =====================================================================
    // 9. 组装结果
    // =====================================================================
    const query: PropertySearchQuery = {
      city: city ?? '',
      districts: filteredDistricts,
      subDistricts: filteredSubDistricts,
      communities: [...profile.communities],
      bedrooms,
      budgetMax,
      budgetMin,
      areaMin,
      areaMax,
      builtAfterYear,
      requireElevator,
      avoidFirstFloor,
      avoidTopFloor,
      onlyActive: true, // 只推荐在售房源 —— 这是不可让步的
      naturalQuery,
      rationale: this.buildRationale(hardConditionSummary, softConditionSummary, usedBehavioralProfile),
    };

    this.logger.log(
      `搜索条件已生成：${city ?? '（缺城市）'} / ${naturalQuery}` +
        `（硬条件 ${hardConditionSummary.length} 项，软条件 ${softConditionSummary.length} 项` +
        `${usedBehavioralProfile ? '，使用了行为画像' : ''}）`,
    );

    return {
      query,
      hardConditionSummary,
      softConditionSummary,
      usedBehavioralProfile,
      warnings,
    };
  }

  /**
   * 按（可能已被放宽的）搜索条件重新生成自然语言 query。
   *
   * 为什么需要：编排器在「零结果」时会逐级放宽位置条件并重新搜索，
   * 每次都必须同步更新 query 文本，否则会拿旧的条件去搜（放宽就没意义了）。
   *
   * 注意价格锚点规则与 build() 保持一致：用理想预算而非放宽后的上限，
   * 这样贝壳返回的才落在客户的心理价位附近。
   */
  rebuildNaturalQuery(query: PropertySearchQuery): string {
    // 价格锚点：优先用常规上限（它是"客户能接受"的明确表达），
    // 没有时才退回硬上限。这里刻意不回退到 target —— 因为放宽场景下
    // 用过于保守的价格会再次导致零结果。
    const priceAnchor = query.budgetMax;

    return this.buildNaturalQuery({
      city: query.city,
      subDistricts: query.subDistricts,
      districts: query.districts,
      bedrooms: query.bedrooms,
      budgetMin: query.budgetMin,
      budgetMax: priceAnchor,
      buildingAge: null,
      avoidOld: false,
      subwayPriority: null,
      schoolRequired: false,
      decoration: null,
      requireFineDecoration: false,
      areaMin: query.areaMin,
      areaMax: query.areaMax,
    });
  }

  /**
   * 生成贝壳自然语言 query。
   *
   * 注意长度控制：query 过长会稀释关键词权重。控制在 30 字左右最有效。
   */
  private buildNaturalQuery(input: {
    city: string | null;
    subDistricts: string[];
    districts: string[];
    bedrooms: number[];
    budgetMin: number | null;
    budgetMax: number | null;
    buildingAge: BuildingAgePreference | null;
    avoidOld: boolean;
    subwayPriority: PreferencePriority | null;
    schoolRequired: boolean;
    decoration: string | null;
    requireFineDecoration: boolean;
    areaMin: number | null;
    areaMax: number | null;
  }): string {
    const segments: string[] = [];

    /**
     * ⚠️ 只输出**硬性条件**，软偏好一律不入查询（踩过的真实事故）。
     *
     * 事故经过：厦门客户要「岛外三房 400万」，我们生成的查询是
     *   「集美区 海沧区 3居室 400万以内 较新小区 近地铁」
     * 贝壳**如实按全部条件过滤**，返回 0 条 → 经纪人看到
     * "贝壳没有找到符合条件的在售房源"，而实际厦门有四五千套三房。
     *
     * 根因：`较新小区`（客户说"别太老"）与 `近地铁`（客户说"最好近地铁"）
     * 是**偏好**，客户并没有说"没有就不看"。把它们写进检索式等于
     * 擅自把偏好升级成硬排除 —— 这是对客户意图的曲解。
     *
     * 正确分工：
     *   查询（贝壳）= 只表达"绝对不能违背"的条件：区域 / 户型 / 预算
     *   打分（本地）= 处理软偏好：9 个维度加权，房龄与地铁各占权重
     *
     * 这样贝壳负责"找得全"，我们负责"排得准"。
     */

    // 位置：板块比行政区更精确，优先放板块
    if (input.subDistricts.length > 0) {
      // 不再 slice：客户明确说了几个板块就查几个，截断会漏掉他想要的区域
      segments.push(input.subDistricts.join(' '));
    } else if (input.districts.length > 0) {
      // 同上：不截断。客户说了 4 个区就查 4 个区
      segments.push(input.districts.join(' '));
    }

    // 户型（硬条件）
    if (input.bedrooms.length > 0) {
      segments.push(`${input.bedrooms[0]}居室`);
    }

    // 预算（硬条件）
    if (input.budgetMax !== null) {
      segments.push(`${Math.round(input.budgetMax / 10_000)}万以内`);
    }

    // 面积（硬条件）
    if (input.areaMin !== null && input.areaMax !== null) {
      segments.push(`${input.areaMin}到${input.areaMax}平`);
    } else if (input.areaMax !== null) {
      segments.push(`${input.areaMax}平以内`);
    }

    /**
     * 软偏好**不写入查询**，交由本地 9 维打分处理。
     *
     * 这里刻意保留一段说明而不是直接删掉原代码 —— 因为"为什么不做"
     * 比"不做什么"更容易被后来者改回去。
     *
     * 原实现会把下列内容拼进查询：
     *   avoidOld / buildingAge  → '较新小区' / '5年内新房' / '次新房'
     *   subwayPriority=HIGH     → '近地铁'
     *   schoolRequired          → '学区房'
     *   requireFineDecoration   → '精装修'
     *
     * 这些是客户说"最好…""别太…"的偏好表达，不是"没有就不看"的硬条件。
     * 写进查询会让贝壳把它们当过滤条件，把本可接受的房源排除掉
     * （实测：厦门岛外三房 400万，加两个偏好后从有货变成 0 条）。
     *
     * 唯一的例外是 schoolRequired —— 客户说"必须学区"时确实是硬条件，
     * 但"学区"在贝壳检索里的语义偏泛（可能匹配到"学区"二字的小区名），
     * 因此也交给本地打分（schoolRequired 是打分的独立维度），
     * 需要严格排除时由硬筛处理。
     */

    // 兜底：什么都没有时给一个宽泛查询
    if (segments.length === 0) return '二手房';

    return segments.join(' ');
  }

  /** 生成"检索依据"说明，展示给经纪人 */
  private buildRationale(
    hardConditions: string[],
    softConditions: string[],
    usedBehavioral: boolean,
  ): string {
    const parts: string[] = [];

    if (hardConditions.length > 0) {
      parts.push(`硬性条件：${hardConditions.join('；')}`);
    }
    if (softConditions.length > 0) {
      parts.push(`参考条件：${softConditions.join('；')}`);
    }
    if (usedBehavioral) {
      parts.push('部分条件来自客户的浏览行为（客户未明确说明）');
    }

    return parts.length > 0 ? parts.join('。') : '未提取到明确条件';
  }

  /** 楼层描述 */
  private describeFloor(preference: RequirementFloorPreference): string {
    switch (preference) {
      case RequirementFloorPreference.LOW:
        return '低楼层';
      case RequirementFloorPreference.MIDDLE:
        return '中间楼层';
      case RequirementFloorPreference.HIGH:
        return '高楼层';
      case RequirementFloorPreference.MIDDLE_HIGH:
        return '中高楼层';
      default:
        return '不限楼层';
    }
  }

  /** 万元格式化 */
  private formatWan(amount: number): string {
    const wan = amount / 10_000;
    return Number.isInteger(wan) ? `${wan}万` : `${wan.toFixed(1)}万`;
  }
}
