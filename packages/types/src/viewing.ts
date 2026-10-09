/**
 * 带看、沟通记录、语音记录相关类型。
 */

/** 带看状态 */
export enum ViewingStatus {
  /** 已计划 */
  PLANNED = 'PLANNED',
  /** 客户已确认 */
  CONFIRMED = 'CONFIRMED',
  /** 已完成 */
  COMPLETED = 'COMPLETED',
  /** 已取消 */
  CANCELLED = 'CANCELLED',
  /** 客户爽约 */
  NO_SHOW = 'NO_SHOW',
}

export const VIEWING_STATUS_LABELS: Record<ViewingStatus, string> = {
  [ViewingStatus.PLANNED]: '已计划',
  [ViewingStatus.CONFIRMED]: '已确认',
  [ViewingStatus.COMPLETED]: '已完成',
  [ViewingStatus.CANCELLED]: '已取消',
  [ViewingStatus.NO_SHOW]: '客户爽约',
};

/** 带看中的单套房源反馈 */
export interface ViewingPropertyFeedback {
  propertyId: string;
  /** 客户是否喜欢 */
  liked: 'LIKE' | 'DISLIKE' | 'NEUTRAL';
  /** 排序（第几套看的） */
  visitOrder: number;
  /** 优点 */
  pros: string[];
  /** 缺点/反对点 */
  cons: string[];
  /** 客户对该套的心理价位 */
  customerPrice: number | null;
  /** 客户原话 */
  customerComment: string | null;
}

