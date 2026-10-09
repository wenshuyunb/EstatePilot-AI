/**
 * 贝壳 AI 开放平台响应解析器。
 *
 * 背景：贝壳 AI 开放平台的接口是 MCP（Model Context Protocol）服务，
 * 返回内容是为 **LLM 阅读**设计的结构化文本，而不是纯 JSON。格式长这样：
 *
 *   <参考数据>
 *     <数据查询>
 *       - 查询目标实体类型：房源
 *       【检索概览】
 *       - 总召回结果数：6063
 *     </数据查询>
 *     <贝壳召回知识>
 *       <房源>
 *         <107112596630>
 *         {"基础信息": {"总价": "510万", "建筑面积": "122㎡", ...}}
 *         {"周边交通": ["距离杨高北路(地铁站)地铁站步行距离1008米，步行约15分钟"]}
 *         </107112596630>
 *       </房源>
 *     </贝壳召回知识>
 *   </参考数据>
 *
 * 解析策略：
 *   1. 定位知识区块（<贝壳召回知识> 或直接从 <房源>/<小区> 标签内找）
 *   2. 用「标签名即实体 ID」的规律切出每个实体块
 *   3. 块内按行扫描，逐行尝试 JSON.parse（因为一个实体有多个并列 JSON 对象）
 *   4. 合并所有 JSON 对象为一个扁平结构，再按字段映射表提取
 *
 * 这个解析器必须对格式变化有韧性：贝壳随时可能调整输出结构，
 * 因此每一步都做防御性处理，解析失败时返回空数组而不是抛异常，
 * 并记录原始文本便于排查。
 */

import { Logger } from '@nestjs/common';
import {
  Decoration,
  ListingStatus,
  Orientation,
  OwnershipType,
  PropertyType,
  type NormalizedProperty,
  type PropertyImage,
  type SchoolInfo,
  type SubwayInfo,
} from '@estatepilot/types';

/** 从文本中解析出的原始实体（字段未经业务映射） */
export interface ParsedEntity {
  /** 实体 ID（贝壳的房源 ID / 小区 ID） */
  id: string;
  /** 实体类型 */
  kind: 'house' | 'newhouse' | 'resblock' | 'school' | 'unknown';
  /** 合并后的原始字段（键为中文标签） */
  fields: Record<string, unknown>;
  /** 该实体的原始文本块，便于排查 */
  rawText: string;
}

/** 检索概览信息 */
export interface SearchOverview {
  /** 总召回结果数 */
  totalRecalled: number | null;
  /** 本次展示数量 */
  displayedCount: number | null;
  /** 实际生效的检索条件 */
  matchedConditions: Array<{
    query: string;
    condition: string;
    matchType: 'EXACT' | 'LIKE' | 'UNKNOWN';
  }>;
  /** unix_id，贝壳用于串联一次会话的检索 */
  unixId: string | null;
}

export interface ParsedBeikeResponse {
  entities: ParsedEntity[];
  overview: SearchOverview;
  /** 完整原始文本（调试用） */
  rawData: string;
  /**
   * 贝壳返回的业务错误。
   *
   * 为什么必须显式暴露：CLI 在 MCP 服务返回错误时依然以退出码 0 结束，
   * 错误体是 {"error": "...", "ok": false}。
   * 如果只解析 data 而不看 ok，就会把「服务暂时不可用」误判为
   * 「没有找到房源」，进而给用户"请调整搜索条件"这种**错误且误导**的提示。
   */
  apiError: string | null;
}

export class BeikeResponseParser {
  private readonly logger = new Logger(BeikeResponseParser.name);

  /**
   * 解析 CLI 的 stdout。
   *
   * @param stdout CLI 输出的原始文本（可能是单行 JSON，也可能是多行文本）
   */
  parse(stdout: string): ParsedBeikeResponse {
    const empty: ParsedBeikeResponse = {
      entities: [],
      overview: {
        totalRecalled: null,
        displayedCount: null,
        matchedConditions: [],
        unixId: null,
      },
      rawData: stdout,
      apiError: null,
    };

    if (!stdout || stdout.trim().length === 0) return empty;

    // ---- 第一层：CLI 默认输出单行 JSON {"data": "...", "ok": true} ----
    // 但 --pretty 模式下是纯文本，因此两种都要兼容。
    let payload = stdout.trim();
    let envelope: { data?: unknown; ok?: unknown; error?: unknown } | null = null;

    // 尝试找到最外层的 JSON 对象
    const firstBrace = payload.indexOf('{');
    if (firstBrace >= 0) {
      // 用括号配对找到完整的最外层对象，避免被内部的 } 干扰
      const end = this.findMatchingBrace(payload, firstBrace);
      if (end > firstBrace) {
        try {
          envelope = JSON.parse(payload.slice(firstBrace, end + 1)) as {
            data?: unknown;
            ok?: unknown;
            error?: unknown;
          };
        } catch {
          envelope = null;
        }
      }
    }

    // ---- 识别贝壳的业务错误 ----
    // 形式一：{"error": "service temporarily unavailable", "ok": false}
    // 形式二：{"data": "<参考数据>…【召回说明】- city_id is required", "ok": true}
    let apiError: string | null = null;

    if (envelope && envelope.ok === false) {
      apiError =
        typeof envelope.error === 'string' && envelope.error.length > 0
          ? envelope.error
          : '贝壳返回 ok=false';
      this.logger.warn(`贝壳返回业务错误：${apiError}`);
    }

    const data =
      envelope && typeof envelope.data === 'string'
        ? envelope.data
        : payload; // --pretty 或解析失败时，直接把全文当数据体

    // 从数据体里识别"召回说明"中的错误（贝壳把某些错误写在正文里）
    if (!apiError) {
      const recallNoteMatch = /【召回说明】\s*-?\s*([^\n【]{2,80})/.exec(data);
      if (recallNoteMatch?.[1]) {
        const note = recallNoteMatch[1].trim();
        // 只要不是"正常"类说明，就当成错误上报
        if (note.length > 0 && !/^(无|正常|ok)$/i.test(note)) {
          apiError = note;
          this.logger.warn(`贝壳召回说明提示错误：${apiError}`);
        }
      }
    }

    // ---- 第二层：解析数据体中的实体块 ----
    const entities = this.extractEntities(data);
    const overview = this.extractOverview(data);

    // 只有"确实没有实体、也没有错误"时才提示格式问题
    if (entities.length === 0 && data.length > 200 && !apiError) {
      this.logger.warn(
        `未从响应中解析出实体（响应长度 ${data.length}）。可能是格式变化或检索无结果。` +
          `响应开头：${data.slice(0, 200).replace(/\n/g, ' ')}`,
      );
    }

    return { entities, overview, rawData: data, apiError };
  }

