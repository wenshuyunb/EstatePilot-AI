/**
 * 中文房产口语规则解析器。
 *
 * 定位（重要）：
 *   这不是 AI 的替代品，而是**两条腿走路**中的一条：
 *     1. AI（WECHAT_REQUIREMENT_EXTRACTION）负责理解复杂、含糊、跨句的表达
 *     2. 本解析器负责确定性的、模式固定的表达，并在 AI 不可用时兜底
 *
 *   为什么必须有它：
 *     - AI 服务可能超时、限流、未配置密钥（本项目的 AI_PROVIDER 默认就是 mock）
 *     - 客户需求是产品命脉，不能因为 AI 抖动就整个流程瘫痪
 *     - 规则可单元测试、结果可复现，而模型输出有随机性
 *
 *   为什么不能只有它：
 *     - "我老婆比较在意小区环境" 这类表达规则难以覆盖
 *     - 多条件交叉、上下文指代需要语言理解
 *
 * 解析覆盖的真实中文表达（均为需求 §63 明确列出的用例）：
 *   预算：500个左右 / 500上下 / 500出头 / 500以内 / 不超过500 / 最多500 /
 *         预算500 / 可以加一点 / 550也行 / 600封顶 / 特别好的600也能考虑
 *   户型：三房 / 三室 / 3居 / 三房两厅 / 只要三房 / 三房最好
 *   面积：100平左右 / 100㎡ / 100多平
 *   楼层：不要一楼 / 不要顶楼 / 中高楼层
 *   房龄：新一点 / 不要太老 / 不要老小区
 *   学区：学区无所谓 / 一定要学区
 *   交通：离地铁近点 / 走路十分钟 / 开车方便
 *   装修：装修无所谓 / 必须精装
 */

import {
  BuildingAgePreference,
  DecisionMaker,
  DecorationPreferenceLevel,
  PreferencePriority,
  RequirementFloorPreference,
  type ExtractedBudget,
  type ExtractedBuildingAge,
  type RequirementExtraction,
} from '@estatepilot/types';
import {
  CITY_BY_DISTRICT,
  CITY_BY_SUB_DISTRICT,
  CITY_LOCATION_PROFILES,
  getCityProfile,
  type CityLocationProfile,
} from './city-locations.js';

/** 中文数字 → 阿拉伯数字（房产场景只需个位到十几） */
const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** 解析户型数量词："三" / "3" / "两" */
function parseCount(text: string): number | null {
  if (!text) return null;
  const trimmed = text.trim();

  // 阿拉伯数字
  const arabic = /^(\d{1,2})$/.exec(trimmed);
  if (arabic?.[1]) return Number(arabic[1]);

  // 中文数字
  if (trimmed === '十') return 10;
  if (trimmed.length === 1) return CN_DIGITS[trimmed] ?? null;

  // 十几、二十几
  const teen = /^十([一二三四五六七八九])$/.exec(trimmed);
  if (teen?.[1]) return 10 + (CN_DIGITS[teen[1]] ?? 0);

  const twenty = /^([二三四五六七八九])十([一二三四五六七八九])?$/.exec(trimmed);
  if (twenty?.[1]) {
    const base = (CN_DIGITS[twenty[1]] ?? 0) * 10;
    return twenty[2] ? base + (CN_DIGITS[twenty[2]] ?? 0) : base;
  }

  return null;
}

/**
 * 解析金额表达 → 元。
 *
 * 支持："500万" "500w" "500W" "五百五十万" "1.2亿" "5000000元" "550"
 * 关键点：房产语境下**裸数字默认是万元**（客户说"预算550"意思是 550 万）。
 */
export function parseAmountToYuan(text: string): number | null {
  if (!text) return null;

  const normalized = text
    .replace(/[，,\s]/g, '')
    .replace(/人民币|块钱|块/g, '')
    .toLowerCase();

  // 亿
  const yi = /(\d+(?:\.\d+)?)\s*(?:亿|個億)/.exec(normalized);
  if (yi?.[1]) return Math.round(Number(yi[1]) * 100_000_000);

  // 万 / w
  const wan = /(\d+(?:\.\d+)?)\s*(?:万|w)/.exec(normalized);
  if (wan?.[1]) return Math.round(Number(wan[1]) * 10_000);

  // 带"元"的完整数字
  const yuan = /(\d{5,9})\s*元/.exec(normalized);
  if (yuan?.[1]) return Number(yuan[1]);

  // 裸数字：房产语境下默认万元（"预算550"）
  const bare = /^(\d{2,5}(?:\.\d+)?)$/.exec(normalized);
  if (bare?.[1]) {
    const value = Number(bare[1]);
    // 小于 10000 的裸数字按万元理解（客户不会说"预算 550 元"）
    if (value < 10_000) return Math.round(value * 10_000);
    return Math.round(value);
  }

  return null;
}

/**
 * 从文本中抽取三级预算。
 *
 * 这是本解析器最关键的部分。判断逻辑：
 *
 *   target（理想预算）—— 中性表述
 *     "预算550" "550左右" "550上下" "550万的样子" "550出头"
 *
 *   normalMax（常规上限）—— 上限表述 + 可接受语气
 *     "600以内也可以" "600封顶" "不超过600" "600以内" "最高600"
 *
 *   stretchMax（极限上限）—— **让步语气**，这是与 normalMax 的核心区别
 *     "特别好的600也能考虑" "真的合适贵点也行" "如果很好600也可以"
 *
 *   strictMax —— 明确拒绝超价
 *     "最多520" "520是上限" "超过520不看" "520以上不考虑"
 */
