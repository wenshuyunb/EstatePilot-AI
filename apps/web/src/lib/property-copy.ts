/**
 * 房源信息格式化 —— 生成可复制的完整房源文本。
 *
 * ============================================================================
 * 产品要求
 * ============================================================================
 * 经纪人在房源卡片上点"复制"后，得到**排版正确、信息完整**的文本，
 * 可以直接粘贴到微信发给客户 —— **不需要跳转贝壳 App**。
 *
 * ============================================================================
 * 设计要点
 * ============================================================================
 *   1. **纯文本排版**：微信不支持富文本，因此只能用换行、分隔线与符号
 *   2. **信息完整**：优先用贝壳完整详情（19 项房屋 + 20 项小区 + 周边配套）；
 *      拿不到详情时降级用列表摘要，**并明确标注缺详情**
 *   3. **绝不编造**：没有的字段整行不输出，而不是写"暂无"
 *      （发客户的文案里出现"暂无数据"很不专业）
 *   4. **微信友好**：段落间空行、关键信息用「」或 · 分隔，手机上易读
 */

import type { PropertyFullDetail, NearbyFacility } from '@/lib/queries/use-wechat-assistant';

/**
 * 复制用的房源数据（来自推荐卡片的 DTO + 可选完整详情）。
 *
 * ⚠️ 数值字段类型写成 `number | string` 而**不是** `number`：
 *    后端的 `Decimal`/`BigInt` 经 JSON 序列化后是**字符串**，
 *    声明成 `number` 会诱导调用方直接做算术运算，从而在运行时崩溃
 *    （踩过：`area.toFixed is not a function`）。
 *    声明成联合类型能强制调用方先归一化。
 */
export interface PropertyCopyInput {
  community: string;
  city: string;
  district: string;
  subDistrict: string | null;
  title: string;
  totalPrice: number | string;
  unitPrice: number | string;
  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: number | string;
  floor: number | null;
  totalFloors: number | null;
  buildYear: number | null;
  decoration: string | null;
  orientation: string | null;
  subwayDistance: number | string | null;
  schoolText: string | null;
  tags: string[];
  listingStatus: string;
  /** 数据可信度说明（实时/缓存） */
  reliabilityNote?: string;
  /** 完整详情（有则输出小区与周边配套） */
  fullDetail?: PropertyFullDetail | null;
}

/**
 * 数值归一化。
 *
 * ============================================================================
 * ⚠️ 为什么必须做（线上"复制失败"事故）
 * ============================================================================
 * 事故现象：点复制按钮提示"复制失败（area.toFixed is not a function）"。
 *
 * 根因：**后端的 Decimal/BigInt 经 JSON 序列化后变成字符串**，
 *      而前端的 TS 类型把它们声明成了 `number` ——
 *      类型声明与运行时实际不符，于是 `toFixed` 在字符串上崩了。
 *
 * 这与后端那个 `Math.abs(BigInt)` 的 500 事故**同源**：
 * 都是"跨层类型契约不一致"。区别只是这次发生在 JSON 边界。
 *
 * 因此所有数值格式化都必须先归一化，不能信任传入类型。
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

/**
 * 对外暴露的数值归一化。
 *
 * 为什么导出：卡片组件也需要它（总价、单价、面积都是字符串形态的数值），
 * 而**两处各写一份必然会产生分歧** —— 这个 bug 已经因为"跨层类型不一致"
 * 出现过两次，不该在同一个文件里再制造第三个不一致点。
 */
export { toNumber as normalizeNumber };

/** 万元格式化：整数不带小数 */
function wan(amount: unknown): string {
  const value = toNumber(amount) / 10_000;
  return Number.isInteger(value) ? `${value}万` : `${value.toFixed(1)}万`;
}

/** 面积：去掉多余小数 */
function squareMeters(area: unknown): string {
  const value = toNumber(area);
  return Number.isInteger(value) ? `${value}㎡` : `${value.toFixed(1)}㎡`;
}

/** 距离：米 → 米/公里 */
function distance(meters: unknown): string {
  const value = toNumber(meters);
  return value < 1000 ? `${value}米` : `${(value / 1000).toFixed(1)}公里`;
}