  /**
   * 找出与起始大括号配对的收尾大括号位置。
   * 需要考虑字符串内的括号，否则会被 JSON 内容里的括号干扰。
   */
  private findMatchingBrace(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  // -------------------------------------------------------------------------
  // 实体提取
  // -------------------------------------------------------------------------

  /**
   * 提取实体块。
   *
   * 关键难点：响应是**多层嵌套**的标签结构：
   *
   *   <参考数据>
   *     <贝壳召回知识>
   *       <房源>                        ← 分类容器
   *         <107112596630>             ← 实体（标签名就是实体 ID）
   *         {...JSON...}
   *         </107112596630>
   *       </房源>
   *     </贝壳召回知识>
   *     <metadata>{...}</metadata>     ← 元信息，不是实体
   *   </参考数据>
   *
   * 踩过的坑：最初用一个通用正则 /<([^<>\n]{1,60})>\s*\n([\s\S]*?)\n\s*<\/\1>/g
   * 去匹配所有标签，结果它优先匹配到最外层 <参考数据>，
   * 但反向引用 \1 要求 </参考数据> 紧跟在内容之后，而实际后面还有 </metadata>，
   * 于是整个匹配失败，最后只匹配到了独立的 <metadata> —— 导致 0 条房源被识别。
   *
   * 正确做法：**分层处理**
   *   1. 先找出所有分类容器（<房源> / <小区> / <新房> / <学校>）的边界
   *   2. 只在容器内部匹配「标签名 = 实体 ID」的块
   *   3. 容器外的独立标签（如 metadata）按名称黑名单排除
   */
  private extractEntities(data: string): ParsedEntity[] {
    const entities: ParsedEntity[] = [];

    /** 分类容器：这些标签内部才是实体 */
    const CONTAINER_TAGS = ['房源', '新房', '小区', '学校', '板块', '商圈'] as const;

    /** 需要显式排除的非实体标签 */
    const EXCLUDED_TAGS = new Set([
      '参考数据',
      '数据查询',
      '贝壳召回知识',
      '联网知识',
      'metadata',
      '卡片依赖的实体id信息',
      '参考信息',
    ]);

    // ---- 第 1 步：提取每个容器的内容区间 ----
    const containerRanges: Array<{ tag: string; start: number; end: number }> = [];

    for (const containerTag of CONTAINER_TAGS) {
      const openToken = `<${containerTag}>`;
      const closeToken = `</${containerTag}>`;

      let searchFrom = 0;
      while (searchFrom < data.length) {
        const start = data.indexOf(openToken, searchFrom);
        if (start < 0) break;

        const end = data.indexOf(closeToken, start);
        if (end < 0) break;

        containerRanges.push({
          tag: containerTag,
          start: start + openToken.length,
          end,
        });
        searchFrom = end + closeToken.length;
      }
    }

    // ---- 第 2 步：在容器内部匹配实体 ----
    // 实体标签的特征：标签名之后紧跟换行，然后是 JSON 内容。
    // 用「内容中不含 < 字符」来保证匹配的是最内层标签，避免再次踩嵌套的坑。
    const entityPattern = /<([^<>\n/][^<>\n]{0,60}?)>\n+\s*([\s\S]*?)\n+\s*<\/\1>/g;

    const seenIds = new Set<string>();

    const collectFrom = (text: string, containerTag: string): void => {
      entityPattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = entityPattern.exec(text)) !== null) {
        const tagName = (match[1] ?? '').trim();
        const body = match[2] ?? '';

        // 排除容器名、已知非实体标签、以及「本身是容器」的标签
        if (!tagName) continue;
        if (EXCLUDED_TAGS.has(tagName)) continue;
        if ((CONTAINER_TAGS as readonly string[]).includes(tagName)) continue;

        // 内容里还有标签说明这是嵌套容器，跳过（只取最内层）
        if (/<[^<>\n]{1,60}>/.test(body)) continue;

        // 必须含 JSON，否则不是数据实体
        const jsonObjects = this.parseJsonLines(body);
        if (jsonObjects.length === 0) continue;

        // 同一实体可能在多个容器里出现（如小区信息与房源信息同时返回），去重
        const uniqueKey = `${containerTag}:${tagName}`;
        if (seenIds.has(uniqueKey)) continue;
        seenIds.add(uniqueKey);

        const fields = this.mergeJsonObjects(jsonObjects);

        entities.push({
          id: tagName,
          kind: this.detectEntityKind(fields, tagName, containerTag),
          fields,
          rawText: body.slice(0, 8000),
        });
      }
    };

    // 先在容器内匹配
    for (const range of containerRanges) {
      collectFrom(data.slice(range.start, range.end), range.tag);
    }

    // ---- 第 3 步：兜底 ----
    // 若响应没有容器标签（格式变化或 --pretty 输出），
    // 就对全文做一次实体匹配（此时嵌套由「内容不含标签」这一条保证正确性）
    if (entities.length === 0) {
      collectFrom(data, 'unknown');
    }