export function extractBudget(text: string): ExtractedBudget {
  const budget: ExtractedBudget = {
    target: null,
    normalMax: null,
    stretchMax: null,
    min: null,
    strictMax: false,
  };

  // ---- 1. 明确的上限表述 ----
  // "不超过600" "最多520" "600封顶" "600以内" "最高600" "预算不能超过600"
  const hardCapPatterns = [
    /(?:不超过|最多|最高|顶多|至多|上限(?:是)?)\s*(\d+(?:\.\d+)?\s*(?:万|w|亿)?)/i,
    /(\d+(?:\.\d+)?\s*(?:万|w|亿)?)\s*(?:封顶|以内|以下|内|是上限)/i,
  ];

  let capAmount: number | null = null;
  let capIsStrict = false;

  for (const pattern of hardCapPatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const amount = parseAmountToYuan(match[1]);
      if (amount !== null) {
        capAmount = amount;
        // "最多/不超过/上限/封顶" 这类说法本身就是强约束
        capIsStrict = /不超过|最多|上限|封顶|顶多|至多/.test(match[0]);
        break;
      }
    }
  }

  // "超过520不看" "520以上不考虑"
  const rejectPattern = /(?:超过|高于|以上)\s*(\d+(?:\.\d+)?\s*(?:万|w|亿)?)\s*(?:就)?\s*(?:不|免)(?:看|考虑|要)/;
  const rejectMatch = rejectPattern.exec(text);
  if (rejectMatch?.[1]) {
    const amount = parseAmountToYuan(rejectMatch[1]);
    if (amount !== null) {
      capAmount = amount;
      capIsStrict = true;
    }
  }

  // ---- 2. 让步语气的极限上限 ----
  // "特别好的600也能考虑" "真的合适贵点也行" "如果很好600也可以"
  const stretchPatterns = [
    /(?:特别好|特别合适|真的(?:很)?(?:合适|喜欢)|非常满意|实在(?:喜欢|合适))[^。；;]{0,12}?(\d+(?:\.\d+)?\s*(?:万|w|亿)?)\s*(?:也)?\s*(?:能|可以|可)?\s*(?:考虑|接受|行)/,
    /(\d+(?:\.\d+)?\s*(?:万|w|亿)?)[^。；;]{0,8}?(?:也)?\s*(?:能|可以)\s*(?:考虑|接受)/,
  ];

  let stretchAmount: number | null = null;
  for (const pattern of stretchPatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const amount = parseAmountToYuan(match[1]);
      if (amount !== null) {
        stretchAmount = amount;
        break;
      }
    }
  }

  // ---- 3. 中性/理想预算表述 ----
  const targetPatterns = [
    /预算(?:大概|大约|差不多)?\s*(?:是)?\s*(\d+(?:\.\d+)?\s*(?:万|w|亿)?)/i,
    /(\d+(?:\.\d+)?\s*(?:万|w|亿)?)\s*(?:左右|上下|的样子|差不多|出头|这样|附近)/i,
    /(?:想买|考虑|看|要)\s*(\d+(?:\.\d+)?\s*(?:万|w|亿)?)\s*(?:的|左右)?/i,
  ];

  let targetAmount: number | null = null;
  for (const pattern of targetPatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const amount = parseAmountToYuan(match[1]);
      if (amount !== null) {
        targetAmount = amount;
        break;
      }
    }
  }

  // ---- 4. "可以加一点" "550也行" 这类补充上限 ----
  // "500左右，550也行" → target=500, normalMax=550
  const alsoOkPattern = /(\d+(?:\.\d+)?\s*(?:万|w|亿)?)\s*(?:也|都)?\s*(?:行|可以|能接受|没问题|也可以)/;
  const alsoOkMatch = alsoOkPattern.exec(text);

  // "550也行" / "550也可以" 这类补充表达。
  // 单独出现时（"张江更好，550也可以"）它就是客户能接受的上限 → normalMax
  const extraAmount = alsoOkMatch?.[1] ? parseAmountToYuan(alsoOkMatch[1]) : null;

  // ---- 5. 组装三级预算 ----
  const allAmounts = [targetAmount, capAmount, stretchAmount, extraAmount]
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  if (stretchAmount !== null) {
    // 有明确的让步上限 → 它是 stretchMax，其余归入 target / normalMax
    budget.stretchMax = stretchAmount;
    const lower = allAmounts.filter((value) => value < stretchAmount);
    if (lower.length > 0) {
      budget.target = lower[0] ?? null;
      if (lower.length > 1) budget.normalMax = lower[lower.length - 1] ?? null;
    }
  } else if (capAmount !== null) {
    budget.normalMax = capAmount;
    if (targetAmount !== null && targetAmount < capAmount) budget.target = targetAmount;
  } else if (targetAmount !== null) {
    // 只有中性表述 → 它就是理想预算
    budget.target = targetAmount;
  }

  // "550也可以" 的补充上限处理。
  //
  // 两种情况：
  //   a) 已有理想预算，且补充值更高 → 它就是常规上限
  //      "500左右，550也行" → target=500, normalMax=550
  //   b) **没有**理想预算（客户只说"550也可以"）→ 它同样应作为上限
  //      "张江更好，550也可以" → normalMax=550
  //      （早期实现漏了情况 b，导致客户明确说了 550 却完全没有预算信息，
  //        进而使搜索条件里没有价格上限，推荐了一堆超预算的房源）
  if (extraAmount !== null && budget.stretchMax === null && budget.normalMax === null) {
    if (budget.target === null) {
      budget.normalMax = extraAmount;
    } else if (extraAmount > budget.target) {
      budget.normalMax = extraAmount;
    }
  }

  budget.strictMax = capIsStrict;

  // ---- 6. "可以加一点" 这类模糊让步 → 理想预算上浮 10% 作为常规上限 ----
  if (
    budget.target !== null &&
    budget.normalMax === null &&
    budget.stretchMax === null &&
    /可以(?:加|再高|多一点|多出)|稍微(?:加|高)/.test(text)
  ) {
    budget.normalMax = Math.round(budget.target * 1.1);
  }

  return budget;
}

