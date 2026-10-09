/**
 * AI 系统类型定义：Provider 适配器、Prompt 注册表、结构化输出 Schema、工具调用。
 *
 * 设计原则：
 * 1. 绝不把任何一家 AI 厂商写死 —— 全部通过 ModelProvider 适配器访问。
 * 2. Prompt 绝不散落在业务代码 —— 统一进 Prompt Registry 并带版本号。
 * 3. AI 内部输出优先使用 JSON Schema 约束的结构化对象，不依赖自然语言解析。
 * 4. AI 不可用时，所有功能必须有规则降级方案，且界面明确标注。
 */

// ---------------------------------------------------------------------------
// Provider 适配器
// ---------------------------------------------------------------------------

/** 支持的模型厂商 */
export enum AiProviderKind {
  /** 内置模拟实现：无需密钥即可跑通全流程，用于开发与测试 */
  MOCK = 'mock',
  DEEPSEEK = 'deepseek',
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
}

/** 对话消息角色 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 对话消息 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** tool 角色消息必须带 toolCallId */
  toolCallId?: string;
  /** assistant 消息可携带工具调用请求 */
  toolCalls?: ToolCallRequest[];
  name?: string;
}

/** 模型请求的工具调用 */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** 参数为 JSON 字符串（由模型产出） */
  arguments: string;
}

/** 工具定义（暴露给模型） */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema，object 根类型 */
  parameters: JsonSchema;
}

/** JSON Schema 的原子类型 */
export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/** 极简 JSON Schema 子集，足够表达所有工具与结构化输出 */
export interface JsonSchema {
  /** 单个类型，或类型联合（数组表示可空或多个允许类型，如 ["integer","null"]） */
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  const?: string | number | boolean;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/** 单次补全请求 */
export interface ChatCompletionRequest {
  messages: ChatMessage[];
  /** 覆盖默认模型 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 可用工具 */
  tools?: ToolDefinition[];
  /** 强制结构化输出 */
  responseSchema?: JsonSchema;
  /** 结构化输出的 Schema 名称 */
  responseSchemaName?: string;
  /** 中止信号 */
  signal?: AbortSignal;
}

/** 用量统计 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 补全响应 */
export interface ChatCompletionResponse {
  /** 文本内容（结构化输出时为空或为 JSON 字符串） */
  content: string;
  /** 解析后的结构化对象（当请求带 responseSchema 时） */
  parsed: unknown | null;
  /** 模型请求的工具调用 */
  toolCalls: ToolCallRequest[];
  /** 实际使用的模型名 */
  model: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  /** 是否来自真实厂商（false = mock 或降级） */
  live: boolean;
}

/** 流式输出的单个分片 */
export interface ChatCompletionChunk {
  /** 增量文本 */
  delta: string;
  /** 流结束时的完整响应 */
  done: boolean;
}

/** 向量化请求 */
export interface EmbeddingRequest {
  input: string[];
  model?: string;
}

/** 向量化响应 */
export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: TokenUsage;
  live: boolean;
}

/**
 * 模型 Provider 统一接口。
 * 新增厂商只需实现该接口并在工厂中注册，业务代码零改动。
 */
export interface ModelProvider {
  readonly kind: AiProviderKind;
  readonly defaultModel: string;
  /** 凭证是否已配置 */
  isConfigured(): boolean;
  /** 单次补全（非流式） */
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  /** 流式补全 */
  stream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk>;
  /** 向量化。不支持的厂商返回 null，由上层降级到规则匹配 */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse | null>;
}

// ---------------------------------------------------------------------------
// Prompt 注册表
// ---------------------------------------------------------------------------

/** Prompt 用途标识 */
export enum PromptKey {
  /** 根据录入需求 + 行为生成客户画像分析 */
  CUSTOMER_PROFILE_ANALYSIS = 'CUSTOMER_PROFILE_ANALYSIS',
  /** 客户需求漂移检测与建议 */
  CUSTOMER_PREFERENCE_DRIFT = 'CUSTOMER_PREFERENCE_DRIFT',
  /** 房源匹配理由生成 */
  PROPERTY_MATCH_EXPLANATION = 'PROPERTY_MATCH_EXPLANATION',
  /** 销售跟进话术生成 */
  SALES_FOLLOWUP = 'SALES_FOLLOWUP',
  /** 带看反馈结构化分析 */
  VIEWING_ANALYSIS = 'VIEWING_ANALYSIS',
  /** 销售机会识别与建议 */
  SALES_OPPORTUNITY = 'SALES_OPPORTUNITY',
  /** 店长经营诊断 */
  MANAGER_DIAGNOSIS = 'MANAGER_DIAGNOSIS',
  /** 沟通记录分析（含粘贴聊天记录） */
  COMMUNICATION_ANALYSIS = 'COMMUNICATION_ANALYSIS',
  /** 客户成交概率评估 */
  CUSTOMER_INTENT_SCORE = 'CUSTOMER_INTENT_SCORE',
  /** AI 助手对话（RAG + 工具调用） */
  ASSISTANT_CHAT = 'ASSISTANT_CHAT',

  // -------------------------------------------------------------------------
  // 微信复制 → AI 需求 → 贝壳 → 推荐 闭环（Phase 11）
  // -------------------------------------------------------------------------