    return entities;
  }

  /** 逐行尝试解析 JSON；一个实体块里通常有多个并列的 JSON 对象 */
  private parseJsonLines(text: string): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];

    // 先按行尝试（贝壳是每行一个 JSON）
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          results.push(parsed as Record<string, unknown>);
        }
      } catch {
        // 单行解析失败：可能是被换行拆开的 JSON，交给下面的整体扫描
      }
    }

    if (results.length > 0) return results;

    // 兜底：块内 JSON 被换行拆开时（--pretty 或长内容），扫描所有顶层对象
    let index = 0;
    while (index < text.length) {
      const start = text.indexOf('{', index);
      if (start < 0) break;
      const end = this.findMatchingBrace(text, start);
      if (end < 0) break;
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          results.push(parsed as Record<string, unknown>);
        }
      } catch {
        // 忽略无法解析的片段
      }
      index = end + 1;
    }

    return results;
  }

  /**
   * 把多个 JSON 对象合并成一个扁平结构。
   *
   * 贝壳有**两种字段结构**，必须同时支持：
   *
   *   A. 搜索接口（摘要）—— 值都是长字符串，关键数据嵌在文本里：
   *      {"摘要信息": {
   *         "价格信息": "总价510万，单价约42000元/平米",
   *         "户型信息": "3室2厅1厨2卫，建筑面积122㎡，使用面积102㎡，朝向南",
   *         "区位交通": "位于浦东高行板块华高苑北区小区，距离杨高北路(地铁站)地铁站步行距离1008米",
   *         "小区信息": "华高苑北区(小区ID:50000000095768)，1998年建成(楼龄28年)，板楼，272户",
   *         "学区信息": "招生范围内上海市浦东新区建平实验小学(枣庄校区)(二梯队)",
   *         "房源所在楼层信息": "中楼层，总楼层共5层"
   *      }}
   *
   *   B. 详情接口 —— 扁平的结构化字段：
   *      {"基础信息": {"总价": "510万", "建筑面积": "122㎡", "房型": "3室2厅1厨2卫", ...}}
   *
   * 处理策略：先合并所有来源（扁平字段直接提升到顶层），
   * 再对「摘要信息」等长文本做**分段解析**，抽出其中的关键数值，
   * 最后让两种来源的字段在同一个命名空间下共存 —— 扁平字段优先（更精确）。
   */
  private mergeJsonObjects(objects: Array<Record<string, unknown>>): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    /** 收集所有长文本字段，稍后做分段解析 */
    const summaryTexts: string[] = [];

    for (const object of objects) {
      for (const [key, value] of Object.entries(object)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
            // 摘要类字段统一收集，不直接放进 merged（避免与扁平字段混淆）
            if (typeof innerValue === 'string' && this.isSummaryField(innerKey)) {
              summaryTexts.push(innerValue);
              continue;
            }
            if (!(innerKey in merged)) merged[innerKey] = innerValue;
          }
        } else if (typeof value === 'string' && this.isSummaryField(key)) {
          summaryTexts.push(value);
        } else if (!(key in merged)) {
          merged[key] = value;
        }
      }
    }

    // 从摘要文本中提取结构化字段（不覆盖已有的扁平字段，扁平字段更精确）
    if (summaryTexts.length > 0) {
      const extracted = this.extractFromSummaryTexts(summaryTexts);
      for (const [key, value] of Object.entries(extracted)) {
        if (!(key in merged) || merged[key] === null || merged[key] === undefined) {
          merged[key] = value;
        }
      }
    }

    return merged;
  }

  /** 判断是否为「需要二次解析的长文本」字段 */
  private isSummaryField(key: string): boolean {
    return (
      key === '摘要信息' ||
      key === '价格信息' ||
      key === '户型信息' ||
      key === '区位交通' ||
      key === '小区信息' ||
      key === '交易信息' ||
      key === '学区信息' ||
      key === '教育资源' ||
      key === '楼盘信息' ||
      key === '楼盘环境' ||
      key === '房源所在楼层信息' ||
      key === '房源亮点' ||
      key === '房源售卖状态'
    );
  }
  /**
   * 从摘要长文本中抽取结构化字段。
   *
   * 这些文本的格式是「标签+数值」用中文逗号连接，例如：
   *   "总价510万，单价约42000元/平米"
   *   "3室2厅1厨2卫，建筑面积122㎡，使用面积102㎡，得房率暂无，朝向南"
   *   "位于浦东高行板块华高苑北区小区，距离杨高北路(地铁站)地铁站步行距离1008米，步行约15分钟"
   *   "华高苑北区(小区ID:50000000095768)，1998年建成(楼龄28年)，板楼，272户，绿化率35%"
   *
   * 因此按逗号切段，再对每段做模式匹配。
   */
  private extractFromSummaryTexts(texts: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const combined = texts.join('，');
    const segments = combined
      .split(/[，,]/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    // ---- 逐个模式匹配 ----
    // 注意：这些正则的意图是"从自然语言里抽数值"，
    // 因此宁可宽松（可能多抽）也不要严格（漏抽导致整个房源被跳过）

    // 总价。贝壳的字段格式发生过变化，必须同时兼容多种写法：
    //   "总价510万"                              —— 详情接口 / 早期搜索接口
    //   "成交价格550万，挂牌价格580万"            —— 当前搜索接口（成交价 ≠ 挂牌价！）
    //   "参考总价约4500万；价格范围:总价2720-7289万" —— 新房楼盘
    //
    // 业务优先级：**挂牌价才是客户能买到的价格**，因此挂牌价优先于成交价。
    const listingPriceMatch = /挂牌价格\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*万/.exec(combined);
    const dealtPriceMatch = /成交价格\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*万/.exec(combined);
    const plainTotalMatch = /总价\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*万/.exec(combined);

    if (listingPriceMatch?.[1]) {
      result['总价'] = `${listingPriceMatch[1]}万`;
      // 记录成交价，供后续"成交价 vs 挂牌价"分析（议价空间）
      if (dealtPriceMatch?.[1]) result['成交价'] = `${dealtPriceMatch[1]}万`;
    } else if (plainTotalMatch?.[1]) {
      result['总价'] = `${plainTotalMatch[1]}万`;
      if (dealtPriceMatch?.[1]) result['成交价'] = `${dealtPriceMatch[1]}万`;
    } else if (dealtPriceMatch?.[1]) {
      // 只有成交价时兜底使用（并标注来源，避免误当成挂牌价）
      result['总价'] = `${dealtPriceMatch[1]}万`;
      result['价格为成交价'] = true;
    }

    // 单价："单价约42000元/平米" / "参考单价180000元/平米"
    const unitPriceMatch = /(?:参考)?单价\s*(?:约)?\s*(\d{4,7})\s*元/.exec(combined);
    if (unitPriceMatch?.[1]) result['单价'] = `${unitPriceMatch[1]}元/平米`;

    /**
     * 户型："3室2厅1厨2卫" / "3室2厅" / "3室1厅"
     *
     * ⚠️ 踩过的坑（真实事故，导致厦门房源全部被判"户型不符"）：
     *
     * 原正则强制要求"卫"存在：
     *   /(\d+)室(\d+)厅(?:(\d+)厨)?(\d+)卫/
     *
     * 但**贝壳返回的户型信息格式因城市而异**：
     *   上海：「3室2厅1厨2卫，建筑面积122㎡」（有"卫"）→ 匹配成功
     *   厦门：「3室2厅，建筑面积125㎡」（**无"卫"**）→ 匹配失败
     *
     * 后果：厦门房源的 bedrooms 全部为 null →
     * 硬筛判定"户型不符" → **10 套候选全部被拒** →
     * 客户看到"贝壳找到 604 套房源，但没有一套满足硬性条件"，
     * 而实际上这些房源正是三房、价格也在预算内。
     *
     * 修法：把"厨/卫"都改为可选。户型的最小充分信息是「X室Y厅」——
     * 只要这两个在，就能判断户型是否匹配；厨卫数量缺失不影响筛选。
     */
    const layoutMatch =
      /(\d{1,2})\s*室\s*(\d{1,2})\s*厅(?:\s*\d{1,2}\s*厨)?(?:\s*\d{1,2}\s*卫)?/.exec(combined);
    if (layoutMatch?.[0]) result['房型'] = layoutMatch[0].replace(/\s/g, '');

    // 只有"X室"没有"厅"的写法（如"3室，建筑面积92㎡"）也要能识别
    if (!result['房型']) {
      const bedroomsOnly = /(\d{1,2})\s*室/.exec(combined);
      if (bedroomsOnly?.[0]) result['房型'] = bedroomsOnly[0].replace(/\s/g, '');
    }

    // 建筑面积："建筑面积122㎡"
    const buildAreaMatch = /建筑面积\s*(\d+(?:\.\d+)?)\s*(?:㎡|平米|平方米)/.exec(combined);
    if (buildAreaMatch?.[1]) result['建筑面积'] = `${buildAreaMatch[1]}㎡`;

    // 朝向："朝向南" 或 "朝向东南"
    const orientationMatch = /朝向\s*([东南西北]{1,4})/.exec(combined);
    if (orientationMatch?.[1]) result['朝向'] = orientationMatch[1];

    // 楼层："中楼层，总楼层共5层"
    const floorLevelMatch = /(低|中|高|顶)楼层/.exec(combined);
    if (floorLevelMatch?.[1]) result['房源所属楼层'] = `${floorLevelMatch[1]}楼层`;

    const totalFloorsMatch = /总楼层共\s*(\d{1,3})\s*层/.exec(combined);
    if (totalFloorsMatch?.[1]) result['单元总楼层'] = `${totalFloorsMatch[1]}层`;

    // 小区名："位于浦东高行板块华高苑北区小区" 或 "华高苑北区(小区ID:...)"
    const communityFromId = /([\u4e00-\u9fffA-Za-z0-9·]{2,30}?)\s*\(小区ID[:：]/.exec(combined);
    if (communityFromId?.[1]) {
      result['小区名称'] = communityFromId[1].trim();
    } else {
      const communityFromLocation = /位于[^，,]*?板块([\u4e00-\u9fffA-Za-z0-9·]{2,30}?)小区/.exec(combined);
      if (communityFromLocation?.[1]) result['小区名称'] = communityFromLocation[1].trim();
    }

    // 城区与商圈："位于浦东张江板块张江汤臣豪园(四期)小区"
    //
    // 这个正则做了两件事：
    //   1. 行政区用**非贪婪**匹配并配合"板块"锚点，
    //      这样"浦东张江"会被正确切成 district=浦东、businessArea=张江。
    //   2. 贝壳的详情接口不含区县字段，这里是拿到行政区的唯一途径 ——
    //      早期实现漏了它，导致大量房源 district 为空。
    //
    // 踩过的坑：写成 ([\u4e00-\u9fff]{2,4}?)([\u4e00-\u9fff]{2,6}?)板块 时，
    // 遇到"位于浦东新区张江板块"会切成 district=浦东、businessArea=新区张江 ——
    // 因为正则优先满足"最短的区名"，把"新区"推给了板块。
    // 修正方式：显式优先匹配带"新区/区/县"后缀的行政区全称。
    const districtMatch =
      /位于\s*([\u4e00-\u9fff]{2,4}(?:新区|区|县))([\u4e00-\u9fff]{2,6}?)板块/.exec(combined) ??
      /位于\s*([\u4e00-\u9fff]{2,4}?)([\u4e00-\u9fff]{2,6}?)板块/.exec(combined);

    if (districtMatch?.[1]) result['所属城区'] = districtMatch[1];
    if (districtMatch?.[2]) result['所属商圈'] = districtMatch[2];

    // 兜底：只写了"位于浦东新区XX路"而没有"板块"二字时，单独抓行政区
    if (!result['所属城区']) {
      const districtOnly = /位于\s*([\u4e00-\u9fff]{2,4}(?:新区|区|县))/.exec(combined);
      if (districtOnly?.[1]) result['所属城区'] = districtOnly[1];
    }

    // 建成年代与楼龄："1998年建成(楼龄28年)"
    const buildYearMatch = /(19\d{2}|20\d{2})\s*年建成/.exec(combined);
    if (buildYearMatch?.[1]) result['建成年代'] = `${buildYearMatch[1]}年`;

    const ageMatch = /楼龄\s*(\d{1,3})\s*年/.exec(combined);
    if (ageMatch?.[1]) result['楼龄'] = `${ageMatch[1]}年`;

    // 地铁距离："距离杨高北路(地铁站)地铁站步行距离1008米"
    const subwayMatch = /距离([^，,]*?)(?:\(地铁站\))?地铁站步行距离\s*(\d+)\s*米/.exec(combined);
    if (subwayMatch?.[1] && subwayMatch[2]) {
      result['周边交通'] = [
        `距离${subwayMatch[1]}(地铁站)地铁站步行距离${subwayMatch[2]}米`,
      ];
    }

    // 学区："招生范围内上海市浦东新区建平实验小学(枣庄校区)(二梯队)"
    const schoolMatch = /招生范围内([^，,]+)/.exec(combined);
    if (schoolMatch?.[1]) result['学区信息'] = `招生范围内${schoolMatch[1]}`;

    // 房源亮点 → 标签
    const highlightTexts = texts.filter((text) => text.includes('/') && !text.includes('总价'));
    if (highlightTexts.length > 0) {
      result['标签'] = highlightTexts.join('/');
    }

    // 售卖状态
    const statusMatch = /(在售|已成交|已下架|暂缓|已下定)/.exec(combined);
    if (statusMatch?.[1]) result['房源售卖状态'] = statusMatch[1];

    // 产权年限："70年产权"
    const ownershipYears = /(\d{2,3})\s*年产权/.exec(combined);
    if (ownershipYears?.[1]) result['产权年限'] = `${ownershipYears[1]}年`;

    return result;
  }

  /**
   * 判断实体类型。
   *
   * 优先用容器标签（最可靠），其次用字段特征，最后用标签名形态兜底。
   */
  private detectEntityKind(
    fields: Record<string, unknown>,
    tagName: string,
    containerTag?: string,
  ): ParsedEntity['kind'] {
    // 容器标签是最权威的信号
    if (containerTag === '房源') return 'house';
    if (containerTag === '新房') return 'newhouse';
    if (containerTag === '小区') return 'resblock';
    if (containerTag === '学校') return 'school';

    // 字段特征判断
    if ('房型' in fields || '房源标题' in fields || '房源ID' in fields) return 'house';
    if ('楼盘名称' in fields || '楼盘ID' in fields) return 'newhouse';
    if ('小区名称' in fields || '小区ID' in fields) return 'resblock';
    if ('学校名称' in fields || '办学性质' in fields) return 'school';

    // 标签名是纯数字 → 二手房房源（贝壳的房源 ID 是长数字）
    if (/^\d{6,}$/.test(tagName)) return 'house';

    return 'unknown';
  }

  // -------------------------------------------------------------------------
  // 检索概览
  // -------------------------------------------------------------------------

  /** 提取检索概览（总召回数、生效条件） */
  private extractOverview(data: string): SearchOverview {
    const overview: SearchOverview = {
      totalRecalled: null,
      displayedCount: null,
      matchedConditions: [],
      unixId: null,
    };

    const totalMatch = /总召回结果数[：:]\s*(\d+)/.exec(data);
    if (totalMatch?.[1]) overview.totalRecalled = Number(totalMatch[1]);

    const displayMatch = /推荐展示数量[^：:]*[：:]\s*(\d+)/.exec(data);
    if (displayMatch?.[1]) overview.displayedCount = Number(displayMatch[1]);

    // 命中的检索条件是嵌入的 JSON 数组
    const conditionsMatch = /【本次实际命中的检索条件】\s*\n(\[[\s\S]*?\n\])/.exec(data);
    if (conditionsMatch?.[1]) {
      try {
        const parsed = JSON.parse(conditionsMatch[1]) as Array<Record<string, unknown>>;
        overview.matchedConditions = parsed.map((item) => ({
          query: String(item['查询条件'] ?? ''),
          condition: String(item['检索条件'] ?? ''),
          matchType:
            item['match_type'] === 'EXACT'
              ? 'EXACT'
              : item['match_type'] === 'LIKE'
                ? 'LIKE'
                : 'UNKNOWN',
        }));
      } catch {
        // 条件解析失败不影响主体
      }
    }

    const unixIdMatch = /"unix_id"\s*:\s*"([^"]+)"/.exec(data);
    if (unixIdMatch?.[1]) overview.unixId = unixIdMatch[1];

    return overview;
  }
}

