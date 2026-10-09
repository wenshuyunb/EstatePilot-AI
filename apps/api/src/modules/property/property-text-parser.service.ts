/**
 * 房源文本解析器。
 *
 * 使用场景（真实中介最常用的数据来源）：
 *   经纪人在贝壳/链家/安居客后台复制房源信息，粘贴到系统里批量建库。
 *   这不是"爬虫"—— 数据是经纪人自己有权访问的房源，通过人工复制进入系统。
 *
 * 设计难点：复制出来的文本格式极不统一。真实样本可能是：
 *
 *   A. 带标签的逐行格式（最常见）
 *      小区名称：碧云国际社区
 *      户型：3室2厅
 *      面积：128.5平米
 *      总价：1250万
 *
 *   B. 无标签的紧凑格式
 *      碧云国际社区 3室2厅 128.5㎡ 1250万 精装 中层/18层
 *
 *   C. JSON（部分系统的复制按钮会给出结构化数据）
 *      {"community":"碧云国际社区","bedrooms":3,...}
 *
 * 因此策略是「多轮解析」：
 *   第 1 轮 尝试 JSON
 *   第 2 轮 按行切成记录块，再用标签正则逐字段提取
 *   第 3 轮 对无标签文本做位置与模式启发式提取
 * 每轮都记录命中了哪些字段，解析结果带 confidence 与 missingFields，
 * 让前端能明确告诉用户"哪些没解析出来、需要手工补"。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Decoration,
  ListingStatus,
  Orientation,
  OwnershipType,
  PropertyType,
  type NormalizedProperty,
  type SchoolInfo,
  type SubwayInfo,
} from '@estatepilot/types';

/** 解析出的单条记录 */
export interface ParsedPropertyDraft {
  /** 临时 ID，用于前端回显与错误定位 */
  draftId: string;
  /** 原始文本块 */
  rawText: string;
  /** 解析出的字段（缺失的为 null） */
  fields: {
    title: string | null;
    community: string | null;
    district: string | null;
    subDistrict: string | null;
    address: string | null;

    totalPrice: number | null;
    unitPrice: number | null;

    bedrooms: number | null;
    livingRooms: number | null;
    bathrooms: number | null;
    area: number | null;

    floor: number | null;
    totalFloors: number | null;

    orientation: Orientation | null;
    buildYear: number | null;
    propertyType: PropertyType | null;
    ownershipType: OwnershipType | null;
    decoration: Decoration | null;
    elevator: boolean | null;

    subwayDistance: number | null;
    subway: SubwayInfo | null;
    schoolInfo: SchoolInfo | null;

    tags: string[];
    description: string | null;
    listingStatus: ListingStatus | null;

    /** 原始图片链接（若文本里带 URL） */
    imageUrls: string[];
  };
  /** 0～1，表示字段填充完整度 */
  confidence: number;
  /** 缺失的关键字段 */
  missingFields: string[];
  /** 解析过程中的告警（如"总价疑似以元为单位"） */
  warnings: string[];
}

export interface ParseResult {
  drafts: ParsedPropertyDraft[];
  /** 整体统计 */
  summary: {
    totalBlocks: number;
    parsedBlocks: number;
    /** 可用于入库的记录数（关键字段齐全） */
    importable: number;
  };
}

/**
 * 字段标签映射。
 *
 * 每个标准字段对应一组可能的中文标签 —— 不同平台的叫法不同，
 * 例如"总价"可能写成"售价""挂牌价""价格"。
 * 匹配时用「标签 + 分隔符 + 值」的正则，避免把描述文字里的词误当字段。
 */
const FIELD_LABELS: Record<string, string[]> = {
  community: ['小区名称', '小区', '楼盘名称', '楼盘', '所在小区', '小区名'],
  title: ['标题', '房源标题', '房源名称'],
  district: ['所在区域', '区域', '行政区', '所在区', '城区'],
  subDistrict: ['板块', '商圈', '片区', '所在板块'],
  address: ['详细地址', '地址', '小区地址', '位置'],
  totalPrice: ['总价', '售价', '挂牌价', '房屋总价', '价格'],
  unitPrice: ['单价', '均价', '每平米价格', '单价(元/平)'],
  layout: ['户型', '房型', '户型结构'],
  bedrooms: ['室', '卧室', '房间数'],
  livingRooms: ['厅', '客厅'],
  bathrooms: ['卫', '卫生间'],
  area: ['建筑面积', '面积', '建面', '房屋面积'],
  floor: ['所在楼层', '楼层', '当前楼层'],
  totalFloors: ['总楼层', '楼层总数', '总层数', '楼高'],
  orientation: ['朝向', '房屋朝向', '主卧朝向'],
  buildYear: ['建筑年代', '建成年代', '建造年代', '建成年份', '房龄'],
  decoration: ['装修', '装修情况', '装修程度'],
  elevator: ['电梯', '是否有电梯'],
  ownership: ['产权', '产权性质', '产权类型', '房屋性质'],
  subway: ['地铁', '附近地铁', '轨道交通', '地铁信息'],
  school: ['学校', '学区', '附近学校', '对口学校'],
  tags: ['标签', '房源标签', '特色'],
  description: ['房源描述', '描述', '房源亮点', '核心卖点'],
  listingDate: ['挂牌时间', '上架时间', '发布时间'],
  propertyType: ['房屋类型', '物业类型', '房屋用途'],
};