/** 抽取卧室数要求 */
export function extractBedrooms(text: string): {
  preferred: number | null;
  strict: boolean;
  additive: boolean;
} {
  /**
   * 找出**所有**户型提及及其位置。
   *
   * 为什么需要位置：一句话里可能提到多个户型，且让步语气词只管**邻近**的那个。
   * 例如「三房最好，两房也可以」——"也可以"修饰的是 2 房，不是 3 房。
   * 旧实现只取第一个匹配（3），导致放宽语义被安到错误的数字上。
   */
  const pattern = /([一两二三四五六七八九十\d]{1,2})\s*(?:房|室|居室|居|个房间|间房)/g;

  const mentions: Array<{ value: number; index: number; length: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = parseCount(match[1] ?? '');
    if (value !== null) {
      mentions.push({ value, index: match.index, length: match[0].length });
    }
  }

  // 硬性要求："只要三房" "必须三房" "就要三房" "非三房不可" "只考虑三房"
  const strict = /(?:只要|必须要?|就要|只(?:要|考虑|看)|非[^。；;]{0,6}不可|必须是)/.test(text);

  /**
   * 判定哪个户型是"被放宽"的，优先选择它。
   *
   * 规则：
   *   1. 若某个户型**紧邻**让步语气词（如"两房也可以"）→ 取它
   *   2. 否则取**第一个**提到的户型（客户通常先说主要的）
   */
  const additiveMention = mentions.find((mention) => hasAdditiveModifierNear(text, mention));

  let preferred: number | null = null;
  if (additiveMention) {
    preferred = additiveMention.value;
  } else if (mentions.length > 0) {
    preferred = mentions[0]!.value;
  }

  return {
    preferred,
    strict,
    additive: additiveMention !== undefined && !strict,
  };
}

/**
 * 判断某个户型提及是否**紧邻**让步语气词。
 *
 * ============================================================================
 * 为什么必须按位置判断（踩过的真实 bug）
 * ============================================================================
 * 最初的实现用 `additiveWords.test(sentence)` 检测整句 ——
 * 结果「厦门湖里区三房，**400万左右**」被判成"放宽户型"，
 * 因为句中的"左右"属于**预算**而非户型，却匹配上了语气词正则。
 *
 * 修正做法：只在户型词**前后一小段窗口**内找让步词，
 * 且"左右/上下"这类模糊词必须**紧随**户型词（中间不能有"万"等单位）。
 */
function hasAdditiveModifierNear(
  text: string,
  mention: { index: number; length: number },
): boolean {
  /** 户型词之后 6 个字符（"两房也可以"的"也可以"在 2 字内，留余量） */
  const after = text.slice(mention.index + mention.length, mention.index + mention.length + 6);

  /** 户型词之前 4 个字符（"也可以两房"这种倒装） */
  const before = text.slice(Math.max(0, mention.index - 4), mention.index);

  // ---- 紧随其后的让步词 ----
  if (/^\s*(?:也|都|还)?\s*(?:可以|行|能接受|接受|没问题|可考虑)/.test(after)) return true;
  if (/^\s*(?:都可以|都行|均可)/.test(after)) return true;

  /**
   * 模糊范围："两房左右""三房上下"。
   *
   * ⚠️ 必须要求紧跟户型词，否则"400万左右"里的"左右"会被误判 ——
   *    那是预算范围，不是户型范围。
   */
  if (/^\s*(?:左右|上下|差不多)/.test(after)) return true;

  // ---- 前置的让步词（倒装："也可以考虑两房"）----
  if (/(?:也可以|也行|都能接受|都可以)\s*$/.test(before)) return true;

  // ---- 并列："两房三房都行" ----
  // 户型词后紧跟另一个户型词，且再后面有"都行/都可以"
  if (/^\s*[一两二三四五六七八九十\d]{1,2}\s*(?:房|室|居)/.test(after)) {
    const further = text.slice(mention.index, mention.index + 14);
    if (/(?:都|均)\s*(?:可以|行|能接受|接受)/.test(further)) return true;
  }

  return false;
}

/** 抽取面积范围 */
export function extractArea(text: string): { areaMin: number | null; areaMax: number | null } {
  // "100平左右" "100㎡" "100平米" "100多平" "90-110平" "100到120平"
  const range = /(\d{2,4})\s*(?:-|~|到|至)\s*(\d{2,4})\s*(?:平|㎡|平米|平方米)/.exec(text);
  if (range?.[1] && range[2]) {
    return { areaMin: Number(range[1]), areaMax: Number(range[2]) };
  }

  const about = /(\d{2,4})\s*(?:平|㎡|平米|平方米)\s*(?:左右|上下|的样子)/.exec(text);
  if (about?.[1]) {
    const base = Number(about[1]);
    return { areaMin: Math.round(base * 0.95), areaMax: Math.round(base * 1.05) };
  }

  const more = /(\d{2,4})\s*(?:多|来)\s*(?:平|㎡|平米|平方米)/.exec(text);
  if (more?.[1]) {
    const base = Number(more[1]);
    return { areaMin: base, areaMax: base + 30 };
  }

  const exact = /(\d{2,4})\s*(?:平|㎡|平米|平方米)/.exec(text);
  if (exact?.[1]) {
    const base = Number(exact[1]);
    // 小于 200 平才可能是住宅面积（避免把"500平"这种商铺面积误当住宅）
    if (base >= 20 && base <= 300) return { areaMin: null, areaMax: null };
  }

  return { areaMin: null, areaMax: null };
}

/** 抽取房龄偏好 */
export function extractBuildingAge(text: string): ExtractedBuildingAge {
  const result: ExtractedBuildingAge = {
    preference: BuildingAgePreference.ANY,
    avoidOld: false,
    builtAfterYear: null,
  };

  // 明确年份："2015年以后的" "2010年后建的"
  const yearMatch = /(19\d{2}|20\d{2})\s*年?\s*(?:以后|之后|后)/.exec(text);
  if (yearMatch?.[1]) {
    result.builtAfterYear = Number(yearMatch[1]);
    result.preference = BuildingAgePreference.NEWER;
    result.avoidOld = true;
    return result;
  }

  // 年限表述："5年内的房子" "10年以内"
  const withinMatch = /(\d{1,2})\s*年\s*(?:以内|内|之内的?)/.exec(text);
  if (withinMatch?.[1]) {
    const years = Number(withinMatch[1]);
    if (years <= 5) result.preference = BuildingAgePreference.WITHIN_5;
    else if (years <= 10) result.preference = BuildingAgePreference.WITHIN_10;
    else result.preference = BuildingAgePreference.WITHIN_20;
    result.avoidOld = true;
    return result;
  }

  // 模糊表述："新一点" "别太老" "不要老小区" "房龄不要太老" "次新房"
  if (/次新房|新房|全新的/.test(text)) {
    result.preference = BuildingAgePreference.NEWER;
    result.avoidOld = true;
    return result;
  }

  if (/(?:别|不要|不能|不太?)\s*(?:太)?\s*老|老小区|老破小|房龄.{0,4}(?:大|老|高)/.test(text)) {
    result.preference = BuildingAgePreference.NEWER;
    result.avoidOld = true;
    return result;
  }

  if (/新一点|新一些|新点|要新|偏新/.test(text)) {
    result.preference = BuildingAgePreference.NEWER;
    result.avoidOld = true;
    return result;
  }

  return result;
}

