/**
 * 客户消息导入服务。
 *
 * 产品边界（必须明确）：
 *   本项目使用**普通个人微信**，没有任何微信聊天 API。
 *   本服务处理的只是**经纪人主动从微信复制、粘贴进系统的文本**。
 *
 *   因此这里绝不涉及（也永远不会实现）：
 *     - 微信 Hook / DLL 注入 / PC 微信逆向
 *     - 模拟个人微信协议 / 读取微信本地数据库
 *     - 自动抓取聊天记录 / 自动控制微信客户端 / 自动代客户发消息
 *
 * 设计原则：
 *   **原始文本永不丢失。** 无论 AI 解析成功还是失败、流程在哪一步中断，
 *   rawText 必须已经落库。这是产品可信度的底线 ——
 *   经纪人辛苦粘贴的内容不能因为一次 AI 超时就消失。
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  MessageImportSource,
  MessageImportType,
  MessageParseStatus,
  type RequirementExtraction,
} from '@estatepilot/types';
import { TenantService } from '../tenant/tenant.service.js';

/** 保存消息的输入 */
export interface SaveMessageInput {
  customerId: string;
  agentId: string;
  rawText: string;
  source?: MessageImportSource;
  sourceType?: MessageImportType;
}

/** 保存结果 */
export interface SavedMessage {
  id: string;
  customerId: string;
  rawText: string;
  parseStatus: MessageParseStatus;
  createdAt: Date;
}

@Injectable()
export class MessageImportService {
  private readonly logger = new Logger(MessageImportService.name);

  constructor(private readonly tenant: TenantService) {}

  /**
   * 保存粘贴的原始消息。
   *
   * 关键设计：**先保存，再解析**。
   * 调用方（编排器）必须先调这个方法，再去做 AI 解析。
   * 这样即使后续所有步骤都失败，客户说的话也已经安全落库，
   * 经纪人不会丢失输入，重试时也不需要重新粘贴。
   */
  async save(organizationId: string, input: SaveMessageInput): Promise<SavedMessage> {
    const scope = this.tenant.scopeFor(organizationId);
    const rawText = input.rawText.trim();

    if (rawText.length === 0) {
      throw new EmptyMessageError();
    }

    // 长度保护：微信单条消息几千字已属极端，超长内容截断并记录
    const MAX_LENGTH = 20_000;
    const stored = rawText.length > MAX_LENGTH ? rawText.slice(0, MAX_LENGTH) : rawText;
    const truncated = rawText.length > MAX_LENGTH;

    if (truncated) {
      this.logger.warn(
        `客户消息长度 ${rawText.length} 超过上限 ${MAX_LENGTH}，已截断保存（原文前 ${MAX_LENGTH} 字）`,
      );
    }

    const created = await scope.create<{ id: string; createdAt: Date }>('CustomerMessageImport', {
      data: {
        customerId: input.customerId,
        agentId: input.agentId,
        rawText: stored,
        source: input.source ?? MessageImportSource.WECHAT_MANUAL_PASTE,
        sourceType: input.sourceType ?? MessageImportType.CUSTOMER_MESSAGE,
        parseStatus: MessageParseStatus.PENDING,
      },
      select: { id: true, createdAt: true },
    });

    this.logger.log(
      `已保存客户消息：${created.id}（${stored.length} 字，客户 ${input.customerId}）` +
        `${truncated ? '（已截断）' : ''}`,
    );

    return {
      id: created.id,
      customerId: input.customerId,
      rawText: stored,
      parseStatus: MessageParseStatus.PENDING,
      createdAt: created.createdAt,
    };
  }

