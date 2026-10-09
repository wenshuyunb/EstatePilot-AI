/**
 * 客户消息推送相关类型。
 *
 * 产品目标（用户原话）：
 *   「有意向客户我可以选择添加进我的项目里面，然后按照他的需求，
 *     和贝壳找房里的房源自动匹配，然后按照格式把相关信息和话术发给对应的意向客户」
 *
 * 因此这里定义的是「一键发送包」：系统算好匹配 → 排版成微信可读的格式 → 生成话术
 * → 经纪人一键复制粘贴到微信发送。
 *
 * 为什么不做自动发送到个人微信：
 *   微信官方明令禁止第三方外挂，封号风险高且违反个人信息保护法。
 *   企业微信有官方 API，但个人微信没有。因此采用「生成 → 人工确认发送」的模式，
 *   这既是真实中介的日常做法，也零合规风险。
 */

/** 消息渠道 */
export enum MessageChannel {
  /** 个人微信（生成文本，人工复制发送） */
  WECHAT_PERSONAL = 'WECHAT_PERSONAL',
  /** 企业微信（官方 API，可自动发送） */
  WECHAT_WORK = 'WECHAT_WORK',
  /** 短信 */
  SMS = 'SMS',
  /** 电话话术（不发送，供经纪人口头使用） */
  PHONE_SCRIPT = 'PHONE_SCRIPT',
}

export const MESSAGE_CHANNEL_LABELS: Record<MessageChannel, string> = {
  [MessageChannel.WECHAT_PERSONAL]: '个人微信',
  [MessageChannel.WECHAT_WORK]: '企业微信',
  [MessageChannel.SMS]: '短信',
  [MessageChannel.PHONE_SCRIPT]: '电话话术',
};

/** 推荐场景 —— 决定话术的角度 */
export enum RecommendScenario {
  /** 新房源推荐 */
  NEW_LISTING = 'NEW_LISTING',
  /** 降价提醒 */
  PRICE_DROP = 'PRICE_DROP',
  /** 新房源匹配（首次推送） */
  FIRST_MATCH = 'FIRST_MATCH',
  /** 沉睡客户激活 */
  DORMANT_REACTIVATE = 'DORMANT_REACTIVATE',
  /** 带看后跟进 */
  VIEWING_FOLLOWUP = 'VIEWING_FOLLOWUP',
  /** 常规跟进 */
  ROUTINE = 'ROUTINE',
}

export const RECOMMEND_SCENARIO_LABELS: Record<RecommendScenario, string> = {
  [RecommendScenario.NEW_LISTING]: '新房源推荐',
  [RecommendScenario.PRICE_DROP]: '降价提醒',
  [RecommendScenario.FIRST_MATCH]: '首次匹配推荐',
  [RecommendScenario.DORMANT_REACTIVATE]: '沉睡客户激活',
  [RecommendScenario.VIEWING_FOLLOWUP]: '带看后跟进',
  [RecommendScenario.ROUTINE]: '常规跟进',
};

/** 发送包中的单套房源 */
export interface RecommendPropertyItem {
  propertyId: string;
  title: string;
  community: string;
  district: string;
  subDistrict: string | null;

  totalPrice: number;
  unitPrice: number;
  /** 相比上次的价格变化（元），负数表示降价；无变化为 0 */
  priceChange: number;
  /** 变化百分比 */
  priceChangePercent: number;

  bedrooms: number;
  livingRooms: number;
  bathrooms: number;
  area: number;
  floor: number | null;
  totalFloors: number | null;
  /** 楼层位置描述，如"中楼层" */
  floorPosition: string | null;

  orientation: string | null;
  buildYear: number | null;
  decoration: string | null;
  elevator: boolean | null;

  subwayDistance: number | null;
  subwayText: string | null;
  schoolText: string | null;

  tags: string[];

  /** 匹配分 0～100 */
  matchScore: number;
  /** 命中的加分项（面向客户的说法，不含内部术语） */
  highlights: string[];
  /** 需要向客户说明的点 */
  concerns: string[];

  /** 封面图 */
  coverImage: string | null;

  /** 该房源在客户专属页面中的链接 */
  shareUrl: string | null;
}

/**
 * 一键发送包。
 *
 * 这是产品交付价值最直接的地方 ——
 * 经纪人不需要自己去复制粘贴房源信息、组织语言，系统直接给一份可以直接发的内容。
 */
export interface RecommendBundle {
  /** 客户 ID */
  customerId: string;
  /** 客户姓名（用于话术个性化） */
  customerName: string;
  /** 脱敏手机号，仅用于前端展示确认 */
  customerPhoneMasked: string;

  /** 场景 */
  scenario: RecommendScenario;
  scenarioLabel: string;

  /** 主渠道 */
  channel: MessageChannel;
  channelLabel: string;

  /** 可直接复制发送的完整文本 */
  messageText: string;
  /** 短信版（精简） */
  smsText: string;
  /** 电话话术 */
  phoneScript: string;

  /** 推荐的话术说明 —— 告诉经纪人这条消息的思路 */
  strategyNote: string;
  /** 发送前的注意事项（如"该客户对价格敏感，先别提涨价"） */
  cautions: string[];

  /** 结构化房源列表，前端可渲染成卡片 */
  properties: RecommendPropertyItem[];

  /**
   * 客户专属页面链接。
   * 客户点开后所有浏览行为会回流到系统，用于更新画像 —— 这是数据闭环的关键。
   */
  customerPortalUrl: string | null;
  /** 专属链接的短码，便于经纪人手动发送 */
  customerPortalShortCode: string | null;

  /** 客户画像摘要（让经纪人发消息前了解客户） */
  customerSnapshot: {
    status: string;
    statusLabel: string;
    intentScore: number;
    intentLevelLabel: string;
    /** 显性需求一句话描述 */
    explicitSummary: string;
    /** 行为画像一句话描述 */
    behavioralSummary: string | null;
    /** 客户自述预算 */
    statedBudget: string | null;
    /** AI 推断预算 */
    inferredBudget: string | null;
    /** 需求变化提示 */
    driftNote: string | null;
    lastContactAt: string | null;
    daysSinceLastContact: number | null;
  };

  /** 是否使用了 AI 生成话术；false 表示规则模板 */
  aiGenerated: boolean;
  /** 免责声明 */
  disclaimer: string;
  generatedAt: string;
}

/** 生成发送包的请求参数 */
export interface GenerateRecommendBundleInput {
  customerId: string;
  scenario?: RecommendScenario;
  channel?: MessageChannel;
  /** 指定要推送的房源；不传则自动用匹配引擎选前 N 套 */
  propertyIds?: string[];
  /** 推送几套房源，默认 3 */
  limit?: number;
  /** 是否生成/复用客户专属链接 */
  includePortalLink?: boolean;
  /** 经纪人补充的个性化信息，会插入话术中 */
  customNote?: string;
}

/** 企业微信发送结果 */
export interface WechatWorkSendResult {
  success: boolean;
  /** 企业微信返回的消息 ID */
  messageId: string | null;
  /** 失败原因 */
  error: string | null;
  /** 是否因为未配置企业微信而降级为手动模式 */
  degradedToManual: boolean;
}