/** 抽取优先级（HIGH / MEDIUM / LOW / UNKNOWN） */
export function extractPriority(text: string, patterns: RegExp[]): PreferencePriority {
  for (const pattern of patterns) {
    if (pattern.test(text)) return PreferencePriority.HIGH;
  }
  return PreferencePriority.UNKNOWN;
}

/**
 * 规则解析主入口。
 *
 * @param messageText 客户微信消息原文
 * @param hint 可选的提示信息（如已知客户所在城市）
 */
export function parseRequirementByRules(
  messageText: string,
  hint: { city?: string | null; knownDistricts?: string[] } = {},
): RequirementExtraction {
  const text = messageText;
  const budget = extractBudget(text);
  const bedrooms = extractBedrooms(text);
  const area = extractArea(text);
  const buildingAge = extractBuildingAge(text);

  // ---- 城市与区域 ----
  // 城市来源区分两种情况：
  //   1. hint.city：来自客户已有的画像/资料（最可信，是之前确认过的）
  //   2. 从消息里识别：可能是客户明说，也可能是由唯一归属的区域推断
  const cityDetection = extractCityWithSource(text);
  const city = hint.city ?? cityDetection.city;
  const citySource: RequirementExtraction['citySource'] = hint.city
    ? 'explicit'
    : cityDetection.source;

  const { districts, subDistricts, communities } = extractLocations(text, city);

  // ---- 楼层 ----
  const avoidFirstFloor = /(?:不要|别|不考虑|排除)\s*(?:第)?一?楼(?:层)?/.test(text);
  const avoidTopFloor = /(?:不要|别|不考虑|排除)\s*(?:顶楼|顶层|最高层)|(?:不要|别)\s*顶/.test(text);

  let floorPreference = RequirementFloorPreference.ANY;
  if (/中高楼层|中高层/.test(text)) floorPreference = RequirementFloorPreference.MIDDLE_HIGH;
  else if (/高楼层|要高点|楼层高/.test(text)) floorPreference = RequirementFloorPreference.HIGH;
  else if (/低楼层|要低点/.test(text)) floorPreference = RequirementFloorPreference.LOW;
  else if (/中间楼层|中层/.test(text)) floorPreference = RequirementFloorPreference.MIDDLE;

  if (avoidFirstFloor && avoidTopFloor) {
    // 既不要一楼也不要顶楼 → 中间楼层
    floorPreference = RequirementFloorPreference.MIDDLE;
  }

  // ---- 学区 ----
  const schoolNotNeeded = /学区(?:无所谓|不重要|不用|不考虑|没要求)|不需要学区|不看重学区/.test(text);
  const schoolRequired = !schoolNotNeeded && /(?:一定|必须|要求|要|看重|考虑)\s*(?:要)?\s*学区|学区房|对口|学位/.test(text);

  // ---- 交通 ----
  // "走路十分钟" → 800 米（按 80 米/分钟估算）
  const walkMatch = /(?:走路|步行|走)\s*(\d{1,2})\s*分钟/.exec(text);
  let subwayDistanceMax: number | null = null;
  if (walkMatch?.[1]) {
    subwayDistanceMax = Number(walkMatch[1]) * 80;
  } else {
    const meterMatch = /(\d{3,4})\s*米(?:以内)?/.exec(text);
    if (meterMatch?.[1] && /地铁|交通|走路|步行/.test(text)) {
      subwayDistanceMax = Number(meterMatch[1]);
    }
  }

  // 地铁优先级。
  //
  // 覆盖的表达（含语序变化）：
  //   "离地铁近点" "离地铁最好也别太远" "地铁方便" "地铁要近" "走路十分钟" "通勤方便"
  // 注意 "别也" 这种语序很常见（"最好也别太远"），因此把可选的语气词
  // 做成一个宽松的中间段，而不是逐个列举固定搭配。
  const subway = extractPriority(text, [
    /(?:离|距)?地铁[^。；;，,]{0,10}(?:远|近|方便|方便点)/,
    /地铁(?:要|得|必须)?[^。；;，,]{0,6}(?:近|方便)/,
    /(?:离|距)?地铁.{0,4}别太远/,
    // "走路十分钟" "走路10分钟到地铁" —— 数字前后都可能出现"到地铁"，因此放宽
    /走路\s*(?:\d{1,2}|[一二三四五六七八九十]+)\s*分钟/,
    /步行\s*(?:\d{1,2}|[一二三四五六七八九十]+)\s*分钟/,
    /通勤/,
  ]);

  // ---- 其它维度 ----
  const communityQuality = extractPriority(text, [
    /小区(?:环境|品质|管理)(?:要|比较|很)?(?:好|在意|重要)|环境(?:好|在意)|物业(?:好|要)/,
    /老婆|太太|妻子|爱人|家里人|家人/.test(text) && /环境|小区/.test(text) ? /./ : /(?!)/,
  ]);

  const decoration = extractPriority(text, [/装修(?:要|必须|在意|看重)|精装|豪装/]);
  const orientation = extractPriority(text, [/朝南|南北通透|朝向(?:要|在意)/]);
  const floor = extractPriority(text, [/楼层(?:要|在意|看重)/]);

  let decorationPreference = DecorationPreferenceLevel.ANY;
  if (/装修(?:无所谓|不重要|没要求|不考虑)/.test(text)) decorationPreference = DecorationPreferenceLevel.ANY;
  else if (/豪装|豪华装修/.test(text)) decorationPreference = DecorationPreferenceLevel.LUXURY;
  else if (/必须精装|要精装|精装修|精装/.test(text)) decorationPreference = DecorationPreferenceLevel.FINE;
  else if (/简装|简单装修/.test(text)) decorationPreference = DecorationPreferenceLevel.SIMPLE;
  else if (/毛坯|清水/.test(text)) decorationPreference = DecorationPreferenceLevel.ROUGH;

  const requireFineDecoration = /必须精装|一定要精装/.test(text);

  // ---- 电梯 ----
  const requireElevator = /(?:必须|要|一定(?:要)?)\s*(?:有)?电梯|电梯房|带电梯/.test(text);

  // ---- 决策参与者 ----
  const decisionMakers: DecisionMaker[] = [DecisionMaker.SELF];
  if (/老婆|太太|妻子|爱人|媳妇|老公|丈夫|先生/.test(text)) decisionMakers.push(DecisionMaker.SPOUSE);
  if (/父母|爸妈|老人|父亲|母亲/.test(text)) decisionMakers.push(DecisionMaker.PARENTS);
  if (/孩子|小孩|儿子|女儿|上学/.test(text)) decisionMakers.push(DecisionMaker.CHILD);

  // ---- 家庭关注点（保留客户原话，这是最有价值的信息）----
  const familyConcerns: string[] = [];
  const concernPatterns = [
    /(?:我)?(?:老婆|太太|妻子|爱人|老公|丈夫|父母|家人|孩子|小孩)[^。；;，,]{0,20}(?:在意|看重|喜欢|希望|要求|觉得)[^。；;]{0,20}/g,
  ];
  for (const pattern of concernPatterns) {
    const matches = text.match(pattern);
    if (matches) familyConcerns.push(...matches.map((item) => item.trim()));
  }

  // ---- 覆盖语义 ----
  const overrideFields: string[] = [];
  const hasOverrideWord = /现在|改成|改为|不要了|不考虑了|只考虑|以后|重新|算了/;
  if (hasOverrideWord.test(text)) {
    if (bedrooms.preferred !== null) overrideFields.push('bedrooms');
    if (budget.strictMax || budget.normalMax !== null) overrideFields.push('budget');
    if (schoolNotNeeded) overrideFields.push('schoolNotNeeded');
    if (districts.length > 0) overrideFields.push('districts');
  }

  // ---- 缺失关键字段 ----
  const missingCriticalFields: string[] = [];
  if (!city) missingCriticalFields.push('city');
  if (districts.length === 0 && subDistricts.length === 0 && communities.length === 0) {
    missingCriticalFields.push('districts');
  }

  // ---- 置信度 ----
  // 规则解析对模式化表达很可靠，但对模糊表达无能为力，因此置信度按信息量给
  let confidence = 0.5;
  const signalCount = [
    budget.target !== null || budget.normalMax !== null || budget.stretchMax !== null,
    bedrooms.preferred !== null,
    districts.length > 0 || subDistricts.length > 0,
    area.areaMin !== null || area.areaMax !== null,
    buildingAge.avoidOld,
    subwayDistanceMax !== null,
    schoolRequired || schoolNotNeeded,
  ].filter(Boolean).length;

  confidence = Math.min(0.9, 0.4 + signalCount * 0.1);
  if (text.length < 6) confidence = 0.2;

  // ---- 摘要 ----
  const summaryParts: string[] = [];
  if (city) summaryParts.push(city);
  if (subDistricts.length > 0) summaryParts.push(subDistricts.join('、'));
  else if (districts.length > 0) summaryParts.push(districts.join('、'));
  if (bedrooms.preferred !== null) summaryParts.push(`${bedrooms.preferred}房`);
  if (budget.target !== null) summaryParts.push(`理想${Math.round(budget.target / 10_000)}万`);
  if (budget.normalMax !== null) summaryParts.push(`最高${Math.round(budget.normalMax / 10_000)}万`);
  if (budget.stretchMax !== null) summaryParts.push(`极限${Math.round(budget.stretchMax / 10_000)}万`);
  if (buildingAge.avoidOld) summaryParts.push('偏好较新小区');
  if (subwayDistanceMax !== null) summaryParts.push(`地铁${subwayDistanceMax}米内`);

  return {
    city,
    districts,
    subDistricts,
    communities,
    bedrooms,
    budget,
    buildingAge,
    areaMin: area.areaMin,
    areaMax: area.areaMax,
    communityQuality,
    subway,
    school: schoolRequired ? PreferencePriority.HIGH : PreferencePriority.UNKNOWN,
    decoration,
    orientation,
    floor,
    floorPreference,
    decorationPreference,
    requireFineDecoration,
    avoidFirstFloor,
    avoidTopFloor,
    requireElevator,
    schoolRequired,
    schoolNotNeeded,
    schoolNote: null,
    subwayDistanceMax,
    commuteLocations: [],
    carConvenience: /开车(?:方便|为主)|自驾/.test(text),
    purchasePurpose: /投资/.test(text)
      ? '投资'
      : /改善/.test(text)
        ? '改善'
        : /学区/.test(text)
          ? '学区'
          : /自住|自己住/.test(text)
            ? '自住'
            : null,
    paymentMethod: /全款/.test(text) ? '全款' : /公积金/.test(text) ? '公积金' : /贷款|按揭/.test(text) ? '商贷' : null,
    purchaseTimeline: /(?:今年|年内|马上|尽快|着急)/.test(text)
      ? '急'
      : /(?:明年|不急|慢慢看)/.test(text)
        ? '不急'
        : null,
    decisionMakers: [...new Set(decisionMakers)],
    familyConcerns,
    otherRequirements: [],
    overrideFields,
    confidence,
    missingCriticalFields,
    summary: summaryParts.length > 0 ? `${summaryParts.join('，')}。` : '客户需求暂不明确。',
    citySource,
    cityInferredFrom: hint.city ? null : cityDetection.inferredFrom,
  };
}