// ---------------------------------------------------------------------------
// 字段映射：贝壳中文字段 → NormalizedProperty
// ---------------------------------------------------------------------------

export class BeikeFieldMapper {
  private readonly logger = new Logger(BeikeFieldMapper.name);

  /**
   * 把解析出的实体映射为统一的 NormalizedProperty。
   *
   * 单位换算与语义映射是这里最容易出错的地方，因此每个提取函数都单独实现并容错：
   *   - "510万" → 5100000（元）
   *   - "约42000元/平米" → 42000
   *   - "122㎡" → 122
   *   - "3室2厅1厨2卫" → bedrooms=3, livingRooms=2, bathrooms=2
   *   - "中楼层" + "5层" → floor 推算
   */
  mapEntity(entity: ParsedEntity, context: { city: string }): NormalizedProperty | null {
    const f = entity.fields;

    // 价格字段名在两种响应结构里完全不同，必须都支持：
    //   搜索接口：价格信息 = "成交价格550万，挂牌价格580万"  → 由摘要解析器抽出「总价」
    //   详情接口：挂牌价格 = "580万"                        → 直接就是字段
    // 业务优先级：挂牌价（客户能买到的价）> 总价 > 成交价
    const totalPrice =
      this.parsePrice(f['挂牌价格']) ??
      this.parsePrice(f['总价']) ??
      this.parsePrice(f['成交价格']);

    const area = this.parseArea(f['建筑面积']);

    // 关键字段缺失时无法入库（否则会污染匹配结果）
    if (totalPrice === null || area === null) {
      this.logger.warn(
        `房源 ${entity.id} 缺少关键字段` +
          `（挂牌价=${String(f['挂牌价格'])}，总价=${String(f['总价'])}，面积=${String(f['建筑面积'])}），跳过`,
      );
      return null;
    }

    const layout = this.parseLayout(f['房型']);
    const unitPrice = this.parseUnitPrice(f['单价']) ?? Math.round(totalPrice / area);

    const resblockInfo = this.extractResblockFields(f);

    return {
      externalProvider: 'BEIKE' as NormalizedProperty['externalProvider'],
      externalId: entity.id,
      // 保留原始字段，便于追溯与后续补充映射
      rawData: {
        source: 'BEIKE_MCP_CLI',
        fetchedAt: new Date().toISOString(),
        fields: f,
      },

      city: context.city,
      // 行政区可能确实拿不到（贝壳部分响应不含该字段）。
      // 这时宁可留空也不要塞占位符 —— 占位符会污染数据，
      // 让后续"按区域过滤"和"区域匹配打分"都失去意义。
      // 界面层负责把空值显示为"区域待确认"。
      district: resblockInfo.district ?? '',
      subDistrict: resblockInfo.businessArea,
      community: resblockInfo.name ?? this.extractCommunityFromTitle(String(f['房源标题'] ?? '')),
      title: String(f['房源标题'] ?? '').trim() || `贝壳房源 ${entity.id}`,
      address: resblockInfo.address,
      longitude: resblockInfo.longitude,
      latitude: resblockInfo.latitude,

      totalPrice,
      unitPrice,

      bedrooms: layout.bedrooms ?? 0,
      livingRooms: layout.livingRooms ?? 0,
      bathrooms: layout.bathrooms ?? 0,
      area,

      floor: layout.floor ?? this.parseFloor(f['房源所属楼层'], f['单元总楼层']),
      totalFloors: this.parseTotalFloors(f['单元总楼层']),

      orientation: this.parseOrientation(String(f['朝向'] ?? '')),
      buildYear: resblockInfo.buildYear,
      propertyType: this.parsePropertyType(String(f['用途'] ?? '')),
      ownershipType: this.parseOwnership(String(f['交易权属'] ?? '')),
      decoration: this.parseDecoration(String(f['装修类型'] ?? '')),
      elevator: resblockInfo.hasElevator,

      subwayDistance: this.parseSubway(f['周边交通'])?.distanceMeters ?? null,
      subway: this.parseSubway(f['周边交通']),
      schoolInfo: this.parseSchool(f),

      tags: this.parseTags(f['标签']),
      images: this.parseImages(f),
      floorPlan: this.parseFloorPlanImages(f),
      description: this.buildDescription(f, resblockInfo),

      listingStatus: this.parseListingStatus(String(f['房源售卖状态'] ?? '')),
      listingDate: this.parseDateTime(f['挂牌时间']),
      lastPriceChange: null,
    };
  }