/** 带看记录 */
export interface Viewing {
  id: string;
  organizationId: string;
  storeId: string | null;
  customerId: string;
  agentId: string;
  /** 带看时间 */
  scheduledAt: string;
  /** 实际完成时间 */
  completedAt: string | null;
  status: ViewingStatus;
  /** 带看前备注 */
  notes: string | null;
  /** 带看后反馈（原始文字，可能是语音转写结果） */
  feedback: string | null;
  /** 客户总体满意度 1～5 */
  satisfaction: number | null;
  /** 关联房源 */
  properties: Array<{
    propertyId: string;
    propertyTitle: string;
    community: string;
    totalPrice: number;
    feedback: ViewingPropertyFeedback | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * AI 对带看反馈的结构化分析结果。
 * 目标：把经纪人一段口语描述，转成可推进成交的结构化信息。
 */
export interface ViewingAnalysis {
  viewingId: string;
  /** 客户最喜欢的一套 */
  topChoicePropertyId: string | null;
  topChoicePropertyTitle: string | null;
  topChoiceReason: string | null;
  /** 备选方案 */
  backupChoicePropertyId: string | null;
  /** 每套房的优缺点 */
  propertyFeedback: ViewingPropertyFeedback[];
  /** 识别出的主要优点（跨房源聚合） */
  overallPros: string[];
  /** 识别出的主要反对点（跨房源聚合） */
  overallCons: string[];
  /** 推断的客户心理价位（元） */
  inferredPriceAcceptance: number | null;
  /** 价格接受度说明 */
  priceAcceptanceNote: string | null;
  /** 是否有家庭成员分歧 */
  hasFamilyDisagreement: boolean;
  /** 分歧说明 */
  familyDisagreementNote: string | null;
  /** 下一步行动建议 */
  nextActions: string[];
  /** 建议联系业主/谈判的动作 */
  negotiationSuggestion: string | null;
  /** 客户意向变化：升温 / 持平 / 降温 */
  intentTrend: 'WARMING' | 'STABLE' | 'COOLING';
  /** 置信度 0～1 */
  confidence: number;
  /** 是否为 AI 生成（false 表示规则降级生成） */
  aiGenerated: boolean;
  /** AI 辅助判断免责说明 */
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// 沟通记录
// ---------------------------------------------------------------------------

/** 沟通渠道 */
export enum CommunicationChannel {
  WECHAT = 'WECHAT',
  PHONE = 'PHONE',
  SMS = 'SMS',
  /** 面谈 */
  FACE_TO_FACE = 'FACE_TO_FACE',
  /** 系统内留言 */
  IN_APP = 'IN_APP',
  OTHER = 'OTHER',
}

export const COMMUNICATION_CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  [CommunicationChannel.WECHAT]: '微信',
  [CommunicationChannel.PHONE]: '电话',
  [CommunicationChannel.SMS]: '短信',
  [CommunicationChannel.FACE_TO_FACE]: '面谈',
  [CommunicationChannel.IN_APP]: '站内',
  [CommunicationChannel.OTHER]: '其他',
};

/** 沟通方向 */
export enum CommunicationDirection {
  /** 经纪人 → 客户 */
  OUTBOUND = 'OUTBOUND',
  /** 客户 → 经纪人 */
  INBOUND = 'INBOUND',
}

export const COMMUNICATION_DIRECTION_LABELS: Record<CommunicationDirection, string> = {
  [CommunicationDirection.OUTBOUND]: '我方发出',
  [CommunicationDirection.INBOUND]: '客户回复',
};

/** 沟通内容来源 */
export enum CommunicationSource {
  /** 经纪人手动录入 */
  MANUAL = 'MANUAL',
  /** 粘贴聊天记录后由 AI 解析 */
  PASTED_TRANSCRIPT = 'PASTED_TRANSCRIPT',
  /** 语音记录转写 */
  VOICE_TRANSCRIBED = 'VOICE_TRANSCRIBED',
  /** AI 生成的建议话术（记录已发送内容） */
  AI_GENERATED = 'AI_GENERATED',
}

export const COMMUNICATION_SOURCE_LABELS: Record<CommunicationSource, string> = {
  [CommunicationSource.MANUAL]: '手动录入',
  [CommunicationSource.PASTED_TRANSCRIPT]: '粘贴聊天记录',
  [CommunicationSource.VOICE_TRANSCRIBED]: '语音转写',
  [CommunicationSource.AI_GENERATED]: 'AI 生成',
};

/** 客户情绪 */
export enum Sentiment {
  VERY_POSITIVE = 'VERY_POSITIVE',
  POSITIVE = 'POSITIVE',
  NEUTRAL = 'NEUTRAL',
  NEGATIVE = 'NEGATIVE',
  VERY_NEGATIVE = 'VERY_NEGATIVE',
}

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
  [Sentiment.VERY_POSITIVE]: '非常积极',
  [Sentiment.POSITIVE]: '积极',
  [Sentiment.NEUTRAL]: '中性',
  [Sentiment.NEGATIVE]: '消极',
  [Sentiment.VERY_NEGATIVE]: '非常消极',
};

/** 沟通意图 */
export enum CommunicationIntent {
  /** 询价 */
  PRICE_INQUIRY = 'PRICE_INQUIRY',
  /** 约看 */
  SCHEDULE_VIEWING = 'SCHEDULE_VIEWING',
  /** 议价 */
  NEGOTIATION = 'NEGOTIATION',
  /** 咨询贷款 */
  LOAN_QUESTION = 'LOAN_QUESTION',
  /** 咨询政策/资格 */
  POLICY_QUESTION = 'POLICY_QUESTION',
  /** 表达异议 */
  OBJECTION = 'OBJECTION',
  /** 要求更多房源 */
  REQUEST_MORE_OPTIONS = 'REQUEST_MORE_OPTIONS',
  /** 明确拒绝 */
  REJECTION = 'REJECTION',
  /** 拖延/观望 */
  HESITATION = 'HESITATION',
  /** 闲聊维护关系 */
  SMALL_TALK = 'SMALL_TALK',
  OTHER = 'OTHER',
}

export const COMMUNICATION_INTENT_LABELS: Record<CommunicationIntent, string> = {
  [CommunicationIntent.PRICE_INQUIRY]: '询价',
  [CommunicationIntent.SCHEDULE_VIEWING]: '约看',
  [CommunicationIntent.NEGOTIATION]: '议价',
  [CommunicationIntent.LOAN_QUESTION]: '咨询贷款',
  [CommunicationIntent.POLICY_QUESTION]: '咨询政策',
  [CommunicationIntent.OBJECTION]: '表达异议',
  [CommunicationIntent.REQUEST_MORE_OPTIONS]: '要求更多房源',
  [CommunicationIntent.REJECTION]: '明确拒绝',
  [CommunicationIntent.HESITATION]: '犹豫观望',
  [CommunicationIntent.SMALL_TALK]: '关系维护',
  [CommunicationIntent.OTHER]: '其他',
};

/** 沟通记录 */
export interface Communication {
  id: string;
  organizationId: string;
  customerId: string;
  agentId: string;
  channel: CommunicationChannel;
  direction: CommunicationDirection;
  source: CommunicationSource;
  /** 原始内容 */
  content: string;
  /** AI 生成的摘要 */
  summary: string | null;
  /** AI 判断的客户情绪 */
  sentiment: Sentiment | null;
  /** AI 判断的沟通意图 */
  intent: CommunicationIntent | null;
  /** AI 识别出的客户异议点 */
  objections: string[];
  /** AI 识别出的预算变化（元），null 表示无变化 */
  budgetChange: number | null;
  /** AI 识别出的购房时间计划 */
  timelineHint: string | null;
  /** 是否已用于更新客户画像 */
  appliedToProfile: boolean;
  createdAt: string;
}

/** AI 对沟通记录的结构化分析 */
export interface CommunicationAnalysis {
  communicationId: string | null;
  summary: string;
  sentiment: Sentiment;
  intent: CommunicationIntent;
  /** 客户异议点 */
  objections: string[];
  /** 预算变化：新预算与变化量 */
  budgetChange: {
    previous: number | null;
    current: number | null;
    delta: number | null;
  } | null;
  /** 购房时间线索 */
  timelineHint: string | null;
  /** 需求变化点（如新增学区要求） */
  requirementChanges: string[];
  /** 建议的下一步动作 */
  nextActions: string[];
  /** 建议发送的话术 */
  suggestedReply: string | null;
  /** 置信度 */
  confidence: number;
  aiGenerated: boolean;
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// 语音快速记录
// ---------------------------------------------------------------------------

/** 语音记录处理状态 */
export enum VoiceNoteStatus {
  /** 已上传，待转写 */
  UPLOADED = 'UPLOADED',
  /** 转写中 */
  TRANSCRIBING = 'TRANSCRIBING',
  /** 转写完成 */
  TRANSCRIBED = 'TRANSCRIBED',
  /** 转写失败 */
  FAILED = 'FAILED',
}

export const VOICE_NOTE_STATUS_LABELS: Record<VoiceNoteStatus, string> = {
  [VoiceNoteStatus.UPLOADED]: '待转写',
  [VoiceNoteStatus.TRANSCRIBING]: '转写中',
  [VoiceNoteStatus.TRANSCRIBED]: '已转写',
  [VoiceNoteStatus.FAILED]: '转写失败',
};

/**
 * 语音记录。
 * 第一版即使不做语音识别，也必须提供文本输入接口与服务抽象，
 * 以便后续接入 ASR 时无需改动业务层。
 */
export interface VoiceNote {
  id: string;
  organizationId: string;
  customerId: string;
  agentId: string;
  /** 语音文件地址，文本模式时为空 */
  audioUrl: string | null;
  /** 时长（秒） */
  durationSeconds: number | null;
  status: VoiceNoteStatus;
  /** 转写文本（文本模式时即为直接输入的内容） */
  transcript: string | null;
  /** 关联带看 */
  viewingId: string | null;
  /** 由该记录生成的结构化分析（带看反馈或沟通分析） */
  analysisKind: 'VIEWING_FEEDBACK' | 'COMMUNICATION' | null;
  createdAt: string;
}

/**
 * 语音转写服务抽象。
 * 实现：MockTranscriptionService（直接透传文本）。
 * 未来接入真实 ASR 时新增实现即可，业务层不变。
 */
export interface TranscriptionService {
  readonly name: string;
  isAvailable(): boolean;
  transcribe(input: { audioUrl?: string; text?: string }): Promise<{
    transcript: string;
    confidence: number;
    provider: string;
  }>;
}