// ---------------------------------------------------------------------------
// 城市与区域识别
// ---------------------------------------------------------------------------

/** 常见城市（房产语境下的主要城市） */
const KNOWN_CITIES = [
  '上海',
  '北京',
  '深圳',
  '广州',
  '杭州',
  '南京',
  '苏州',
  '成都',
  '重庆',
  '武汉',
  '西安',
  '天津',
  '长沙',
  '青岛',
  '宁波',
  '无锡',
  '厦门',
  '福州',
  '合肥',
  '济南',
  '郑州',
  '东莞',
  '佛山',
];

/**
 * 行政区 → 所属城市 的映射（仅收录**唯一归属**的强特征地名）。
 *
 * 用途：客户说"浦东三房"时，虽然没说"上海"，但"浦东"唯一指向上海。
 * 这是**确定的映射关系**，不是猜测 —— 与"AI 猜城市"有本质区别：
 *   - 猜测：模型根据"经纪人在上海"推断客户想要上海 → 可能是错的
 *   - 映射：浦东只可能在上海 → 不可能有歧义
 *
 * 因此这里允许推断，但**必须在结果中标注这是推断**，
 * 让经纪人有机会纠正（前端会显示"城市按浦东推断为上海"）。
 *
 * 刻意只收录强特征词：像"新区""高新区"这类多个城市都有的名字绝不收录。
 */