  /** 标记解析成功，并写入解析结果 */
  async markParsed(
    organizationId: string,
    messageId: string,
    payload: {
      extraction: RequirementExtraction;
      source: 'AI' | 'RULES';
      model: string | null;
      durationMs: number;
      snapshotId?: string | null;
    },
  ): Promise<void> {
    const scope = this.tenant.scopeFor(organizationId);

    await scope.update('CustomerMessageImport', {
      where: { id: messageId },
      data: {
        parseStatus: MessageParseStatus.SUCCESS,
        parsedRequirements: payload.extraction as unknown as object,
        parseModel: payload.model ?? (payload.source === 'RULES' ? '内置规则解析' : null),
        parseDurationMs: payload.durationMs,
        parseError: null,
        ...(payload.snapshotId ? { snapshotId: payload.snapshotId } : {}),
      },
    });

    this.logger.log(`消息 ${messageId} 解析完成（通道：${payload.source}）`);
  }

  /** 标记解析失败 —— 原文保留，只是标注状态 */
  async markFailed(
    organizationId: string,
    messageId: string,
    error: string,
  ): Promise<void> {
    const scope = this.tenant.scopeFor(organizationId);

    await scope.update('CustomerMessageImport', {
      where: { id: messageId },
      data: {
        parseStatus: MessageParseStatus.FAILED,
        parseError: error.slice(0, 2000),
      },
    });

    this.logger.warn(`消息 ${messageId} 解析失败（原文已保留）：${error.slice(0, 200)}`);
  }

  /** 取客户最近的消息（用于会话上下文，控制条数避免 Prompt 过长） */
  async findRecent(
    organizationId: string,
    customerId: string,
    limit = 5,
  ): Promise<
    Array<{
      id: string;
      rawText: string;
      sourceType: string;
      parseStatus: string;
      createdAt: Date;
    }>
  > {
    const scope = this.tenant.scopeFor(organizationId);

    return scope.findMany<{
      id: string;
      rawText: string;
      sourceType: string;
      parseStatus: string;
      createdAt: Date;
    }>('CustomerMessageImport', {
      where: { customerId },
      select: {
        id: true,
        rawText: true,
        sourceType: true,
        parseStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** 按 ID 取单条消息（用于"仅分析已保存的消息"场景） */
  async findById(
    organizationId: string,
    messageId: string,
  ): Promise<{ id: string; customerId: string; rawText: string; parseStatus: string } | null> {
    const scope = this.tenant.scopeFor(organizationId);

    return scope.findFirst<{
      id: string;
      customerId: string;
      rawText: string;
      parseStatus: string;
    }>('CustomerMessageImport', {
      where: { id: messageId },
      select: { id: true, customerId: true, rawText: true, parseStatus: true },
    });
  }

  /** 取客户消息列表（分页，用于客户 360 页面展示） */
  async list(
    organizationId: string,
    customerId: string,
    options: { page?: number; pageSize?: number } = {},
  ): Promise<{
    items: Array<{
      id: string;
      rawText: string;
      source: string;
      sourceType: string;
      parseStatus: string;
      parseError: string | null;
      parsedRequirements: unknown;
      snapshotId: string | null;
      createdAt: Date;
    }>;
    total: number;
  }> {
    const scope = this.tenant.scopeFor(organizationId);
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 10));

    const [items, total] = await Promise.all([
      scope.findMany<{
        id: string;
        rawText: string;
        source: string;
        sourceType: string;
        parseStatus: string;
        parseError: string | null;
        parsedRequirements: unknown;
        snapshotId: string | null;
        createdAt: Date;
      }>('CustomerMessageImport', {
        where: { customerId },
        select: {
          id: true,
          rawText: true,
          source: true,
          sourceType: true,
          parseStatus: true,
          parseError: true,
          parsedRequirements: true,
          snapshotId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      // 注意：TenantScope.count 接收的是**裸 where 对象**（内部会自己包 { where }），
      // 多包一层会生成 { where: { where: {...} } } 从而被 Prisma 拒绝。
      scope.count('CustomerMessageImport', { customerId }),
    ]);

    return { items, total };
  }
}

/** 消息为空 */
export class EmptyMessageError extends Error {
  readonly errorCode = 'MESSAGE_EMPTY';

  constructor() {
    super('粘贴的内容为空，请先把客户在微信里说的话复制进来。');
    this.name = 'EmptyMessageError';
  }
}