/** 把标签数组编译成一次性匹配的正则（含全角/半角冒号与中划线分隔） */
function buildLabelRegex(labels: string[]): RegExp {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // 分隔符支持：  ：  :  ＝  =  空格
  return new RegExp(`(?:${escaped.join('|')})\\s*[:：=＝]?\\s*([^\\n\\r]{1,120})`, 'i');
}

/** 预编译正则，避免每次解析都重新构建 */
const COMPILED_LABELS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(FIELD_LABELS).map(([key, labels]) => [key, buildLabelRegex(labels)]),
);

@Injectable()
export class PropertyTextParserService {
  private readonly logger = new Logger(PropertyTextParserService.name);

  /**
   * 解析粘贴文本。
   *
   * @param text 用户粘贴的原始文本（可能包含多条房源）
   * @param defaults 默认值（如城市固定为上海，避免每条都要求填）
   */
  parse(text: string, defaults: { city?: string } = {}): ParseResult {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    if (!normalized) {
      return { drafts: [], summary: { totalBlocks: 0, parsedBlocks: 0, importable: 0 } };
    }

    // ---- 策略 1：尝试整体 JSON ----
    const jsonDrafts = this.tryParseJson(normalized, defaults);
    if (jsonDrafts.length > 0) {
      return this.summarize(jsonDrafts, 1);
    }

    // ---- 策略 2：按空行/分隔线切成记录块 ----
    const blocks = this.splitIntoBlocks(normalized);

    const drafts: ParsedPropertyDraft[] = [];
    for (const block of blocks) {
      const draft = this.parseBlock(block, defaults);
      // 完全没解析出内容的块直接丢弃（多为表头或说明文字）
      if (draft.fields.community || draft.fields.title || draft.fields.totalPrice) {
        drafts.push(draft);
      }
    }

    // ---- 策略 3：如果一个块都没切出来，尝试把整段当单条解析 ----
    if (drafts.length === 0) {
      const single = this.parseBlock(normalized, defaults);
      if (single.fields.community || single.fields.totalPrice) {
        drafts.push(single);
      }
    }

    return this.summarize(drafts, blocks.length);
  }