const DISTRICT_TO_CITY: Record<string, string> = {
  // 上海
  浦东: '上海',
  浦东新区: '上海',
  陆家嘴: '上海',
  张江: '上海',
  金桥: '上海',
  外高桥: '上海',
  徐家汇: '上海',
  新天地: '上海',
  静安: '上海',
  黄浦: '上海',
  徐汇: '上海',
  长宁: '上海',
  普陀: '上海',
  虹口: '上海',
  杨浦: '上海',
  闵行: '上海',
  宝山: '上海',
  嘉定: '上海',
  松江: '上海',
  青浦: '上海',
  奉贤: '上海',
  崇明: '上海',
  大宁: '上海',
  五角场: '上海',
  新江湾城: '上海',
  七宝: '上海',
  莘庄: '上海',
  古美: '上海',
  中山公园: '上海',
  北外滩: '上海',

  // ---- 厦门（用户主战场，优先覆盖）----
  // 行政区：思明/湖里为岛内，集美/海沧/同安/翔安为岛外
  思明: '厦门',
  湖里: '厦门',
  集美: '厦门',
  海沧: '厦门',
  同安: '厦门',
  翔安: '厦门',
  // 岛内核心板块与商圈
  莲前: '厦门',
  禾祥: '厦门',
  文灶: '厦门',
  厦大: '厦门',
  曾厝垵: '厦门',
  前埔: '厦门',
  五缘湾: '厦门',
  钟宅: '厦门',
  枋湖: '厦门',
  江头: '厦门',
  松柏: '厦门',
  槟榔: '厦门',
  湖滨: '厦门',
  轮渡: '厦门',
  筼筜: '厦门',
  云顶: '厦门',
  观音山: '厦门',
  软件园: '厦门',
  高崎: '厦门',
  殿前: '厦门',
  东渡: '厦门',
  海天: '厦门',
  灌口: '厦门',
  杏林: '厦门',
  集美学村: '厦门',
  马巷: '厦门',
  鼓浪屿: '厦门',

  // ---- 福建其他城市（用户可能涉及）----
  // ⚠️ 刻意不收录"鼓楼"（南京也有）、"台江"（易与浙江台州混淆）、
  //    "金山"（上海也有）这类多城市共有的名称 —— 歧义映射会把客户需求导错城市。
  仓山: '福州',
  晋安: '福州',
  马尾: '福州',
  长乐: '福州',
  闽侯: '福州',
  五四北: '福州',

  丰泽: '泉州',
  鲤城: '泉州',
  洛江: '泉州',
  泉港: '泉州',
  晋江: '泉州',
  石狮: '泉州',
  南安: '泉州',
  惠安: '泉州',

  芗城: '漳州',
  龙文: '漳州',
  龙海: '漳州',
  角美: '漳州',

  // 北京
  朝阳: '北京',
  海淀: '北京',
  西城: '北京',
  东城: '北京',
  丰台: '北京',
  石景山: '北京',
  通州: '北京',
  昌平: '北京',
  大兴: '北京',
  望京: '北京',
  中关村: '北京',
  国贸: '北京',
  亦庄: '北京',
  回龙观: '北京',
  天通苑: '北京',
  // 深圳
  南山: '深圳',
  福田: '深圳',
  罗湖: '深圳',
  宝安: '深圳',
  龙岗: '深圳',
  龙华: '深圳',
  坪山: '深圳',
  光明: '深圳',
  盐田: '深圳',
  前海: '深圳',
  后海: '深圳',
  // 广州
  天河: '广州',
  越秀: '广州',
  海珠: '广州',
  荔湾: '广州',
  白云: '广州',
  番禺: '广州',
  黄埔: '广州',
  花都: '广州',
  南沙: '广州',
  增城: '广州',
  珠江新城: '广州',
  // 杭州
  西湖: '杭州',
  拱墅: '杭州',
  滨江: '杭州',
  萧山: '杭州',
  余杭: '杭州',
  钱塘: '杭州',
  临平: '杭州',
  未来科技城: '杭州',
  // 成都
  锦江: '成都',
  青羊: '成都',
  金牛: '成都',
  武侯: '成都',
  成华: '成都',
  高新: '成都',
  天府新区: '成都',
  // 南京
  鼓楼: '南京',
  玄武: '南京',
  秦淮: '南京',
  建邺: '南京',
  栖霞: '南京',
  江宁: '南京',
  雨花台: '南京',
  // 武汉
  江岸: '武汉',
  江汉: '武汉',
  硚口: '武汉',
  汉阳: '武汉',
  武昌: '武汉',
  洪山: '武汉',
  光谷: '武汉',
  // 西安
  雁塔: '西安',
  碑林: '西安',
  莲湖: '西安',
  新城: '西安',
  未央: '西安',
  曲江: '西安',
  // 苏州
  姑苏: '苏州',
  吴中: '苏州',
  相城: '苏州',
  吴江: '苏州',
  工业园区: '苏州',
  // 天津
  和平: '天津',
  河西: '天津',
  南开: '天津',
  河东: '天津',
  河北: '天津',
  红桥: '天津',
  滨海新区: '天津',
};