  /** 从粘贴的微信消息中抽取结构化客户需求 */
  WECHAT_REQUIREMENT_EXTRACTION = 'WECHAT_REQUIREMENT_EXTRACTION',
  /**
   * 需求增量合并：把新证据并入历史画像。
   *
   * 注意：这个 Prompt 只负责判断"哪些字段该合并、哪些该覆盖"这类**语义判断**，
   * 实际的数值累加（如三级预算）由确定性代码完成 —— 数值运算不能交给 AI。
   */
  CUSTOMER_REQUIREMENT_MERGE = 'CUSTOMER_REQUIREMENT_MERGE',
  /** 从客户回复中抽取对已推荐房源的反馈 */
  PROPERTY_FEEDBACK_EXTRACTION = 'PROPERTY_FEEDBACK_EXTRACTION',
  /** 生成可直接粘贴到普通微信的推荐文案 */
  WECHAT_RECOMMENDATION_REPLY = 'WECHAT_RECOMMENDATION_REPLY',
}

export const PROMPT_KEY_LABELS: Record<PromptKey, string> = {
  [PromptKey.CUSTOMER_PROFILE_ANALYSIS]: '客户画像分析',
  [PromptKey.CUSTOMER_PREFERENCE_DRIFT]: '需求变化检测',
  [PromptKey.PROPERTY_MATCH_EXPLANATION]: '房源匹配解释',
  [PromptKey.SALES_FOLLOWUP]: '销售跟进生成',
  [PromptKey.VIEWING_ANALYSIS]: '带看反馈分析',
  [PromptKey.SALES_OPPORTUNITY]: '销售机会识别',
  [PromptKey.MANAGER_DIAGNOSIS]: '店长经营诊断',
  [PromptKey.COMMUNICATION_ANALYSIS]: '沟通记录分析',
  [PromptKey.CUSTOMER_INTENT_SCORE]: '成交概率评估',
  [PromptKey.ASSISTANT_CHAT]: 'AI 助手对话',
  [PromptKey.WECHAT_REQUIREMENT_EXTRACTION]: '微信需求识别',
  [PromptKey.CUSTOMER_REQUIREMENT_MERGE]: '需求合并判断',
  [PromptKey.PROPERTY_FEEDBACK_EXTRACTION]: '房源反馈识别',
  [PromptKey.WECHAT_RECOMMENDATION_REPLY]: '微信推荐文案',
};

/**
 * 一条 Prompt 模板定义。
 * 版本号用于灰度与回溯：数据库中 ai_runs 会记录实际使用的版本。
 */
export interface PromptTemplate {
  key: PromptKey;
  /** 语义化版本，如 "1.0.0" */
  version: string;
  /** 用途说明 */
  description: string;
  /** 系统提示词 */
  system: string;
  /** 用户提示词模板，使用 {{variable}} 占位 */
  user: string;
  /** 期望的结构化输出 Schema（内部输出不依赖自然语言解析） */
  responseSchema?: JsonSchema;
  /** 建议温度 */
  temperature: number;
  /** 建议最大输出 token */
  maxTokens: number;
  /** 模板中声明的变量名，渲染时校验，缺失即报错 */
  variables: string[];
}

/** 渲染后的 Prompt */
export interface RenderedPrompt {
  key: PromptKey;
  version: string;
  system: string;
  user: string;
  responseSchema?: JsonSchema;
  temperature: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// AI 运行记录
// ---------------------------------------------------------------------------

/** AI 调用状态 */
export enum AiRunStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  /** 因配额或未配置而降级到规则方案 */
  FALLBACK = 'FALLBACK',
}

/** AI 运行记录（入库 ai_runs，用于成本与效果分析） */
export interface AiRun {
  id: string;
  organizationId: string;
  userId: string | null;
  promptKey: PromptKey;
  promptVersion: string;
  provider: AiProviderKind;
  model: string;
  status: AiRunStatus;
  promptTokens: number;
  completionTokens: number;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 关联实体 */
  entityType: string | null;
  entityId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AI 助手对话
// ---------------------------------------------------------------------------

/** AI 助手会话 */
export interface AiConversation {
  id: string;
  organizationId: string;
  userId: string;
  title: string;
  /** 累计 token，用于配额 */
  totalTokens: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** AI 助手消息 */
export interface AiMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  /** 该轮调用的工具名与参数、结果摘要 */
  toolInvocations: Array<{
    name: string;
    arguments: Record<string, unknown>;
    resultSummary: string;
    durationMs: number;
  }>;
  /** 引用到的实体，用于前端生成可点击链接 */
  citations: Array<{
    type: 'CUSTOMER' | 'PROPERTY' | 'OPPORTUNITY' | 'VIEWING';
    id: string;
    label: string;
  }>;
  tokens: number;
  createdAt: string;
}

/** AI 助手工具名 —— 与需求文档 §31 完全对齐 */
export enum AssistantToolName {
  GET_CUSTOMER = 'getCustomer',
  SEARCH_CUSTOMERS = 'searchCustomers',
  GET_CUSTOMER_BEHAVIOR = 'getCustomerBehavior',
  GET_PROPERTIES = 'getProperties',
  MATCH_PROPERTIES = 'matchProperties',
  GET_OPPORTUNITIES = 'getOpportunities',
  GET_VIEWINGS = 'getViewings',
  GET_COMMUNICATIONS = 'getCommunications',
}

/** AI 助手单次回复 */
export interface AssistantReply {
  conversationId: string;
  messageId: string;
  content: string;
  citations: AiMessage['citations'];
  toolInvocations: AiMessage['toolInvocations'];
  usage: TokenUsage;
  /** 是否为真实模型输出；false 表示基于数据库的规则化回答 */
  live: boolean;
  /** AI 辅助判断免责说明 */
  disclaimer: string;
}

/** 所有面向用户的 AI 结论都必须携带的免责声明 */
export const AI_DISCLAIMER = '以上内容由 AI 辅助判断生成，仅供销售参考，不构成成交承诺或投资建议。';
