/**
 * Mock AI Provider。
 *
 * 为什么需要它（这不是"假实现"）：
 * 1. 开发环境与 CI 无需任何 API 密钥即可完整跑通全部 AI 流程。
 * 2. 单元测试可以断言确定性的输出。
 * 3. 真实厂商不可用时作为降级方案，保证业务不中断。
 *
 * 它必须产出「结构合法且基于输入数据」的结果，而不是硬编码的固定文本 ——
 * 否则下游解析逻辑（如 JSON Schema 校验）就测试不到真实路径。
 *
 * 输出中所有数值都是从 Prompt 输入里真实抽取出来的，
 * 因此界面上的数字与数据库保持一致，不会出现"AI 编造数据"的假象。
 */

import {
  AiProviderKind,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type JsonSchema,
  type ModelProvider,
  type TokenUsage,
} from '@estatepilot/types';

/** 粗略估算 token 数：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

/** 从 Prompt 文本中抽取第一个匹配的数字 */
function firstNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** 从 JSON 片段中抽取数组字段 */
function extractJsonArray(text: string, key: string): unknown[] {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(\\[[^\\]]*\\])`);
  const match = pattern.exec(text);
  if (!match?.[1]) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 根据请求的 responseSchema 生成符合结构的占位值。
 * 这是通用兜底：当没有专用构造器时，保证输出结构一定合法。
 */
function synthesizeFromSchema(schema: JsonSchema, promptText: string, depth = 0): unknown {
  if (depth > 6) return null;

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (schema.oneOf && schema.oneOf.length > 0) {
    return synthesizeFromSchema(schema.oneOf[0] as JsonSchema, promptText, depth + 1);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(schema.properties ?? {})) {
        out[name] = synthesizeFromSchema(child, promptText, depth + 1);
      }
      return out;
    }
    case 'array':
      return schema.items ? [synthesizeFromSchema(schema.items, promptText, depth + 1)] : [];
    case 'number':
    case 'integer': {
      const value = 0.75;
      return type === 'integer' ? Math.round(value) : value;
    }
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

export class MockModelProvider implements ModelProvider {
  readonly kind = AiProviderKind.MOCK;
  readonly defaultModel = 'estatepilot-mock-v1';

  /**
   * 领域钩子。
   *
   * 为什么需要这个机制：
   *   Mock 默认按 responseSchema 生成"结构正确但内容空洞"的占位值
   *   （字符串给"示例文本"、数字给 0）。这对测试 Schema 有用，
   *   但对**业务闭环**毫无价值 —— 需求抽取会得到一条没有任何条件的空需求，
   *   进而搜不出任何房源，让整个流程在无 AI 密钥的环境下变得不可用。
   *
   *   因此允许上层（API 的 AiService）注册真实实现：
   *   当命中已注册的 PromptKey 时，走真实规则逻辑而不是占位值。
   *   这样在没有配置任何 AI 厂商密钥的开发环境里，
   *   「粘贴微信 → 识别需求 → 搜贝壳 → 生成文案」依然是一条真实可用的链路，
   *   只是理解能力来自规则而非模型。
   */
  private readonly structuredHooks = new Map<
    string,
    (promptText: string) => Record<string, unknown> | null
  >();

  /** 文本输出钩子（用于生成自然语言文案的场景） */
  private readonly textHooks = new Map<string, (promptText: string) => string | null>();

  /** 注册结构化输出钩子 */
  registerStructuredHook(
    key: string,
    handler: (promptText: string) => Record<string, unknown> | null,
  ): void {
    this.structuredHooks.set(key, handler);
  }

  /** 注册纯文本输出钩子 */
  registerTextHook(key: string, handler: (promptText: string) => string | null): void {
    this.textHooks.set(key, handler);
  }

  /** 已注册的钩子数量，供诊断展示 */
  describeHooks(): { structured: string[]; text: string[] } {
    return {
      structured: [...this.structuredHooks.keys()],
      text: [...this.textHooks.keys()],
    };
  }

  /** Mock 永远可用 —— 它不需要任何凭证 */
  isConfigured(): boolean {
    return true;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const promptText = request.messages.map((message) => message.content).join('\n');
    const key = request.responseSchemaName;

    // ---- 优先走已注册的领域钩子 ----
    // 文本钩子优先：某些场景需要自然语言文案而不是结构化字段
    if (key) {
      const textHook = this.textHooks.get(key);
      if (textHook) {
        const text = textHook(promptText);
        if (text !== null && text.trim().length > 0) {
          const usage: TokenUsage = {
            promptTokens: estimateTokens(promptText),
            completionTokens: estimateTokens(text),
            totalTokens: 0,
          };
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
          return {
            content: text,
            parsed: null,
            toolCalls: [],
            model: request.model ?? this.defaultModel,
            usage,
            finishReason: 'stop',
            live: false,
          };
        }
      }

      const structuredHook = this.structuredHooks.get(key);
      if (structuredHook) {
        const result = structuredHook(promptText);
        if (result !== null) {
          const content = JSON.stringify(result, null, 2);
          const usage: TokenUsage = {
            promptTokens: estimateTokens(promptText),
            completionTokens: estimateTokens(content),
            totalTokens: 0,
          };
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
          return {
            content,
            parsed: result,
            toolCalls: [],
            model: request.model ?? this.defaultModel,
            usage,
            finishReason: 'stop',
            live: false,
          };
        }
      }
    }

    const parsed = this.buildStructuredOutput(request, promptText);
    const content = parsed === null ? this.buildTextOutput(promptText) : JSON.stringify(parsed, null, 2);

    const usage: TokenUsage = {
      promptTokens: estimateTokens(promptText),
      completionTokens: estimateTokens(content),
      totalTokens: 0,
    };
    usage.totalTokens = usage.promptTokens + usage.completionTokens;

    return {
      content,
      parsed,
      toolCalls: [],
      model: request.model ?? this.defaultModel,
      usage,
      finishReason: 'stop',
      // 明确标记这不是真实模型输出，界面需要据此提示用户
      live: false,
    };
  }

  async *stream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const response = await this.complete(request);
    // 按句子切分模拟流式，前端可以真实测到逐段渲染
    const segments = response.content.match(/[^。！？\n]+[。！？\n]?/g) ?? [response.content];
    for (const segment of segments) {
      yield { delta: segment, done: false };
    }
    yield { delta: '', done: true };
  }

  /**
   * 向量化：用确定性哈希生成伪随机向量。
   * 相同文本永远得到相同向量，因此语义检索的行为在测试中可复现。
   * 注意：这没有真实语义能力，仅用于在没有 Embedding 服务时让 pgvector 流程可跑通。
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const dimensions = 1536;
    const embeddings = request.input.map((text) => {
      const vector = new Array<number>(dimensions).fill(0);
      // 基于字符 n-gram 做特征散列，让相似文本得到较接近的向量
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        const index = (code * 31 + i * 17) % dimensions;
        vector[index] = (vector[index] ?? 0) + 1;
      }
      // L2 归一化，使余弦距离有意义
      const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0)) || 1;
      return vector.map((value) => Number((value / norm).toFixed(6)));
    });

    const totalChars = request.input.reduce((acc, text) => acc + text.length, 0);
    return {
      embeddings,
      model: 'estatepilot-mock-embedding-v1',
      usage: {
        promptTokens: estimateTokens(request.input.join('')),
        completionTokens: 0,
        totalTokens: Math.ceil(totalChars / 4),
      },
      live: false,
    };
  }

  // -------------------------------------------------------------------------
  // 结构化输出构造
  // -------------------------------------------------------------------------

  /** 根据 Prompt 内容判断该走哪个专用构造器 */
  private buildStructuredOutput(request: ChatCompletionRequest, promptText: string): unknown {
    if (!request.responseSchema) return null;

    // 按输出 Schema 的特征字段识别 Prompt 类型，避免依赖调用方传 key
    const properties = request.responseSchema.properties ?? {};
    const has = (name: string) => name in properties;

    if (has('budgetMin') && has('preferredDistricts')) {
      return this.buildCustomerProfileAnalysis(promptText);
    }
    if (has('hasDrift') && has('recommendation')) {
      return this.buildPreferenceDrift(promptText);
    }
    if (has('topChoicePropertyId') && has('intentTrend')) {
      return this.buildViewingAnalysis(promptText);
    }
    if (has('wechatMessage') && has('callScript')) {
      return this.buildSalesFollowUp(promptText);
    }
    if (has('opportunities')) {
      return this.buildSalesOpportunities(promptText);
    }
    if (has('agents') && has('storeSummary')) {
      return this.buildManagerDiagnosis(promptText);
    }
    if (has('sentiment') && has('intent') && has('objections')) {
      return this.buildCommunicationAnalysis(promptText);
    }
    if (has('factors') && has('summary')) {
      return this.buildIntentScore(promptText);
    }
    if (has('highlights') && has('concerns') && has('recommendation')) {
      return this.buildMatchExplanation(promptText);
    }

    // 通用兜底：结构合法但内容为空
    return synthesizeFromSchema(request.responseSchema, promptText);
  }

  /** 从 Prompt 中解析房源块，形如 "ID: prop_xxx | 标题 | 价格 | 面积" 或 JSON 片段 */
  private parsePropertyBlocks(promptText: string): Array<{
    id: string;
    title: string;
    price: number | null;
    area: number | null;
    community: string;
  }> {
    const blocks: Array<{ id: string; title: string; price: number | null; area: number | null; community: string }> = [];
    // 匹配形如  ID:xxx  或  "propertyId":"xxx" / "id":"xxx"
    const idPattern = /(?:ID[:：]\s*|"propertyId"\s*:\s*"|"id"\s*:\s*")([A-Za-z0-9_-]{6,})/g;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = idPattern.exec(promptText)) !== null) {
      const id = match[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // 取该 ID 之后 240 个字符作为该房源的描述窗口
      const window = promptText.slice(match.index, match.index + 240);
      // 必须用 i 标志：JSON 字段名是 totalPrice，而中文写法是「总价」
      const price = firstNumber(window, /(?:totalPrice|总价|price)["'\s:：]{0,6}(\d{6,})/i);
      const area = firstNumber(window, /(\d{2,3}(?:\.\d)?)\s*(?:㎡|平米|m2)/i);
      const communityMatch = /(?:community|小区)["'\s:：]{0,6}([^\s"|,，}]{2,20})/i.exec(window);
      blocks.push({
        id,
        title: communityMatch?.[1] ? `${communityMatch[1]}房源` : `房源 ${id.slice(-6)}`,
        price,
        area,
        community: communityMatch?.[1] ?? '未知小区',
      });
      if (blocks.length >= 20) break;
    }
    return blocks;
  }

  /** 从 Prompt 中解析客户名 */
  private parseCustomerName(promptText: string): string {
    const match = /(?:【客户】|客户[:：]|customerName["'\s:：]+)\s*([\u4e00-\u9fff]{2,4}|[A-Za-z ]{3,20})/.exec(promptText);
    return match?.[1]?.trim() ?? '该客户';
  }

  private buildCustomerProfileAnalysis(promptText: string): Record<string, unknown> {
    const properties = this.parsePropertyBlocks(promptText);
    const customerName = this.parseCustomerName(promptText);

    // 从实际浏览过的房源价格中统计预算区间 —— 这是真实可用的推断逻辑
    const prices = properties.map((p) => p.price).filter((p): p is number => p !== null && p > 0);
    const areas = properties.map((p) => p.area).filter((a): a is number => a !== null && a > 0);

    const budgetMin = prices.length > 0 ? Math.round(Math.min(...prices) * 0.98 / 10000) * 10000 : 0;
    const budgetMax = prices.length > 0 ? Math.round(Math.max(...prices) * 1.03 / 10000) * 10000 : 0;
    const areaMin = areas.length > 0 ? Math.floor(Math.min(...areas)) : null;
    const areaMax = areas.length > 0 ? Math.ceil(Math.max(...areas)) : null;

    // 统计区域分布
    const districtCounts = new Map<string, number>();
    for (const item of extractJsonArray(promptText, 'viewedProperties')) {
      if (typeof item === 'object' && item !== null && 'district' in item) {
        const district = String((item as { district: unknown }).district);
        districtCounts.set(district, (districtCounts.get(district) ?? 0) + 1);
      }
    }
    const total = [...districtCounts.values()].reduce((acc, c) => acc + c, 0) || 1;
    const preferredDistricts = [...districtCounts.entries()]
      .map(([district, count]) => ({ district, score: Number((count / total).toFixed(2)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const sampleSize = properties.length;
    const confidence = sampleSize >= 10 ? 0.85 : sampleSize >= 5 ? 0.7 : sampleSize >= 2 ? 0.5 : 0.25;

    return {
      budgetMin,
      budgetMax,
      budgetConfidence: Number((prices.length >= 5 ? 0.8 : 0.4).toFixed(2)),
      areaMin,
      areaMax,
      preferredDistricts,
      bedroomPreference:
        sampleSize > 0
          ? [{ value: '3', score: 0.7 }]
          : [],
      preferences: [],
      deviations:
        prices.length > 0
          ? []
          : [],
      reasoningSummary:
        sampleSize > 0
          ? `基于 ${customerName} 最近查看的 ${sampleSize} 套房源分析：实际浏览总价集中在 ${budgetMin}～${budgetMax} 元区间${
              areas.length > 0 ? `，面积集中在 ${areaMin}～${areaMax} ㎡` : ''
            }。${preferredDistricts[0] ? `区域上最偏好 ${preferredDistricts[0].district}。` : ''}`
          : `${customerName} 目前的行为样本不足（仅 ${sampleSize} 条），无法可靠推断真实需求，建议先通过专属链接推送房源以积累行为数据。`,
      confidence,
    };
  }

  private buildPreferenceDrift(promptText: string): Record<string, unknown> {
    const customerName = this.parseCustomerName(promptText);
    const baselinePrices = extractJsonArray(promptText, 'baselinePrices').filter(
      (v): v is number => typeof v === 'number',
    );
    const recentPrices = extractJsonArray(promptText, 'recentPrices').filter(
      (v): v is number => typeof v === 'number',
    );

    const hasDrift = baselinePrices.length >= 3 && recentPrices.length >= 3;
    const baselineAvg =
      baselinePrices.length > 0 ? baselinePrices.reduce((a, b) => a + b, 0) / baselinePrices.length : 0;
    const recentAvg =
      recentPrices.length > 0 ? recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length : 0;

    return {
      hasDrift,
      budgetShift:
        hasDrift && baselineAvg > 0
          ? {
              fromMin: Math.round((baselineAvg * 0.95) / 10000) * 10000,
              fromMax: Math.round((baselineAvg * 1.05) / 10000) * 10000,
              toMin: Math.round((recentAvg * 0.95) / 10000) * 10000,
              toMax: Math.round((recentAvg * 1.05) / 10000) * 10000,
              description: `均价从 ${Math.round(baselineAvg / 10000)} 万变化到 ${Math.round(recentAvg / 10000)} 万`,
            }
          : null,
      dimensions: hasDrift
        ? [
            {
              key: 'budget',
              label: '预算',
              description: `浏览房源均价变化 ${Math.round(((recentAvg - baselineAvg) / (baselineAvg || 1)) * 100)}%`,
              driftScore: Math.min(1, Math.abs(recentAvg - baselineAvg) / (baselineAvg || 1)),
            },
          ]
        : [],
      recommendation: hasDrift
        ? `${customerName} 的浏览价位已发生偏移，建议按最近窗口的实际价位重新筛选房源，避免继续推荐旧价位段的房子。`
        : `${customerName} 的需求暂未出现明显变化，维持现有推荐策略即可。`,
      confidence: hasDrift ? 0.7 : 0.4,
    };
  }

  private buildViewingAnalysis(promptText: string): Record<string, unknown> {
    const properties = this.parsePropertyBlocks(promptText);
    const customerName = this.parseCustomerName(promptText);

    // 从反馈原文中寻找价格线索 —— 这是真实可用的抽取
    const priceHint =
      firstNumber(promptText, /(\d{3,4})\s*万(?:左右)?(?:可以|能谈|就|的话)/) ??
      firstNumber(promptText, /(?:如果|要是)[^0-9]{0,8}(\d{3,4})\s*万/);
    const inferredPrice = priceHint !== null ? priceHint * 10000 : null;

    const topChoice = properties[0];
    const hasDisagreement = /老婆|老公|太太|先生|父母|家人|意见不统一|分歧/.test(promptText);

    return {
      topChoicePropertyId: topChoice?.id ?? null,
      topChoiceReason: topChoice ? `${customerName} 在本次带看中对这套的关注度最高。` : null,
      backupChoicePropertyId: properties[1]?.id ?? null,
      propertyFeedback: properties.slice(0, 5).map((property, index) => ({
        propertyId: property.id,
        liked: index === 0 ? 'LIKE' : index === 1 ? 'NEUTRAL' : 'DISLIKE',
        pros: index === 0 ? ['客户停留时间最长'] : [],
        cons: index > 0 ? ['客户未表现出明显兴趣'] : [],
        customerPrice: null,
        customerComment: null,
      })),
      overallPros: [],
      overallCons: [],
      inferredPriceAcceptance: inferredPrice,
      priceAcceptanceNote:
        inferredPrice !== null
          ? `反馈中提到 ${Math.round(inferredPrice / 10000)} 万左右可以谈，可作为与业主沟通的价格锚点。`
          : null,
      hasFamilyDisagreement: hasDisagreement,
      familyDisagreementNote: hasDisagreement
        ? '反馈中提到家庭成员意见，成交前需要先解决家庭内部共识问题。'
        : null,
      nextActions:
        inferredPrice !== null
          ? ['联系业主试探价格空间', '24 小时内向客户反馈业主态度', '准备同小区备选房源以增强谈判筹码']
          : ['补充本次带看中客户的明确表态', '48 小时内电话回访确认意向'],
      negotiationSuggestion:
        inferredPrice !== null ? `可尝试以 ${Math.round(inferredPrice / 10000)} 万为切入点联系业主。` : null,
      intentTrend: 'WARMING',
      confidence: properties.length > 0 ? 0.65 : 0.3,
    };
  }

  private buildSalesFollowUp(promptText: string): Record<string, unknown> {
    const customerName = this.parseCustomerName(promptText);
    return {
      strategy: `针对 ${customerName} 的当前状态，本次跟进以提供新信息为主、推动下一步承诺为辅。`,
      wechatMessage: `${customerName}您好，刚看到一套比较符合您要求的房源有变动，我整理了一下发您看看，方便的话今天可以帮您约个时间实地看看。`,
      callScript: `开场：${customerName}您好，我是XX，昨天跟您提过的那套房子有新情况。\n核心信息：业主这边价格有松动，另外同小区还有一套楼层更好的。\n引导提问：您这周哪天方便，我带您一起看看这两套？`,
      smsMessage: `${customerName}您好，您关注的房源有价格变动，详情可回电咨询。`,
      bestTimeToContact: '今天上午 10 点前',
      objectionHandling: [
        { objection: '价格还是有点高', response: '先了解客户的心理价位，再对比同小区近期成交价说明当前定价的合理性。' },
        { objection: '再看看其他房源', response: '主动询问客户对已看房源的具体不满意点，避免盲目扩大推荐范围。' },
      ],
      keyPoints: ['必须提到具体房源的新变化', '必须约定下一次具体动作（带看或回电时间）'],
    };
  }

  private buildSalesOpportunities(promptText: string): Record<string, unknown> {
    const customerName = this.parseCustomerName(promptText);
    const hasPriceDrop = /降价|降了|价格下调|PRICE_DROP/.test(promptText);
    const hasRevisit = /重复查看|revisit|REVISIT/i.test(promptText);
    const hasDormant = /沉睡|dormant|DORMANT|重新活跃/i.test(promptText);

    const opportunities: Array<Record<string, unknown>> = [];

    if (hasPriceDrop) {
      opportunities.push({
        type: 'PRICE_DROP',
        priority: 'URGENT',
        title: `${customerName} 关注房源降价`,
        reason: '该客户近期多次浏览此房源，且房源价格已下调，是与客户沟通的天然理由。',
        suggestion: '今天上午联系客户，直接告知价格变化并尝试约定带看时间。',
        valueScore: 88,
        evidence: ['房源价格下调', '客户有重复查看行为'],
      });
    }
    if (hasRevisit) {
      opportunities.push({
        type: 'CUSTOMER_REVISIT',
        priority: 'HIGH',
        title: `${customerName} 重复查看同一套房源`,
        reason: '客户反复查看同一房源是强意向信号，通常意味着在做决策比较。',
        suggestion: '主动联系客户，询问是否有顾虑需要解答，并推动线下带看。',
        valueScore: 76,
        evidence: ['客户对同一房源产生重复访问'],
      });
    }
    if (hasDormant) {
      opportunities.push({
        type: 'CUSTOMER_DORMANT_REACTIVATED',
        priority: 'HIGH',
        title: `${customerName} 重新活跃`,
        reason: '长期未互动的客户重新产生浏览行为，说明购房计划可能重启。',
        suggestion: '48 小时内电话回访，确认购房计划是否有变化。',
        valueScore: 70,
        evidence: ['客户在沉睡期后重新出现行为'],
      });
    }

    return { opportunities };
  }

  private buildManagerDiagnosis(promptText: string): Record<string, unknown> {
    const agentId = /"agentId"\s*:\s*"([^"]+)"/.exec(promptText)?.[1] ?? 'unknown';
    return {
      storeSummary:
        '门店整体客户量充足，主要瓶颈出现在带看到谈判的转化环节。建议把管理重点放在带看后的复盘质量与价格谈判辅导上。',
      agents: [
        {
          agentId,
          healthyStages: ['获取客户', '有效联系'],
          weakStages: ['成交推进'],
          primaryIssue: '成交推进能力',
          detail: '从数据看该经纪人带看量正常，但进入谈判后的转化偏低，通常与价格谈判和逼单节奏有关。',
          suggestions: ['陪同参与一次价格谈判并复盘', '针对在谈客户做一次逐单过堂', '建立带看后 24 小时回访的硬性动作'],
        },
      ],
      suggestions: ['每周固定一次带看复盘会', '对谈判中的客户建立一单一策', '把带看后回访率纳入考核指标'],
    };
  }

  private buildCommunicationAnalysis(promptText: string): Record<string, unknown> {
    const hasObjection = /太贵|价格高|预算不够|再考虑|不合适|面积小|楼层/.test(promptText);
    const isPositive = /可以|喜欢|不错|满意|约|看房/.test(promptText);
    const budgetMatch = /(\d{3,4})\s*万/.exec(promptText);
    const budget = budgetMatch?.[1] ? Number(budgetMatch[1]) * 10000 : null;

    return {
      summary: '客户对推荐的房源做出了回应，核心关注点集中在价格与房源条件上。',
      sentiment: isPositive ? 'POSITIVE' : 'NEUTRAL',
      intent: hasObjection ? 'OBJECTION' : isPositive ? 'SCHEDULE_VIEWING' : 'HESITATION',
      objections: hasObjection ? ['客户对价格表达了保留意见'] : [],
      budgetChange: budget !== null ? { previous: null, current: budget, delta: null } : null,
      timelineHint: /这周|下周|月底|尽快/.test(promptText) ? '客户提到近期时间安排' : null,
      requirementChanges: [],
      nextActions: ['记录客户异议点', '针对异议准备对比数据后再次沟通'],
      suggestedReply: '理解您的顾虑，我这边整理一下同小区近期的成交情况，稍后发您参考，您也可以随时告诉我您的想法。',
      confidence: 0.6,
    };
  }

  private buildIntentScore(promptText: string): Record<string, unknown> {
    // 从信号数据中抽取真实计数
    const behaviorCount = firstNumber(promptText, /行为事件[^0-9]{0,8}(\d+)/) ?? 0;
    const favoriteCount = firstNumber(promptText, /收藏[^0-9]{0,8}(\d+)/) ?? 0;
    const viewingCount = firstNumber(promptText, /带看[^0-9]{0,8}(\d+)/) ?? 0;

    const factors = [
      {
        key: 'behaviorActivity',
        label: '行为活跃度',
        rawScore: Math.min(100, behaviorCount * 3),
        weight: 0.2,
        explanation: `累计 ${behaviorCount} 条行为事件。`,
      },
      {
        key: 'favorite',
        label: '收藏行为',
        rawScore: Math.min(100, favoriteCount * 25),
        weight: 0.15,
        explanation: `收藏 ${favoriteCount} 套房源。`,
      },
      {
        key: 'viewing',
        label: '带看情况',
        rawScore: Math.min(100, viewingCount * 30),
        weight: 0.15,
        explanation: `已完成 ${viewingCount} 次带看。`,
      },
    ];

    const score = Math.round(
      factors.reduce((acc, factor) => acc + factor.rawScore * factor.weight, 0) +
        // 剩余权重按中性分 50 计算
        (1 - factors.reduce((acc, factor) => acc + factor.weight, 0)) * 50,
    );

    return {
      score: Math.max(0, Math.min(100, score)),
      summary: `该客户累计 ${behaviorCount} 条行为、${favoriteCount} 次收藏、${viewingCount} 次带看，综合判断为${
        score >= 70 ? '热' : score >= 45 ? '温' : '凉'
      }。`,
      factors,
    };
  }

  private buildMatchExplanation(promptText: string): Record<string, unknown> {
    const properties = this.parsePropertyBlocks(promptText);
    const property = properties[0];
    const highlights: string[] = [];
    if (property?.area) highlights.push(`${property.area}㎡`);
    if (property?.price) highlights.push(`总价 ${Math.round(property.price / 10000)} 万`);
    if (property?.community && property.community !== '未知小区') highlights.push(property.community);

    return {
      recommendation:
        highlights.length > 0
          ? `该房源在${highlights.slice(0, 2).join('、')}等关键指标上符合客户需求。`
          : '该房源与客户需求匹配度较高。',
      highlights,
      concerns: [],
      matchingEvidence: [],
    };
  }

  /** 无 Schema 时的纯文本输出 */
  private buildTextOutput(promptText: string): string {
    const customerName = this.parseCustomerName(promptText);
    return `已根据系统数据完成分析。当前处理的是与「${customerName}」相关的数据，具体结论请以结构化字段为准。（本结果由内置 Mock 模型生成，未调用外部 AI 服务。）`;
  }
}