/**
 * 从文本中推断城市（含"区域 → 城市"的确定映射）。
 *
 * 返回值区分「客户明说」与「由区域推断」两种情况，
 * 因为两者的可信度不同，界面上要区别对待。
 */
export function extractCityWithSource(text: string): {
  city: string | null;
  /** explicit = 客户明确说了城市；inferred = 由唯一归属的区域推断 */
  source: 'explicit' | 'inferred' | 'none';
  /** 推断依据（供界面提示） */
  inferredFrom: string | null;
} {
  // 1. 客户明确说了城市名
  for (const city of KNOWN_CITIES) {
    if (text.includes(city)) {
      return { city, source: 'explicit', inferredFrom: null };
    }
  }

  // 2. 由唯一归属的区域推断
  //    注意按名称长度降序匹配，优先匹配更具体的地名（"浦东新区" 优于 "浦东"）
  const candidates = Object.keys(DISTRICT_TO_CITY).sort((a, b) => b.length - a.length);

  for (const district of candidates) {
    if (text.includes(district)) {
      const city = DISTRICT_TO_CITY[district];
      if (city) {
        return { city, source: 'inferred', inferredFrom: district };
      }
    }
  }

  // 3. 由多城市地址库推断（覆盖厦门/福州/泉州/漳州等非上海城市）
  //
  // 这张表**已自动排除跨城市重名的地名**（见 city-locations.ts），
  // 因此命中即可安全推断，不会把"金山"猜成上海或厦门。
  //
  // 同样按长度降序，优先匹配更具体的地名（"五缘湾" 优于 "五缘"）。
  const subDistrictCandidates = [...CITY_BY_SUB_DISTRICT.keys()].sort(
    (a, b) => b.length - a.length,
  );
  for (const sub of subDistrictCandidates) {
    if (text.includes(sub)) {
      const city = CITY_BY_SUB_DISTRICT.get(sub);
      if (city) {
        return { city, source: 'inferred', inferredFrom: sub };
      }
    }
  }

  const districtCandidates = [...CITY_BY_DISTRICT.keys()].sort((a, b) => b.length - a.length);
  for (const district of districtCandidates) {
    if (text.includes(district)) {
      const city = CITY_BY_DISTRICT.get(district);
      if (city) {
        return { city, source: 'inferred', inferredFrom: district };
      }
    }
  }

  return { city: null, source: 'none', inferredFrom: null };
}

/** 上海行政区与常见板块（本项目 Demo 数据以上海为主） */
const SHANGHAI_DISTRICTS = [
  '浦东新区',
  '徐汇区',
  '静安区',
  '黄浦区',
  '长宁区',
  '普陀区',
  '虹口区',
  '杨浦区',
  '闵行区',
  '宝山区',
  '嘉定区',
  '金山区',
  '松江区',
  '青浦区',
  '奉贤区',
  '崇明区',
];

/** 常见板块（用于识别"张江""金桥"这类非行政区的地名） */
const KNOWN_SUB_DISTRICTS = [
  '张江',
  '金桥',
  '陆家嘴',
  '外高桥',
  '三林',
  '康桥',
  '周浦',
  '唐镇',
  '曹路',
  '高行',
  '金杨',
  '洋泾',
  '花木',
  '北蔡',
  '川沙',
  '惠南',
  '临港',
  '徐家汇',
  '田林',
  '漕河泾',
  '古美',
  '七宝',
  '莘庄',
  '春申',
  '虹桥',
  '中山公园',
  '天山',
  '长寿路',
  '曹杨',
  '真如',
  '大宁',
  '彭浦',
  '不夜城',
  '五角场',
  '新江湾城',
  '中原',
  '控江路',
  '曲阳',
  '凉城',
  '四川北路',
  '北外滩',
  '打浦桥',
  '五里桥',
  '世博',
];

/** 识别城市（仅认客户明确说出的城市名） */
export function extractCity(text: string): string | null {
  return extractCityWithSource(text).city;
}

/**
 * 识别区域。
 *
 * 区分行政区（浦东新区）与板块（张江），因为：
 *   - 行政区可以进硬筛（贝壳返回的 district 是行政区）
 *   - 板块是更细的位置偏好，进打分（贝壳返回的 subDistrict 是板块）
 *
 * 关键实现细节（踩过的坑）：
 *   客户说"浦东三房"时，"浦东"是**行政区简称**，必须识别为 district。
 *   早期实现只在 subDistricts 列表里找，而该列表没有"浦东"，
 *   结果区域完全丢失 —— 客户明确说了区域，系统却当成没要求。
 */