  /** 汇总统计 */
  private summarize(drafts: ParsedPropertyDraft[], totalBlocks: number): ParseResult {
    const importable = drafts.filter((draft) => this.isImportable(draft)).length;
    return {
      drafts,
      summary: {
        totalBlocks,
        parsedBlocks: drafts.length,
        importable,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 块切分
  // -------------------------------------------------------------------------

  /**
   * 把长文本切成一条条房源记录。
   *
   * 切分优先级：
   *   1. 连续空行（用户通常用空行分隔不同房源）
   *   2. 分隔线（--- 或 ==== 或 ───）
   *   3. 序号开头的新行（"1." "2、" "第1套"）—— 贝壳后台复制常见
   *   4. 如果都没有，则每行视为一条（紧凑格式）
   */
  private splitIntoBlocks(text: string): string[] {
    // 1. 空行分隔
    let blocks = text
      .split(/\n\s*\n+/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);

    if (blocks.length > 1) {
      // 块内可能还有分隔线，再切一次
      blocks = blocks.flatMap((block) =>
        block
          .split(/^\s*[-=─—]{3,}\s*$/m)
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      );
      return blocks;
    }

    // 2. 序号开头
    const numbered = text.split(/\n(?=\s*(?:\d{1,3}\s*[.、)）]|第\s*\d{1,3}\s*套))/);
    if (numbered.length > 1) {
      return numbered.map((part) => part.trim()).filter((part) => part.length > 0);
    }

    // 3. 分隔线
    const byDivider = text
      .split(/^\s*[-=─—]{3,}\s*$/m)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (byDivider.length > 1) return byDivider;

    // 4. 紧凑格式：每行一条房源（从列表页复制）
    //
    // 判定条件（两个都要满足，避免误切带标签的块）：
    //   a. 至少 2 行 —— 最初写成 >=3 是错的，两行房源是很常见的情况
    //   b. 超过半数的行含价格，且这些含价格的行里没有字段标签冒号
    //      （带标签的文本每行都有冒号，不应该被按行拆开）
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

    const pricePattern = /\d{2,5}(?:\.\d+)?\s*万|\d{4,7}\s*元\s*\/?\s*[平㎡]|总价/;
    const labelledLineCount = lines.filter((line) => /[:：]/.test(line)).length;
    const priceLikeLines = lines.filter((line) => pricePattern.test(line));

    const looksLikeCompactList =
      lines.length >= 2 &&
      priceLikeLines.length >= Math.ceil(lines.length * 0.6) &&
      // 带标签的行占比不能过高，否则这是"逐字段块"而不是"列表"
      labelledLineCount < lines.length * 0.5;

    if (looksLikeCompactList) {
      // 只保留含价格的行，过滤掉表头或说明行
      return priceLikeLines;
    }

    return [text];
  }

  // -------------------------------------------------------------------------
  // JSON 解析
  // -------------------------------------------------------------------------

  /**
   * 尝试把文本解析成 JSON 数组或对象。
   * 部分平台的"复制"按钮会给出结构化数据，这种情况解析准确度最高。
   */
  private tryParseJson(text: string, defaults: { city?: string }): ParsedPropertyDraft[] {
    // 只处理以 { 或 [ 开头的文本，避免误解析含花括号的描述
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    const drafts: ParsedPropertyDraft[] = [];

    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;

      const draft = this.emptyDraft(JSON.stringify(record));

      // 常见英文字段名映射
      draft.fields.community = this.pickString(record, ['community', 'communityName', 'xiaoqu']);
      draft.fields.title = this.pickString(record, ['title', 'name']);
      draft.fields.district = this.pickString(record, ['district', 'districtName', 'area']);
      draft.fields.subDistrict = this.pickString(record, ['subDistrict', 'bizCircle', 'block']);
      draft.fields.address = this.pickString(record, ['address']);

      draft.fields.totalPrice = this.normalizeTotalPrice(
        this.pickNumber(record, ['totalPrice', 'price', 'totalPriceWan', 'sellingPrice']),
        draft.warnings,
        record,
      );
      draft.fields.unitPrice = this.pickNumber(record, ['unitPrice', 'averagePrice']);
      draft.fields.area = this.pickNumber(record, ['area', 'buildArea', 'buildingArea']);
      draft.fields.bedrooms = this.pickNumber(record, ['bedrooms', 'room', 'bedroomCount']);
      draft.fields.livingRooms = this.pickNumber(record, ['livingRooms', 'hall', 'livingRoomCount']);
      draft.fields.bathrooms = this.pickNumber(record, ['bathrooms', 'bathroomCount']);
      draft.fields.floor = this.pickNumber(record, ['floor']);
      draft.fields.totalFloors = this.pickNumber(record, ['totalFloors', 'totalFloor']);
      draft.fields.buildYear = this.pickNumber(record, ['buildYear', 'builtYear']);

      const orientationRaw = this.pickString(record, ['orientation']);
      if (orientationRaw) draft.fields.orientation = this.parseOrientation(orientationRaw);

      const decorationRaw = this.pickString(record, ['decoration']);
      if (decorationRaw) draft.fields.decoration = this.parseDecoration(decorationRaw);

      if (draft.fields.area && draft.fields.totalPrice && !draft.fields.unitPrice) {
        draft.fields.unitPrice = Math.round(draft.fields.totalPrice / draft.fields.area);
      }

      const images = record.imageUrls ?? record.images;
      if (Array.isArray(images)) {
        draft.fields.imageUrls = images.filter((url): url is string => typeof url === 'string');
      }

      draft.fields.description = this.pickString(record, ['description', 'remark']);
      this.finalizeDraft(draft, defaults);
      drafts.push(draft);
    }

    return drafts;
  }

  private pickString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return null;
  }