  // -------------------------------------------------------------------------
  // 数值与枚举解析
  // -------------------------------------------------------------------------

  /** "510万" / "5100000元" / "约4500万" → 元 */
  private parsePrice(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const text = String(value);

    const wanMatch = /(\d+(?:\.\d+)?)\s*万/.exec(text);
    if (wanMatch?.[1]) return Math.round(Number(wanMatch[1]) * 10_000);

    const yuanMatch = /(\d{6,9})/.exec(text);
    if (yuanMatch?.[1]) return Number(yuanMatch[1]);

    return null;
  }

  /** "约42000元/平米" → 42000 */
  private parseUnitPrice(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const match = /(\d{4,7})/.exec(String(value));
    return match?.[1] ? Number(match[1]) : null;
  }

  /** "122㎡" / "122平米" / "122.5" → 122.5 */
  private parseArea(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const text = String(value);

    const sqmMatch = /(\d{2,4}(?:\.\d{1,2})?)\s*(?:㎡|平米|平方米|平)/.exec(text);
    if (sqmMatch?.[1]) {
      const area = Number(sqmMatch[1]);
      return area > 5 && area < 2000 ? area : null;
    }

    const plainMatch = /^(\d{2,4}(?:\.\d{1,2})?)$/.exec(text.trim());
    if (plainMatch?.[1]) {
      const area = Number(plainMatch[1]);
      return area > 5 && area < 2000 ? area : null;
    }

    return null;
  }

  /**
   * 户型文本 → 结构化字段。
   *
   * 输入形如："3室2厅1厨2卫" / "3室2厅" / "3室1厅"
   *
   * 注意：**厨、卫都是可选的** —— 贝壳返回的格式因城市而异
   * （上海常带"1厨2卫"，厦门多为"3室2厅"）。
   * 只要"X室"在，就能判断户型是否匹配。
   */
  private parseLayout(value: unknown): {
    bedrooms: number | null;
    livingRooms: number | null;
    bathrooms: number | null;
    floor: number | null;
  } {
    if (!value) return { bedrooms: null, livingRooms: null, bathrooms: null, floor: null };
    const text = String(value);

    // 注意：厨房数不计入业务字段，但「1厨」会干扰匹配，
    // 因此用非捕获组把它排除掉
    const bedroomMatch = /(\d{1,2})\s*室/.exec(text);
    const livingMatch = /(\d{1,2})\s*厅/.exec(text);
    const bathMatch = /(\d{1,2})\s*卫/.exec(text);

    return {
      bedrooms: bedroomMatch?.[1] ? Number(bedroomMatch[1]) : null,
      livingRooms: livingMatch?.[1] ? Number(livingMatch[1]) : null,
      bathrooms: bathMatch?.[1] ? Number(bathMatch[1]) : null,
      floor: null,
    };
  }

  /** 中文楼层描述 + 总层数 → 具体楼层 */
  private parseFloor(floorText: unknown, totalFloorsText: unknown): number | null {
    const floorStr = String(floorText ?? '');
    const total = this.parseTotalFloors(totalFloorsText);

    // 直接给了数字
    const numeric = /(\d{1,3})\s*层/.exec(floorStr);
    if (numeric?.[1] && !/共/.test(floorStr)) {
      const value = Number(numeric[1]);
      // 如果是"共18层"这种，它不是所在楼层
      if (value >= 1 && value <= 200) return value;
    }

    if (!total) return null;

    // 中文描述换算
    if (floorStr.includes('地下')) return null;
    if (floorStr.includes('顶')) return total;
    if (floorStr.includes('低')) return Math.max(1, Math.round(total / 6));
    if (floorStr.includes('中')) return Math.max(1, Math.round(total / 2));
    if (floorStr.includes('高')) return Math.max(1, Math.round((total * 5) / 6));

    return null;
  }

  /** "5层" → 5 */
  private parseTotalFloors(value: unknown): number | null {
    if (!value) return null;
    const match = /(\d{1,3})/.exec(String(value));
    if (!match?.[1]) return null;
    const total = Number(match[1]);
    return total >= 1 && total <= 200 ? total : null;
  }

  private parseOrientation(value: string): Orientation | null {
    const text = value.replace(/\s/g, '');
    if (!text) return null;
    if (/南北|南\+北|南、北|南,北/.test(text)) return Orientation.SOUTH_NORTH;
    if (text.includes('东南')) return Orientation.SOUTHEAST;
    if (text.includes('西南')) return Orientation.SOUTHWEST;
    if (text.includes('东北')) return Orientation.NORTHEAST;
    if (text.includes('西北')) return Orientation.NORTHWEST;
    if (text.includes('南')) return Orientation.SOUTH;
    if (text.includes('北')) return Orientation.NORTH;
    if (text.includes('东')) return Orientation.EAST;
    if (text.includes('西')) return Orientation.WEST;
    return null;
  }