export function extractLocations(
  text: string,
  cityHint?: string | null,
): {
  districts: string[];
  subDistricts: string[];
  communities: string[];
} {
  const districts: string[] = [];
  const subDistricts: string[] = [];

  // ---- 0. 城市档案路径（非上海城市）----
  //
  // 策略说明：上海那条路径（下面的 SHANGHAI_DISTRICTS + 别名表）
  // 是**已经验证过的**，本项目大量历史数据与测试都基于它。
  // 因此这里**不改动上海逻辑**，只对其它城市走地址库路径，
  // 避免为了支持多城市而把已验证的行为改坏。
  //
  // 未指定城市时也走地址库兜底（第 5 步），这样"五缘湾三房"
  // 即使没提"厦门"也能识别出板块。
  const profile = getCityProfile(cityHint);
  if (profile && profile.city !== '上海') {
    extractFromProfile(text, profile, districts, subDistricts);

    return {
      districts: [...new Set(districts)],
      subDistricts: [...new Set(subDistricts)],
      communities: [],
    };
  }

  // ---- 1. 行政区：支持简称（客户很少说全称"浦东新区"）----
  for (const district of SHANGHAI_DISTRICTS) {
    const short = district.replace(/[区县]$/, '');
    if (text.includes(district) || text.includes(short)) {
      districts.push(district);
    }
  }

  // ---- 2. 常见行政区别名 ----
  // 有些地名的正式名与客户口语差异大，需要单独映射
  const districtAliases: Record<string, string> = {
    浦东: '浦东新区',
    陆家嘴: '浦东新区',
    张江: '浦东新区',
    金桥: '浦东新区',
    外高桥: '浦东新区',
    三林: '浦东新区',
    康桥: '浦东新区',
    周浦: '浦东新区',
    唐镇: '浦东新区',
    曹路: '浦东新区',
    高行: '浦东新区',
    金杨: '浦东新区',
    洋泾: '浦东新区',
    花木: '浦东新区',
    北蔡: '浦东新区',
    川沙: '浦东新区',
    惠南: '浦东新区',
    临港: '浦东新区',
    徐家汇: '徐汇区',
    田林: '徐汇区',
    漕河泾: '徐汇区',
    古美: '闵行区',
    七宝: '闵行区',
    莘庄: '闵行区',
    春申: '闵行区',
    大宁: '静安区',
    彭浦: '静安区',
    不夜城: '静安区',
    五角场: '杨浦区',
    新江湾城: '杨浦区',
    中原: '杨浦区',
    控江路: '杨浦区',
    虹桥: '长宁区',
    中山公园: '长宁区',
    天山: '长宁区',
    长寿路: '普陀区',
    曹杨: '普陀区',
    真如: '普陀区',
    曲阳: '虹口区',
    凉城: '虹口区',
    四川北路: '虹口区',
    北外滩: '虹口区',
  };

  for (const [alias, district] of Object.entries(districtAliases)) {
    if (text.includes(alias) && !districts.includes(district)) {
      districts.push(district);
    }
  }

  // ---- 3. 板块（更细的位置偏好）----
  for (const sub of KNOWN_SUB_DISTRICTS) {
    if (text.includes(sub)) subDistricts.push(sub);
  }

  // ---- 4. "XX附近/周边/一带/板块" 形式的地名 ----
  const nearbyPattern = /([\u4e00-\u9fff]{2,6}?)(?:附近|周边|一带|板块)/g;
  let match: RegExpExecArray | null;
  while ((match = nearbyPattern.exec(text)) !== null) {
    let name = match[1];
    if (!name) continue;

    // 去掉动词前缀："还是想看张江附近" → "张江"
    name = name.replace(/^(?:还是|就|想|要|看|想买|考虑|在)+/u, '').trim();

    // 排除非地名
    if (name.length < 2) continue;
    if (/^(?:房子|房源|小区|这|那|附近|周边|这个|那个)/.test(name)) continue;

    // 已在列表中则跳过
    if (subDistricts.includes(name)) continue;

    // 如果它其实是个行政区，不应重复进板块
    const matchedDistrict = districts.find(
      (district) => district.includes(name) || name.includes(district.replace(/[区县]$/, '')),
    );
    if (matchedDistrict) continue;

    subDistricts.push(name);
  }

  // ---- 5. 多城市地址库兜底 ----
  //
  // 走到这里说明没有指定城市（或指定的是上海）。
  // 用地址库再扫一遍，这样"五缘湾三房"这类只提板块、
  // 没提城市与行政区的表达也能识别出板块。
  //
  // ⚠️ 只补充**尚未出现**的地名，不覆盖上面上海路径的结果。
  for (const profile of CITY_LOCATION_PROFILES) {
    if (profile.city === '上海') continue; // 上海已由上面处理

    // 只有在消息里出现该城市的强特征地名时才补充，
    // 避免把无关城市的地名误加进来
    const mentioned = [...profile.districts, ...profile.subDistricts].some((name) =>
      text.includes(name),
    );
    if (!mentioned) continue;

    extractFromProfile(text, profile, districts, subDistricts);
  }

  return {
    districts: [...new Set(districts)],
    subDistricts: [...new Set(subDistricts)],
    communities: [],
  };
}

/**
 * 从城市档案里抽取行政区与板块。
 *
 * 抽两个东西：
 *   - 行政区（进硬筛：贝壳返回的 district 是行政区）
 *   - 板块（进打分：更细的位置偏好）
 *
 * 并且会把"只说了板块"的情况**补全所属行政区** ——
 * 因为硬筛用的是行政区，只识别出板块会导致区域过滤失效。
 */
function extractFromProfile(
  text: string,
  profile: CityLocationProfile,
  districts: string[],
  subDistricts: string[],
): void {
  // 区域俗称（如厦门的"岛内"→ 思明+湖里）
  // 优先处理：它的粒度比单个区粗，但比"没有区域"精确得多
  if (profile.regionAliases) {
    // 按长度降序，"厦门岛内" 优先于 "岛内"
    const aliases = Object.keys(profile.regionAliases).sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      if (!text.includes(alias)) continue;

      for (const district of profile.regionAliases[alias] ?? []) {
        if (!districts.includes(district)) districts.push(district);
      }
    }
  }

  // 行政区（支持带"区/县/市"的全称与去掉后缀的简称）
  for (const district of profile.districts) {
    const short = district.replace(/[区县市]$/, '');
    if (text.includes(district) || (short.length >= 2 && text.includes(short))) {
      if (!districts.includes(district)) districts.push(district);
    }
  }

  // 板块：按名称长度降序，优先匹配更具体的（"杏林湾" 优于 "杏林"）
  const sorted = [...profile.subDistricts].sort((a, b) => b.length - a.length);
  for (const sub of sorted) {
    if (!text.includes(sub)) continue;
    if (subDistricts.includes(sub)) continue;

    subDistricts.push(sub);

    // 补全所属行政区（硬筛需要）
    const owner = profile.subDistrictToDistrict[sub];
    if (owner && !districts.includes(owner)) {
      districts.push(owner);
    }
  }
}

/**
 * 支持的城市列表。
 *
 * 为什么要显式列出：贝壳的接口**必须**有城市参数（否则报 city_id is required），
 * 而规则解析器不会猜城市（猜错会让系统去搜完全错误的房源）。
 * 因此当客户消息里没有城市时，我们要能告诉经纪人"请从这些城市里选一个"。
 */
export const SUPPORTED_CITIES = KNOWN_CITIES;

/** 判断某个城市是否受支持 */
export function isSupportedCity(city: string): boolean {
  return KNOWN_CITIES.includes(city);
}