  private pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Number(value.replace(/[^\d.]/g, ''));
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
    return null;
  }

  /**
   * 归一化总价。
   *
   * 这是最容易出错的地方：不同来源的单位可能是万元或元。
   * 判断规则：
   *   - 若字段名含 Wan（如 totalPriceWan），按万元处理
   *   - 数值 < 100000 时按万元处理（真实总价不可能只有 12 万）
   *   - 数值 >= 100000 时按元处理
   */
  private normalizeTotalPrice(
    value: number | null,
    warnings: string[],
    record: Record<string, unknown>,
  ): number | null {
    if (value === null || value <= 0) return null;

    const hasWanField = 'totalPriceWan' in record || 'priceWan' in record;

    if (hasWanField) return Math.round(value * 10_000);

    if (value < 100_000) {
      // 按万元处理
      return Math.round(value * 10_000);
    }

    if (value < 1_000_000) {
      warnings.push(`总价 ${value} 元明显偏低，请确认单位是否正确`);
    }

    return Math.round(value);
  }

  // -------------------------------------------------------------------------
  // 标签解析（核心逻辑）
  // -------------------------------------------------------------------------

  /** 解析单个文本块 */
  private parseBlock(block: string, defaults: { city?: string }): ParsedPropertyDraft {
    const draft = this.emptyDraft(block);
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // ---- 逐字段尝试标签匹配 ----
    const fieldMap: Array<[keyof typeof FIELD_LABELS, (value: string) => void]> = [
      ['community', (value) => (draft.fields.community = this.cleanValue(value))],
      ['title', (value) => (draft.fields.title = this.cleanValue(value))],
      ['district', (value) => (draft.fields.district = this.cleanDistrict(this.cleanValue(value)))],
      ['subDistrict', (value) => (draft.fields.subDistrict = this.cleanValue(value))],
      ['address', (value) => (draft.fields.address = this.cleanValue(value))],
      [
        'totalPrice',
        (value) => {
          const price = this.parsePrice(value);
          if (price !== null) draft.fields.totalPrice = price;
        },
      ],
      [
        'unitPrice',
        (value) => {
          const unitPrice = this.parsePlainNumber(value);
          if (unitPrice !== null) draft.fields.unitPrice = unitPrice;
        },
      ],
      [
        'area',
        (value) => {
          const area = this.parsePlainNumber(value);
          if (area !== null && area > 5 && area < 2000) draft.fields.area = area;
        },
      ],
      [
        'orientation',
        (value) => {
          const orientation = this.parseOrientation(value);
          if (orientation) draft.fields.orientation = orientation;
        },
      ],
      [
        'decoration',
        (value) => {
          const decoration = this.parseDecoration(value);
          if (decoration) draft.fields.decoration = decoration;
        },
      ],
      [
        'buildYear',
        (value) => {
          const year = this.parseBuildYear(value);
          if (year) draft.fields.buildYear = year;
        },
      ],
      [
        'subway',
        (value) => {
          const subway = this.parseSubway(value);
          const distance = this.parseDistanceMeters(value);
          if (distance !== null) draft.fields.subwayDistance = distance;
          if (subway) draft.fields.subway = subway;
          else if (distance !== null) draft.fields.subway = { distanceMeters: distance };
        },
      ],
      [
        'school',
        (value) => {
          const school = this.parseSchool(this.cleanValue(value) ?? '');
          if (school) draft.fields.schoolInfo = school;
        },
      ],
      [
        'ownership',
        (value) => {
          const ownership = this.parseOwnership(value);
          if (ownership) draft.fields.ownershipType = ownership;
        },
      ],
      [
        'propertyType',
        (value) => {
          const type = this.parsePropertyType(value);
          if (type) draft.fields.propertyType = type;
        },
      ],
      [
        'elevator',
        (value) => {
          const elevator = this.parseElevator(value);
          if (elevator !== null) draft.fields.elevator = elevator;
        },
      ],
      // 楼层：从字段值里提取纯数字。
      // 「所在楼层：低楼层」这种中文描述在这里取不到数字，
      // 会由下方专门的楼层解析段按总层数换算。
      [
        'floor',
        (value) => {
          const floor = this.parsePlainNumber(value);
          if (floor !== null && floor >= 1 && floor <= 200) draft.fields.floor = floor;
        },
      ],
      [
        'totalFloors',
        (value) => {
          const total = this.parsePlainNumber(value);
          if (total !== null && total >= 1 && total <= 200) draft.fields.totalFloors = total;
        },
      ],
      [
        'tags',
        (value) => {
          draft.fields.tags = this.parseTags(value);
        },
      ],
      [
        'description',
        (value) => {
          draft.fields.description = this.cleanValue(value);
        },
      ],
    ];

    for (const [key, apply] of fieldMap) {
      const regex = COMPILED_LABELS[key];
      if (!regex) continue;
      const match = regex.exec(block);
      if (match?.[1]) apply(match[1]);
    }

    // ---- 户型 ----
    //
    // 这里踩过一个真实的坑：最初写的正则是
    //   /(\d{1,2})室\s*(\d{1,2})?厅?\s*(\d{1,2})?\s*卫?/
    // 它会把 "3室2厅 128.5㎡" 解析成「12 卫」——
    // 因为 厅? 与 卫? 都是可选的，正则在匹配完"厅"之后继续吞掉了面积的开头数字。
    //
    // 修正方式：
    //   1. 厅 / 卫 用显式分组，只有真正出现"厅""卫"字样才捕获
    //   2. 卫 的取值后加 (?![\d.]) 前瞻，确保它不是面积或价格的起始数字
    const layoutMatch =
      /(\d{1,2})\s*室\s*(?:(\d{1,2})\s*厅)?\s*(?:(\d{1,2})\s*卫(?![\d.]))?/.exec(block);
    if (layoutMatch?.[1]) {
      draft.fields.bedrooms = Number(layoutMatch[1]);
      if (layoutMatch[2]) draft.fields.livingRooms = Number(layoutMatch[2]);
      if (layoutMatch[3]) draft.fields.bathrooms = Number(layoutMatch[3]);
    }

    // ---- 楼层 ----
    // 支持三种真实写法：
    //   "8/18层"     → floor=8, totalFloors=18
    //   "中层/18层"   → 按总层数换算 floor
    //   "共18层"      → 仅 totalFloors
    const numericFloor = /(\d{1,3})\s*\/\s*(\d{1,3})\s*层/.exec(block);
    // 注意：「中层」与「中楼层」都存在，因此"层"后面的"楼"才是可选的 ——
    // 最初写成 (低|中|高|顶)楼层? 是错的，那样会要求"楼"必须存在。
    const cnFloorSlash = /(低|中|高|顶)楼?层\s*\/\s*(\d{1,3})\s*层/.exec(block);

    if (numericFloor?.[1] && numericFloor[2]) {
      draft.fields.floor = Number(numericFloor[1]);
      draft.fields.totalFloors = Number(numericFloor[2]);
    } else if (cnFloorSlash?.[1] && cnFloorSlash[2]) {
      const total = Number(cnFloorSlash[2]);
      draft.fields.totalFloors = total;
      draft.fields.floor = this.cnFloorToNumber(cnFloorSlash[1], total);
    } else {
      const totalFloorsMatch = /共\s*(\d{1,3})\s*层/.exec(block);
      if (totalFloorsMatch?.[1]) draft.fields.totalFloors = Number(totalFloorsMatch[1]);

      const cnFloor = /(低|中|高|顶)楼?层/.exec(block);
      if (cnFloor?.[1] && draft.fields.totalFloors) {
        draft.fields.floor = this.cnFloorToNumber(cnFloor[1], draft.fields.totalFloors);
      } else if (cnFloor?.[1]) {
        // 没有总层数时无法换算具体楼层，明确告知用户而不是静默丢失
        draft.warnings.push(`楼层描述为「${cnFloor[1]}楼层」，缺少总层数无法换算具体楼层，请手工补充`);
      }
    }

    // ---- 面积兜底：形如 "128.5平米" / "128.5㎡" ----
    if (draft.fields.area === null) {
      const areaMatch = /(\d{2,4}(?:\.\d{1,2})?)\s*(?:平米|平方米|㎡|平)/.exec(block);
      if (areaMatch?.[1]) {
        const area = Number(areaMatch[1]);
        if (area > 5 && area < 2000) draft.fields.area = area;
      }
    }

    // ---- 总价兜底：形如 "1250万" / "1250 万" ----
    if (draft.fields.totalPrice === null) {
      const priceMatch = /(\d{2,5}(?:\.\d{1,2})?)\s*万/.exec(block);
      if (priceMatch?.[1]) {
        draft.fields.totalPrice = Math.round(Number(priceMatch[1]) * 10_000);
      }
    }

    // ---- 标题兜底：第一行若不含字段标签，通常就是标题 ----
    if (!draft.fields.title && lines.length > 0) {
      const firstLine = lines[0] as string;
      const looksLikeLabel = /[:：]/.test(firstLine) && firstLine.length < 30;
      if (!looksLikeLabel) draft.fields.title = firstLine.slice(0, 120);
    }

    // ---- 小区名兜底：标题里通常以小区名开头 ----
    if (!draft.fields.community && draft.fields.title) {
      const titleMatch = /^([\u4e00-\u9fffA-Za-z0-9]{2,20}?)(?:\s|$|[（(])/.exec(draft.fields.title);
      if (titleMatch?.[1]) draft.fields.community = titleMatch[1];
    }

    // ---- 图片 URL ----
    const urlMatches = block.match(/https?:\/\/[^\s"'<>)]+\.(?:jpg|jpeg|png|webp)/gi);
    if (urlMatches) draft.fields.imageUrls = urlMatches.slice(0, 30);

    // ---- 单价兜底 ----
    if (draft.fields.unitPrice === null && draft.fields.totalPrice && draft.fields.area) {
      draft.fields.unitPrice = Math.round(draft.fields.totalPrice / draft.fields.area);
    }

    this.finalizeDraft(draft, defaults);
    return draft;
  }

  // -------------------------------------------------------------------------
  // 值解析辅助
  // -------------------------------------------------------------------------

  private emptyDraft(rawText: string): ParsedPropertyDraft {
    return {
      draftId: `draft_${Math.random().toString(36).slice(2, 10)}`,
      rawText,
      fields: {
        title: null,
        community: null,
        district: null,
        subDistrict: null,
        address: null,
        totalPrice: null,
        unitPrice: null,
        bedrooms: null,
        livingRooms: null,
        bathrooms: null,
        area: null,
        floor: null,
        totalFloors: null,
        orientation: null,
        buildYear: null,
        propertyType: null,
        ownershipType: null,
        decoration: null,
        elevator: null,
        subwayDistance: null,
        subway: null,
        schoolInfo: null,
        tags: [],
        description: null,
        listingStatus: null,
        imageUrls: [],
      },
      confidence: 0,
      missingFields: [],
      warnings: [],
    };
  }

  /**
   * 中文楼层描述 → 具体楼层数。
   *
   * 换算规则（贴近真实房产习惯）：
   *   低楼层 → 取总层数的 1/6 位置（约 2～3 层）
   *   中楼层 → 取总层数的 1/2
   *   高楼层 → 取总层数的 5/6
   *   顶楼   → 总层数
   * 换算结果存入 floor 字段，同时原始描述会体现在 floorPosition 展示中。
   */
  private cnFloorToNumber(description: string, totalFloors: number): number {
    switch (description) {
      case '低':
        return Math.max(1, Math.round(totalFloors / 6));
      case '中':
        return Math.max(1, Math.round(totalFloors / 2));
      case '高':
        return Math.max(1, Math.round((totalFloors * 5) / 6));
      case '顶':
        return totalFloors;
      default:
        return Math.max(1, Math.round(totalFloors / 2));
    }
  }

  /** 清理取到的值：去掉后续字段标签与多余空白 */
  private cleanValue(value: string): string | null {
    const cleaned = value
      // 截断到下一个字段标签之前
      .split(/\s{2,}|\t/)[0]
      ?.trim()
      .replace(/[，,;；]+$/, '')
      .trim();
    return cleaned && cleaned.length > 0 ? cleaned : null;
  }

  private cleanDistrict(value: string | null): string | null {
    if (!value) return null;
    // "浦东-张江" → 取区域部分；"浦东新区" 保留
    const first = value.split(/[-–—/]/)[0]?.trim();
    return first && first.length > 0 ? first : null;
  }

  private parsePlainNumber(value: string): number | null {
    const match = /(\d{1,7}(?:\.\d{1,2})?)/.exec(value);
    if (!match?.[1]) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * 解析价格：支持 "1250万" / "1250 万" / "12500000元" / "1250" 。
   * 无单位时按上下文推断（小于 10 万视为万元）。
   */
  private parsePrice(value: string): number | null {
    const wanMatch = /(\d{2,5}(?:\.\d{1,2})?)\s*万/.exec(value);
    if (wanMatch?.[1]) return Math.round(Number(wanMatch[1]) * 10_000);

    const yuanMatch = /(\d{6,9})\s*元/.exec(value);
    if (yuanMatch?.[1]) return Number(yuanMatch[1]);

    const plain = this.parsePlainNumber(value);
    if (plain === null) return null;
    return plain < 100_000 ? Math.round(plain * 10_000) : plain;
  }

  private parseDistanceMeters(value: string): number | null {
    const kmMatch = /(\d+(?:\.\d+)?)\s*(?:km|公里|千米)/i.exec(value);
    if (kmMatch?.[1]) return Math.round(Number(kmMatch[1]) * 1000);

    const meterMatch = /(\d{2,5})\s*(?:m|米)/i.exec(value);
    if (meterMatch?.[1]) return Number(meterMatch[1]);

    return null;
  }

  private parseOrientation(value: string): Orientation | null {
    const normalized = value.replace(/\s/g, '');
    if (/南北|南\+北/.test(normalized)) return Orientation.SOUTH_NORTH;
    if (normalized.includes('东南')) return Orientation.SOUTHEAST;
    if (normalized.includes('西南')) return Orientation.SOUTHWEST;
    if (normalized.includes('东北')) return Orientation.NORTHEAST;
    if (normalized.includes('西北')) return Orientation.NORTHWEST;
    if (normalized.includes('南')) return Orientation.SOUTH;
    if (normalized.includes('北')) return Orientation.NORTH;
    if (normalized.includes('东')) return Orientation.EAST;
    if (normalized.includes('西')) return Orientation.WEST;
    return null;
  }

  private parseDecoration(value: string): Decoration | null {
    if (value.includes('豪')) return Decoration.LUXURY;
    if (value.includes('精')) return Decoration.FINE;
    if (value.includes('简')) return Decoration.SIMPLE;
    if (value.includes('毛坯') || value.includes('无装修') || value.includes('清水')) {
      return Decoration.ROUGH;
    }
    return null;
  }

  /** 支持 "2018年" / "2018" / "7年房龄" 三种写法 */
  private parseBuildYear(value: string): number | null {
    const yearMatch = /(19\d{2}|20\d{2})/.exec(value);
    if (yearMatch?.[1]) {
      const year = Number(yearMatch[1]);
      if (year >= 1900 && year <= new Date().getFullYear() + 2) return year;
    }

    // "7年房龄" → 反推建成年份
    const ageMatch = /(\d{1,2})\s*年房龄/.exec(value);
    if (ageMatch?.[1]) {
      return new Date().getFullYear() - Number(ageMatch[1]);
    }

    return null;
  }

  private parseSubway(value: string): SubwayInfo | null {
    const lineMatch = /(\d{1,2})\s*号线/.exec(value);
    const stationMatch = /([\u4e00-\u9fff]{2,10})\s*站/.exec(value);
    const distance = this.parseDistanceMeters(value);

    if (!lineMatch && !stationMatch && distance === null) return null;

    return {
      ...(lineMatch?.[1] ? { line: `${lineMatch[1]} 号线` } : {}),
      ...(stationMatch?.[1] ? { station: stationMatch[1] } : {}),
      ...(distance !== null ? { distanceMeters: distance, walkMinutes: Math.max(1, Math.round(distance / 80)) } : {}),
    };
  }

  private parseSchool(value: string): SchoolInfo | null {
    if (!value.trim()) return null;

    const isKey = /重点|实验|外国语|第一|名校|双学区/.test(value);
    const isOccupied = /已占用|被占用|名额已用/.test(value);

    // 尝试区分小学与初中
    const primaryMatch = /([\u4e00-\u9fff]{2,15}小学)/.exec(value);
    const middleMatch = /([\u4e00-\u9fff]{2,15}(?:初中|中学))/.exec(value);

    return {
      ...(primaryMatch?.[1] ? { primarySchool: primaryMatch[1] } : {}),
      ...(middleMatch?.[1] ? { middleSchool: middleMatch[1] } : {}),
      isKeySchool: isKey,
      ...(isOccupied ? { seatOccupied: true } : {}),
      note: '学校信息来自粘贴文本，请以教育部门公示为准',
    };
  }

  private parseOwnership(value: string): OwnershipType | null {
    if (value.includes('商品房')) return OwnershipType.FREEHOLD;
    if (value.includes('房改') || value.includes('售后公房')) return OwnershipType.HOUSING_REFORM;
    if (value.includes('经济适用')) return OwnershipType.AFFORDABLE;
    if (value.includes('动迁') || value.includes('安置')) return OwnershipType.RELOCATION;
    if (value.includes('商办') || value.includes('商业')) return OwnershipType.COMMERCIAL;
    return null;
  }

  private parsePropertyType(value: string): PropertyType | null {
    if (value.includes('别墅')) return PropertyType.VILLA;
    if (value.includes('洋房') || value.includes('联排')) return PropertyType.TOWNHOUSE;
    if (value.includes('商铺')) return PropertyType.SHOP;
    if (value.includes('写字楼') || value.includes('办公')) return PropertyType.OFFICE;
    if (value.includes('住宅') || value.includes('公寓')) return PropertyType.APARTMENT;
    return null;
  }

  private parseElevator(value: string): boolean | null {
    if (/有|是|配电梯|带电梯/.test(value) && !/无|没有|不带/.test(value)) return true;
    if (/无|没有|不带|步梯/.test(value)) return false;
    return null;
  }

  private parseTags(value: string): string[] {
    return value
      .split(/[,，、;；\s|]+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && tag.length <= 20)
      .slice(0, 12);
  }

  // -------------------------------------------------------------------------
  // 收尾：计算完整度并推断默认值
  // -------------------------------------------------------------------------

  /**
   * 完成后处理：
   *   - 填充默认值（城市）
   *   - 若只有卧室数，推导户型描述
   *   - 计算 confidence 与 missingFields
   */
  private finalizeDraft(draft: ParsedPropertyDraft, defaults: { city?: string }): void {
    const fields = draft.fields;

    // 关键字段缺失检查
    const requiredChecks: Array<[string, boolean]> = [
      ['小区名称', Boolean(fields.community)],
      ['总价', fields.totalPrice !== null],
      ['建筑面积', fields.area !== null],
      ['户型（室）', fields.bedrooms !== null],
      ['所在区域', Boolean(fields.district)],
    ];

    draft.missingFields = requiredChecks
      .filter(([, present]) => !present)
      .map(([label]) => label);

    // 可选字段
    const optionalChecks: Array<[string, boolean]> = [
      ['标题', Boolean(fields.title)],
      ['楼层', fields.floor !== null || fields.totalFloors !== null],
      ['朝向', fields.orientation !== null],
      ['装修', fields.decoration !== null],
      ['建成年份', fields.buildYear !== null],
      ['地铁距离', fields.subwayDistance !== null],
      ['单价', fields.unitPrice !== null],
    ];

    const requiredFilled = requiredChecks.filter(([, present]) => present).length;
    const optionalFilled = optionalChecks.filter(([, present]) => present).length;

    // 关键字段权重 75%，可选字段 25%
    draft.confidence = Number(
      (
        (requiredFilled / requiredChecks.length) * 0.75 +
        (optionalFilled / optionalChecks.length) * 0.25
      ).toFixed(3),
    );

    // 补齐计算字段
    if (fields.unitPrice === null && fields.totalPrice && fields.area) {
      fields.unitPrice = Math.round(fields.totalPrice / fields.area);
    }

    // 生成标题
    if (!fields.title && fields.community) {
      const parts = [fields.community];
      if (fields.bedrooms) parts.push(`${fields.bedrooms}室`);
      if (fields.area) parts.push(`${fields.area}㎡`);
      fields.title = parts.join(' ');
    }

    // 地址兜底
    if (!fields.address && fields.community) {
      fields.address = [defaults.city ?? '上海', fields.district, fields.subDistrict, fields.community]
        .filter(Boolean)
        .join('');
    }

    // 默认值
    fields.propertyType = fields.propertyType ?? PropertyType.APARTMENT;
    fields.listingStatus = fields.listingStatus ?? ListingStatus.ACTIVE;

    // 合理性校验
    if (fields.totalPrice !== null && fields.totalPrice < 100_000) {
      draft.warnings.push('总价低于 10 万，可能单位解析有误');
    }
    if (fields.area !== null && (fields.area < 10 || fields.area > 1000)) {
      draft.warnings.push(`面积 ${fields.area}㎡ 超出常见范围，请确认`);
    }
    if (fields.bedrooms !== null && (fields.bedrooms < 1 || fields.bedrooms > 10)) {
      draft.warnings.push(`卧室数 ${fields.bedrooms} 异常，请确认`);
    }
    if (fields.buildYear !== null) {
      const age = new Date().getFullYear() - fields.buildYear;
      if (age < 0 || age > 100) draft.warnings.push(`建成年份 ${fields.buildYear} 异常，请确认`);
    }
  }

  /** 是否满足入库条件（关键字段齐全，否则入库后无法参与匹配） */
  private isImportable(draft: ParsedPropertyDraft): boolean {
    const f = draft.fields;
    return Boolean(f.community) && f.totalPrice !== null && f.area !== null && f.bedrooms !== null;
  }

  /**
   * 把解析草稿转成统一的 NormalizedProperty，供 PropertySyncService 入库。
   * 转换时再次校验，避免脏数据进入业务库。
   */
  toNormalizedProperty(
    draft: ParsedPropertyDraft,
    options: {
      city: string;
      externalId: string;
      organizationId: string;
    },
  ): NormalizedProperty | null {
    const f = draft.fields;

    if (!f.community || f.totalPrice === null || f.area === null || f.bedrooms === null) {
      this.logger.warn(`草稿 ${draft.draftId} 关键字段不全，跳过转换`);
      return null;
    }

    return {
      externalProvider: 'INTERNAL' as NormalizedProperty['externalProvider'],
      externalId: options.externalId,
      rawData: {
        source: 'PASTE_IMPORT',
        importedAt: new Date().toISOString(),
        parseConfidence: draft.confidence,
        rawText: draft.rawText.slice(0, 4000),
      },

      city: options.city,
      district: f.district ?? '待补充',
      subDistrict: f.subDistrict,
      community: f.community,
      title: f.title ?? `${f.community} ${f.bedrooms}室`,
      address: f.address,
      longitude: null,
      latitude: null,

      totalPrice: f.totalPrice,
      unitPrice: f.unitPrice ?? Math.round(f.totalPrice / f.area),

      bedrooms: f.bedrooms,
      livingRooms: f.livingRooms ?? (f.bedrooms >= 3 ? 2 : 1),
      bathrooms: f.bathrooms ?? 1,
      area: f.area,

      floor: f.floor,
      totalFloors: f.totalFloors,

      orientation: f.orientation,
      buildYear: f.buildYear,
      propertyType: f.propertyType ?? PropertyType.APARTMENT,
      ownershipType: f.ownershipType,
      decoration: f.decoration,
      elevator: f.elevator,

      subwayDistance: f.subwayDistance,
      subway: f.subway,
      schoolInfo: f.schoolInfo,

      tags: f.tags,
      images: f.imageUrls.map((url, index) => ({
        url,
        category: 'INTERIOR' as const,
        sortOrder: index,
      })),
      floorPlan: [],
      description: f.description,

      listingStatus: f.listingStatus ?? ListingStatus.ACTIVE,
      listingDate: new Date().toISOString(),
      lastPriceChange: null,
    };
  }
}