  private parseDecoration(value: string): Decoration | null {
    if (!value) return null;
    if (value.includes('豪')) return Decoration.LUXURY;
    if (value.includes('精')) return Decoration.FINE;
    if (value.includes('简')) return Decoration.SIMPLE;
    if (value.includes('毛坯') || value.includes('清水')) return Decoration.ROUGH;
    return null;
  }

  private parseOwnership(value: string): OwnershipType | null {
    if (!value) return null;
    // 贝壳可能返回多值，如"商品房/动迁安置房/使用权" → 取第一个
    const first = value.split(/[/、,，]/)[0]?.trim() ?? '';
    if (first.includes('商品房')) return OwnershipType.FREEHOLD;
    if (first.includes('房改') || first.includes('公房')) return OwnershipType.HOUSING_REFORM;
    if (first.includes('经济适用')) return OwnershipType.AFFORDABLE;
    if (first.includes('动迁') || first.includes('安置')) return OwnershipType.RELOCATION;
    if (first.includes('商业') || first.includes('商办')) return OwnershipType.COMMERCIAL;
    return null;
  }

  private parsePropertyType(value: string): PropertyType {
    if (value.includes('别墅')) return PropertyType.VILLA;
    if (value.includes('洋房') || value.includes('联排')) return PropertyType.TOWNHOUSE;
    if (value.includes('商铺')) return PropertyType.SHOP;
    if (value.includes('写字楼') || value.includes('办公')) return PropertyType.OFFICE;
    return PropertyType.APARTMENT;
  }

  /**
   * 解析售卖状态。
   *
   * 踩过的坑：贝壳搜索接口会返回**已成交/已过户**的房源（用于成交参考），
   * 早期实现没有识别"已过户"，导致它被默认判为"在售"，
   * 结果把已经卖掉、客户根本买不到的房子推荐给客户。
   * 这是严重的产品错误，因此这里必须完整覆盖贝壳的所有状态用词。
   */
  private parseListingStatus(value: string): ListingStatus {
    if (!value) return ListingStatus.ACTIVE;

    // 已成交类（优先级最高：宁可漏推，也不能把卖掉的房子推给客户）
    if (
      value.includes('成交') ||
      value.includes('已售') ||
      value.includes('已过户') ||
      value.includes('已签约') ||
      value.includes('已下定')
    ) {
      return value.includes('已下定') ? ListingStatus.PENDING : ListingStatus.SOLD;
    }

    if (value.includes('在售') || value.includes('挂牌中')) return ListingStatus.ACTIVE;
    if (value.includes('预定')) return ListingStatus.PENDING;
    if (value.includes('下架') || value.includes('撤')) return ListingStatus.DELISTED;
    if (value.includes('暂缓') || value.includes('停售')) return ListingStatus.SUSPENDED;

    return ListingStatus.ACTIVE;
  }

  private parseDateTime(value: unknown): string | null {
    if (!value) return null;
    const text = String(value);
    // "2025-04-13 13:04:32"
    const match = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!match) return null;
    const date = new Date(text.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * 解析「标签」字段。
   *
   * ⚠️ 这个字段名有误导性：它**不是纯标签列表**，而是
   * 「小区基础信息 + 房源标签」的合并文本。真实原文示例：
   *
   *   玉兰香苑(四期)(小区ID:5011102207585)，2008年建成(楼龄18年)，板楼/塔楼，
   *   2232户，容积率4.0，绿化率35%，物业费0.45元/平米/月，租售比2.43%，
   *   车位配比1:0.5(租车位车位600元/年)，刷卡门禁/有监控/封闭式小区/…/南北通透
   *
   * 关键结构（踩过坑才发现）：
   *   - **顶层分隔符是中文逗号 `，`**，不是 `/`
   *   - `/` 只是**同一信息块内部**的分隔符（"板楼/塔楼"、"刷卡门禁/有监控/…"）
   *   - 因此 `/` 和 `，` 混用时，无脑按 `/` 切分会把
   *     "物业费0.45元/平米/月" 切成 ["物业费0.45元","平米","月"]，
   *     把 "车位配比1:0.5(租车位车位600元/年)" 切成 […"(租车位车位600元","年)"]。
   *     这些碎片既无意义，又会在多个房源里重复出现，
   *     导致推荐卡片上出现「月」「年)」这类垃圾标签，并引发 React key 冲突。
   *
   * 正确做法：
   *   1. 先按 `，` 切分出信息块
   *   2. 逐个判断该块是"小区基础信息"还是"房源标签"
   *      （基础信息含 建成/户/容积率/绿化率/物业费/车位/租售比 等特征词）
   *   3. 只对**标签块**按 `/` 展开；基础信息整块保留为一条标签
   *      （它本身对经纪人有价值：楼龄、容积率、物业费都影响决策）
   */
  private parseTags(value: unknown): string[] {
    if (!value) return [];

    const text = String(value);

    /** 标签数量上限。真实数据最多见过 27 个（玉兰香苑四期），取 30 留余量 */
    const MAX_TAGS = 30;

    /** 合法的建筑类型 —— 它们是真实标签，不是解析碎片 */
    const BUILDING_TYPES = new Set(['板楼', '塔楼', '平房', '板塔结合', '多层', '高层', '小高层', '低层', '独栋']);

    /**
     * 单字标签白名单。
     *
     * 为什么需要：单字标签几乎都是解析碎片（"月""年"），
     * 但房产语境里有几个单字是**真实含义**的（如"东""南"朝向）。
     * 只放行白名单内的单字，其余一律丢弃。
     */
    const SINGLE_CHAR_WHITELIST = new Set(['东', '南', '西', '北', '中']);

    // ---- 第 1 步：按中文逗号切分信息块 ----
    const blocks = text
      .split(/[，,]/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);

    /**
     * 小区基础信息的特征词。
     *
     * 注意：这些词只用于判断**短块**是否为一条完整信息。
     * 不能无条件按它整块保留 —— 房源标签块里也可能出现
     * "不带车位"（末尾的标签）这类词，会把整段标签误判成小区信息而丢失。
     * 实测踩过：末尾标签块 "有监控/…/高性价比/适合刚改" 因含"不带车位"
     * 被当成信息块，再因超长被丢弃，导致所有标签消失。
     */
    const infoBlockPattern =
      /(小区ID|建成|楼龄|容积率|绿化率|物业费|车位配比|租售比|占地面积|建筑面积|楼栋|梯户|供暖|用水|用电|燃气)/;

    /** 纯噪声块：小区名 + 内部 ID，或仅有小区名 */
    const noisePattern = /^[\u4e00-\u9fffA-Za-z0-9()（）·\-]+\(小区ID[:：]/;

    /**
     * 短块的判定阈值。
     * 超过这个长度的块一定是多个标签用 `/` 连接，必须展开。
     * 实测最长的单条信息是 "车位配比1:0.4(租车位车位50元/月)"（23 字），
     * 取 24 留出余量。
     */
    const SHORT_BLOCK_MAX = 24;

    const result: string[] = [];

    for (const block of blocks) {
      // 去掉贝壳的内部 ID 标注："玉兰香苑(四期)(小区ID:5011102207585)" → "玉兰香苑(四期)"
      const withoutId = block.replace(/\(小区ID[:：][^)]*\)/g, '').trim();

      // 纯噪声块（只剩小区名/内部标注），对经纪人无意义
      if (noisePattern.test(block) && withoutId.length <= 20) continue;
      if (withoutId.length === 0) continue;

      // 榜单类信息（"唐镇捡漏榜-第2名"）是有价值的信号，原样保留
      if (/榜-第\d+名|榜单/.test(withoutId)) {
        result.push(withoutId);
        continue;
      }

      // ---- 短块 + 含基础信息特征 → 是一条完整信息，整块保留 ----
      // 这样 "物业费2.0元/平米/月" 才不会被切成碎片。
      if (withoutId.length <= SHORT_BLOCK_MAX && infoBlockPattern.test(withoutId)) {
        result.push(withoutId);
        continue;
      }

      // ---- 建筑类型块：多个类型合并为一条，避免占用多个标签位 ----
      // "板楼/塔楼" 合并成一条比拆成两条更有意义，也省下卡片空间。
      const buildingTypeTags = withoutId
        .split(/[/、|]/)
        .map((tag) => tag.trim())
        .filter((tag) => BUILDING_TYPES.has(tag));

      if (
        buildingTypeTags.length > 0 &&
        buildingTypeTags.length === withoutId.split(/[/、|]/).length
      ) {
        result.push(buildingTypeTags.join('/'));
        continue;
      }

      // ---- 其余情况：按 `/` 或其他分隔符展开为标签 ----
      // 长块即使含"车位"这类词也要展开（那是标签列表，不是一条信息）。
      for (const tag of withoutId.split(/[/、|]/)) {
        const trimmed = tag.trim();
        if (trimmed.length === 0 || trimmed.length > 20) continue;
        result.push(trimmed);
      }
    }

    // ---- 合并被 `/` 切断的括号内容 ----
    //
    // 踩过的坑：`车位配比1:1.2(租车位地下车位300元/月)` 里含 `/`，
    // 按 `/` 展开后会得到 "车位配比1:1.2(租车位地下车位300元" + "月)"，
    // 后者是个孤立的 "月)"，在卡片上毫无意义。
    // （这类块本应被上面的"短块整块保留"接住，但有些数据带更多前缀导致超长，
    //   所以这里必须兜底。）
    const balanced: string[] = [];
    for (const tag of result) {
      const previous = balanced[balanced.length - 1];

      // 上一段有未闭合的左括号，当前段以右括号结尾 → 拼回去
      if (
        previous !== undefined &&
        (previous.match(/\(/g)?.length ?? 0) > (previous.match(/\)/g)?.length ?? 0) &&
        /\)$/.test(tag)
      ) {
        balanced[balanced.length - 1] = `${previous}/${tag}`;
        continue;
      }

      balanced.push(tag);
    }