/** 千分位单价 */
function perSquareMeter(unitPrice: unknown): string {
  return `${Math.round(toNumber(unitPrice)).toLocaleString('zh-CN')}元/㎡`;
}

/**
 * 把"总楼层+所在楼层"合并成一句人话。
 *
 * 贝壳返回的是"低楼层/30层"或数字。两种都要兼容。
 */
function floorText(input: PropertyCopyInput): string | null {
  if (input.floor === null && input.totalFloors === null) return null;
  if (input.floor !== null && input.totalFloors !== null) {
    return `${input.floor}层 / 共${input.totalFloors}层`;
  }
  return input.floor !== null ? `${input.floor}层` : `共${input.totalFloors}层`;
}

/**
 * 生成可复制的完整房源文本。
 *
 * 输出结构（有则输出，无则整段省略）：
 *
 *   【小区名】3室2厅 · 105㎡ · 178万
 *
 *   ■ 基本信息
 *   单价：16,943元/㎡
 *   ...
 *
 *   ■ 小区信息
 *   ...
 *
 *   ■ 周边配套
 *   🚇 地铁：园博苑（1.1公里）
 *   ...
 */
export function formatPropertyForCopy(input: PropertyCopyInput): string {
  const blocks: string[] = [];

  // ========================================================================
  // 标题行：小区 + 户型 + 面积 + 总价（一眼能看全的核心信息）
  // ========================================================================
  const layout = `${input.bedrooms}室${input.livingRooms > 0 ? `${input.livingRooms}厅` : ''}${
    input.bathrooms > 0 ? `${input.bathrooms}卫` : ''
  }`;

  blocks.push(
    `【${input.community}】${layout} · ${squareMeters(input.area)} · ${wan(input.totalPrice)}`,
  );

  // 位置
  const location = [input.city, input.district, input.subDistrict].filter(Boolean).join(' ');
  if (location.length > 0) blocks.push(location);

  // ========================================================================
  // 基本信息
  // ========================================================================
  const base: string[] = [];

  const detail = input.fullDetail;

  // 优先用详情的单价文本（贝壳原文，含千分位），否则自己算
  if (detail?.base?.unitPrice) {
    base.push(`单价：${detail.base.unitPrice}`);
  } else if (toNumber(input.unitPrice) > 0) {
    base.push(`单价：${perSquareMeter(input.unitPrice)}`);
  }

  /**
   * 楼层。
   *
   * ⚠️ 优先用**详情**里的值（后端已把数字与"中楼层"这类相对描述整理好），
   *    只有没有详情时才回退到列表摘要的 `floor`/`totalFloors`。
   *
   * 踩过的坑：原先只用 `input.floor`，而该字段在多数房源上是 null
   * （实测覆盖率仅 40%），导致"贝壳限流时复制出来的信息非常简短"。
   */
  const floorValue = detail?.base?.floor ?? floorText(input);
  if (floorValue) base.push(`楼层：${floorValue}`);

  if (input.orientation) base.push(`朝向：${input.orientation}`);

  /**
   * 装修。
   *
   * ⚠️ 详情优先：后端会把从 `description` 反解出的装修放进
   *    `detail.base.decoration`（贝壳搜索结果不返回"装修类型"，
   *    数据库该列实测覆盖率为 0）。
   */
  const decorationValue = detail?.base?.decoration ?? input.decoration;
  if (decorationValue) base.push(`装修：${decorationValue}`);

  if (input.buildYear !== null) base.push(`建成年份：${input.buildYear}年`);

  // 详情独有的字段
  if (detail?.base?.houseAge) base.push(`房龄状况：${detail.base.houseAge}`);
  if (detail?.base?.hasElevator) base.push(`电梯：${detail.base.hasElevator}`);
  if (detail?.base?.elevatorHouseholdRatio) base.push(`梯户比：${detail.base.elevatorHouseholdRatio}`);
  if (detail?.base?.buildingType) base.push(`楼型：${detail.base.buildingType}`);
  if (detail?.base?.usage) base.push(`用途：${detail.base.usage}`);
  if (detail?.base?.ownership) base.push(`产权：${detail.base.ownership}`);
  if (detail?.base?.innerArea) base.push(`套内面积：${detail.base.innerArea}`);
  if (detail?.base?.downPayment) base.push(`首付参考：${detail.base.downPayment}`);

  if (base.length > 0) {
    blocks.push(`■ 基本信息\n${base.join('\n')}`);
  }

  // ========================================================================
  // 标签（贝壳的真实标签，比我们自己编的"卖点"可信）
  // ========================================================================
  const tags = detail?.base?.tags?.length ? detail.base.tags : input.tags;
  if (tags.length > 0) {
    blocks.push(`■ 房源标签\n${tags.join(' · ')}`);
  }

  // ========================================================================
  // 小区信息（仅完整详情有）
  // ========================================================================
  if (detail?.community) {
    const c = detail.community;
    const community: string[] = [];

    if (c.buildYears) community.push(`建成年份：${c.buildYears}`);
    if (c.floorAreaRatio) community.push(`容积率：${c.floorAreaRatio}`);
    if (c.greeningRate) community.push(`绿化率：${c.greeningRate}`);
    if (c.propertyFee) community.push(`物业费：${c.propertyFee}`);
    if (c.propertyCompany) community.push(`物业公司：${c.propertyCompany}`);
    if (c.parkingRatio) community.push(`车位配比：${c.parkingRatio}`);
    if (c.totalHouseholds !== null) community.push(`总户数：${c.totalHouseholds}户`);
    if (c.separatedTraffic) community.push(`人车分流：${c.separatedTraffic}`);

    if (community.length > 0) {
      blocks.push(`■ 小区信息\n${community.join('\n')}`);
    }
  }

  // ========================================================================
  // 周边配套（只输出最近 2 条，避免文案过长；按距离升序已是后端保证的）
  // ========================================================================
  if (detail?.nearby) {
    const nearby: string[] = [];

    const line = (icon: string, label: string, list: NearbyFacility[]): void => {
      if (list.length === 0) return;

      const items = list
        .slice(0, 2)
        .map((item) =>
          item.distanceMeters !== null
            ? `${item.name}（${distance(item.distanceMeters)}）`
            : item.name,
        )
        .join('、');

      nearby.push(`${icon} ${label}：${items}`);
    };

    line('🚇', '地铁', detail.nearby.subway);
    line('🚌', '公交', detail.nearby.bus);
    line('🎓', '学校', detail.nearby.school);
    line('🏥', '医院', detail.nearby.hospital);
    line('🛒', '购物', detail.nearby.shopping);
    line('🌳', '公园', detail.nearby.park);

    if (nearby.length > 0) {
      blocks.push(`■ 周边配套\n${nearby.join('\n')}`);
    }
  } else {
    // 没有完整详情时，用列表里的交通/学区摘要兜底
    const fallback: string[] = [];
    if (input.subwayDistance !== null) fallback.push(`🚇 距地铁约${distance(input.subwayDistance)}`);
    if (input.schoolText) fallback.push(`🎓 ${input.schoolText}`);

    if (fallback.length > 0) blocks.push(`■ 周边配套\n${fallback.join('\n')}`);
  }

  // ========================================================================
  // 房源描述（贝壳原文）
  // ========================================================================
  if (detail?.base?.title && detail.base.title !== input.title) {
    blocks.push(`■ 房源描述\n${detail.base.title}`);
  } else if (input.title) {
    blocks.push(`■ 房源描述\n${input.title}`);
  }

  return blocks.join('\n\n');
}

/**
 * 生成"复制成功"后的统计提示（告诉经纪人复制了多少内容）。
 *
 * 单独抽出来而不是塞进 `formatPropertyForCopy`，
 * 是因为提示文本只用于界面反馈，不该污染复制出去的正文。
 *
 * @param detail 完整详情（null 表示没有）
 * @param text   已生成并复制成功的正文
 */
export function describeCopyOutput(
  detail: PropertyFullDetail | null | undefined,
  text: string,
): string {
  const parts = [`${text.length} 字`];

  if (detail) {
    parts.push('含小区与周边配套');

    const imageCount = detail.images?.length ?? 0;
    if (imageCount > 0) parts.push(`${imageCount} 张图片需另行发送`);
  } else {
    // 如实告知：没有完整详情时复制的只是摘要
    parts.push('未含完整详情，可展开卡片后重试');
  }

  return parts.join(' · ');
}