    // 去重 + 丢弃解析碎片
    const deduped = [...new Set(balanced)].filter(
      (tag) =>
        tag.length > 1 ||
        BUILDING_TYPES.has(tag) ||
        SINGLE_CHAR_WHITELIST.has(tag),
    );

    // 上限保护：真实数据最多见过 27 个标签（玉兰香苑四期），
    // 取 30 留余量，避免把真实标签截掉。
    if (deduped.length <= MAX_TAGS) return deduped;

    // 超限时优先保留房源标签（朝向/户型/装修等），
    // 小区基础信息（楼龄/容积率/物业费）价值较低，先舍弃。
    const propertyTags = deduped.filter((tag) => !infoBlockPattern.test(tag));
    const infoTags = deduped.filter((tag) => infoBlockPattern.test(tag));

    return [...infoTags, ...propertyTags].slice(0, MAX_TAGS);
  }

  // -------------------------------------------------------------------------
  // 周边信息解析
  // -------------------------------------------------------------------------

  /**
   * 从「周边交通」数组里找出最近的地铁站。
   * 数组元素形如："距离杨高北路(地铁站)地铁站步行距离1008米，步行约15分钟"
   */
  private parseSubway(value: unknown): SubwayInfo | null {
    if (!Array.isArray(value)) return null;

    let best: { distance: number; station: string | null; walkMinutes: number | null } | null = null;

    for (const item of value) {
      const text = String(item);
      if (!text.includes('地铁')) continue;

      const distanceMatch = /步行距离\s*(\d+)\s*米/.exec(text);
      if (!distanceMatch?.[1]) continue;

      const distance = Number(distanceMatch[1]);
      // 取最近的
      if (best && distance >= best.distance) continue;

      const stationMatch = /距离([^，,]*?)(?:\(地铁站\))?地铁站/.exec(text);
      const walkMatch = /步行约\s*(\d+)\s*分钟/.exec(text);

      best = {
        distance,
        station: stationMatch?.[1]?.replace(/\(地铁站\)/g, '').trim() ?? null,
        walkMinutes: walkMatch?.[1] ? Number(walkMatch[1]) : null,
      };
    }

    if (!best) return null;

    return {
      ...(best.station ? { station: best.station } : {}),
      distanceMeters: best.distance,
      ...(best.walkMinutes !== null ? { walkMinutes: best.walkMinutes } : {}),
    };
  }

  /**
   * 解析学区信息。
   *
   * 贝壳的学区数据有两个来源：
   *   1. 「学区信息」字段（搜索接口返回）："招生范围内上海市浦东新区建平实验小学(枣庄校区)(二梯队)"
   *   2. 「周边教育」数组（详情接口返回）：学校列表 + 步行距离
   *
   * 学校梯队（一梯队/二梯队/三梯队）是家长最关心的信息，必须保留。
   */
  private parseSchool(fields: Record<string, unknown>): SchoolInfo | null {
    const result: SchoolInfo = {};

    // 来源 1：明确的学区信息
    const districtInfo = fields['学区信息'];
    if (districtInfo) {
      const text = String(districtInfo);
      const tierMatch = /[（(]([一二三]梯队)[）)]/.exec(text);
      const schoolMatch = /招生范围内([^（(]+)/.exec(text);

      if (schoolMatch?.[1]) {
        const name = schoolMatch[1].trim();
        if (name.includes('小学')) result.primarySchool = name;
        else if (name.includes('中学') || name.includes('初中')) result.middleSchool = name;
        else result.primarySchool = name;
      }

      result.isKeySchool = Boolean(tierMatch);
      if (tierMatch?.[1]) {
        result.note = `学区梯队：${tierMatch[1]}（数据来源：贝壳）`;
      }
    }

    // 来源 2：周边教育列表（详情接口用这个，没有「学区信息」字段）
    // 元素形如："距离张江高科实验小学(藿香校区)步行距离824米，步行约12分钟"
    // 注意：小区周围有学校 ≠ 对口学区，因此只在没有明确学区信息时才作为参考填入，
    // 且必须标注来源，避免把"附近有学校"误导成"学区房"。
    const nearbyEducation = fields['周边教育'];
    if (Array.isArray(nearbyEducation)) {
      let fromNearby = false;

      for (const item of nearbyEducation) {
        const text = String(item);
        const nameMatch = /距离(.+?)步行距离/.exec(text);
        if (!nameMatch?.[1]) continue;
        const name = nameMatch[1].trim();

        if (name.includes('小学') && !result.primarySchool) {
          result.primarySchool = name;
          fromNearby = true;
        } else if ((name.includes('中学') || name.includes('初中')) && !result.middleSchool) {
          result.middleSchool = name;
          fromNearby = true;
        }
      }

      if (fromNearby && !result.note) {
        result.note = '周边学校（来源：贝壳周边教育，非对口学区，需向学校核实）';
      }
    }

    // 学位占用情况来自标签
    const tags = String(fields['标签'] ?? '');
    if (tags.includes('无学位')) result.seatOccupied = true;
    else if (tags.includes('有学位')) result.seatOccupied = false;

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * 提取小区层面的字段。
   *
   * 详情接口会同时返回小区信息与房源信息，小区字段（经纬度、建成年代、楼栋数）
   * 对匹配很有价值，因此这里统一抽取。
   */
  private extractResblockFields(fields: Record<string, unknown>): {
    name: string | null;
    district: string | null;
    businessArea: string | null;
    address: string | null;
    longitude: number | null;
    latitude: number | null;
    buildYear: number | null;
    hasElevator: boolean | null;
  } {
    // 经纬度："121.606885,31.285318"
    let longitude: number | null = null;
    let latitude: number | null = null;
    const coords = fields['小区经纬度'];
    if (coords) {
      const parts = String(coords).split(',');
      if (parts.length === 2) {
        const lng = Number(parts[0]);
        const lat = Number(parts[1]);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          longitude = lng;
          latitude = lat;
        }
      }
    }

    // 建成年代："1998年" 或 "1998"
    let buildYear: number | null = null;
    const yearMatch = /(19\d{2}|20\d{2})/.exec(String(fields['建成年代'] ?? ''));
    if (yearMatch?.[1]) {
      const year = Number(yearMatch[1]);
      if (year >= 1900 && year <= new Date().getFullYear() + 2) buildYear = year;
    }

    // 城区："浦东" → 补全为 "浦东新区"（贝壳返回的是简称）
    const rawDistrict = fields['所属城区'] ? String(fields['所属城区']).trim() : null;
    const district = rawDistrict ? this.normalizeDistrictName(rawDistrict) : null;

    // 电梯：从内部设施或标签推断
    let hasElevator: boolean | null = null;
    const facilities = String(fields['内部设施'] ?? '');
    const tags = String(fields['标签'] ?? '');
    if (facilities.includes('电梯') || tags.includes('电梯')) hasElevator = true;
    else if (tags.includes('步梯')) hasElevator = false;

    return {
      // 字段名在两种结构里不同：详情用「小区」，搜索用「小区名称」
      name: this.pickText(fields['小区名称'], fields['小区'], fields['楼盘名称']),
      district,
      // 详情用「商圈」，搜索用「所属商圈」
      businessArea: this.pickText(fields['所属商圈'], fields['商圈']),
      address: this.pickText(fields['地址']),
      longitude,
      latitude,
      buildYear,
      hasElevator,
    };
  }

  /** 依次尝试多个字段名，返回第一个非空文本（用于兼容两种响应结构） */
  private pickText(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  }

  /** 贝壳返回「浦东」这类简称，补全为标准行政区名 */
  private normalizeDistrictName(raw: string): string {
    if (raw.endsWith('区') || raw.endsWith('县')) return raw;

    const knownDistricts = [
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

    const matched = knownDistricts.find(
      (district) => district.startsWith(raw) || raw.startsWith(district.replace(/区$/, '')),
    );

    return matched ?? raw;
  }

  /** 从标题里推断小区名："华高苑北区 3室2厅 122㎡ 510万" → "华高苑北区" */
  private extractCommunityFromTitle(title: string): string {
    const match = /^([^\s\d]+(?:\s*[^\s\d]+)?)\s/.exec(title.trim());
    return match?.[1]?.trim() ?? title.trim().slice(0, 30);
  }

  // -------------------------------------------------------------------------
  // 图片
  // -------------------------------------------------------------------------

  /** 从「房源图片」对象里提取所有图片 */
  private parseImages(fields: Record<string, unknown>): PropertyImage[] {
    const images: PropertyImage[] = [];
    const imageData = fields['房源图片'];

    if (typeof imageData !== 'object' || imageData === null) return images;

    let sortOrder = 0;
    for (const [category, value] of Object.entries(imageData as Record<string, unknown>)) {
      // 值可能是单个 URL，也可能是 URL 数组
      const urls = Array.isArray(value) ? value : [value];

      for (const url of urls) {
        if (typeof url !== 'string' || !url.startsWith('http')) continue;
        images.push({
          url,
          category: this.mapImageCategory(category),
          sortOrder: sortOrder++,
          caption: category,
        });
      }
    }

    return images;
  }

  private parseFloorPlanImages(fields: Record<string, unknown>): string[] {
    const imageData = fields['房源图片'];
    if (typeof imageData !== 'object' || imageData === null) return [];

    const plan = (imageData as Record<string, unknown>)['户型图片'];
    if (!plan) return [];

    const urls = Array.isArray(plan) ? plan : [plan];
    return urls.filter((url): url is string => typeof url === 'string' && url.startsWith('http'));
  }

  private mapImageCategory(category: string): PropertyImage['category'] {
    if (category.includes('户型')) return 'FLOOR_PLAN';
    if (category.includes('小区') || category.includes('环境')) return 'COMMUNITY';
    if (category.includes('室内') || category.includes('卧室') || category.includes('客厅')) {
      return 'INTERIOR';
    }
    if (category.includes('外观') || category.includes('实景')) return 'EXTERIOR';
    return 'OTHER';
  }

  /**
   * 生成房源描述。
   *
   * 用贝壳的真实字段拼装，而不是照抄原始文本 ——
   * 后者包含大量对买家无意义的内部字段。
   */
  private buildDescription(
    fields: Record<string, unknown>,
    resblock: { name: string | null; buildYear: number | null },
  ): string | null {
    const parts: string[] = [];

    const layout = fields['房型'] ? String(fields['房型']) : null;
    const area = fields['建筑面积'] ? String(fields['建筑面积']) : null;
    const orientation = fields['朝向'] ? String(fields['朝向']) : null;
    const decoration = fields['装修类型'] ? String(fields['装修类型']) : null;
    const floor = fields['房源所属楼层'] ? String(fields['房源所属楼层']) : null;
    const ownership = fields['交易权属'] ? String(fields['交易权属']) : null;
    const years = fields['房源年限'] ? String(fields['房源年限']) : null;
    const ventilation = fields['通风情况'] ? String(fields['通风情况']) : null;

    if (layout || area) {
      parts.push(
        `【户型】${[layout, area, orientation, ventilation].filter(Boolean).join('，')}。`,
      );
    }
    if (decoration || floor) {
      parts.push(`【装修与楼层】${[decoration, floor].filter(Boolean).join('，')}。`);
    }
    if (ownership || years) {
      parts.push(`【产权】${[ownership, years].filter(Boolean).join('，')}。`);
    }
    if (resblock.name) {
      parts.push(
        `【小区】${resblock.name}${resblock.buildYear ? `，建成于 ${resblock.buildYear} 年` : ''}。`,
      );
    }

    // 周边配套摘要
    const surroundings = this.summarizeSurroundings(fields);
    if (surroundings) parts.push(surroundings);

    // 合规提示：数据来自贝壳，但条件可能未被完全覆盖
    parts.push('【数据来源】本房源信息来自贝壳开放平台，具体以实际带看为准。');

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** 把周边设施数组压缩成一段可读摘要 */
  private summarizeSurroundings(fields: Record<string, unknown>): string | null {
    const categories: Array<[string, string]> = [
      ['周边交通', '交通'],
      ['周边教育', '教育'],
      ['周边商业', '商业'],
      ['周边医疗', '医疗'],
    ];

    const summaries: string[] = [];
    for (const [key, label] of categories) {
      const value = fields[key];
      if (!Array.isArray(value) || value.length === 0) continue;

      // 取最近的两个
      const nearest = value
        .slice(0, 2)
        .map((item) => String(item).replace(/^距离/, '').replace(/步行约\d+分钟$/, '').trim())
        .filter((text) => text.length > 0);

      if (nearest.length > 0) summaries.push(`${label}：${nearest.join('；')}`);
    }

    return summaries.length > 0 ? `【周边配套】${summaries.join('。')}。` : null;
  }
}
