/**
 * 贝壳 MCP 工具桥 —— 把官方 18 个 MCP 工具接进项目的 AI 助手。
 *
 * ============================================================================
 * 为什么需要它
 * ============================================================================
 * 项目原先访问贝壳的唯一通道是 `beike.exe`（官方 Rust CLI）。经过排查，
 * 这条通道有三个我们**无法控制也无法验证**的问题：
 *
 *   1. **不发送 `X-Beike-Cli-Version` 头**
 *      实测：裸 HTTP 不带该头会被服务端拒绝（`CLI_UPGRADE_REQUIRED`）。
 *      CLI 内部怎么发的我们看不到 —— 一旦哪天不发了，整条链路静默失效。
 *
 *   2. **把服务端错误压成一句固定文案**
 *      CLI 把版本问题、鉴权问题、限流、服务故障统统压成
 *      "service temporarily unavailable"。本次排查就在这里被误导了很久。
 *
 *   3. **依赖 7MB 的 Rust 二进制**
 *      平台差异、进程开销、无法在容器/边缘环境灵活部署。
 *
 * 本桥接直接走 MCP 协议，把**全部 18 个工具**暴露给 AI 助手：
 *   house_search / newhouse_search / rent_house_search / resblock_search /
 *   plate_search / policy_search / decorate_search / house_rank_search /
 *   resblock_rank_search / agent_search / store_search / entity_resolution /
 *   entity_detail / entity_material / decor_store_search / decor_price_query /
 *   wecom_add_contact_qrcode / report_user_intent
 *
 * ============================================================================
 * 与"官方 skill"的关系（重要，避免重复建设）
 * ============================================================================
 * 贝壳官方的 8 个 skill（beike-buy / beike-market / …）在 manifest 里明确标注：
 *
 *     packageType: instruction-skill
 *     instructionOnly: true
 *
 * 意思是它们**只是给 AI 的行为指令文本（SKILL.md，24KB 提示词）**，
 * 自身不含任何数据通道 —— 最终仍然是让 AI 去调 `beike` CLI。
 *
 * 所以本桥接与官方 skill **互补而非重复**：
 *   - 官方 skill 解决"AI 该怎么问、怎么组织回答"（业务话术与追问策略）
 *   - 本桥接解决"数据从哪来、错误怎么看"（传输层与可观测性）
 *
 * 我们可以在提示词里借鉴官方 skill 的追问策略，但数据通道用自己可控的这条。
 *
 * ============================================================================
 * 安全边界
 * ============================================================================
 *   - API Key 只从环境变量读，**绝不**落盘或写日志
 *   - 两个有副作用的工具（`wecom_add_contact_qrcode` 会生成企微活码、
 *     `report_user_intent` 会把用户查询上报到贝壳分析后台）默认**不暴露**给 AI，
 *     需要显式开启 `allowSideEffects` 才可用 —— 避免 AI 在用户不知情时
 *     产生外部副作用
 */

import { Injectable, Logger } from '@nestjs/common';

import { BeikeMcpClient } from '../property/providers/beike/beike-mcp-client.js';
import type { BeikeDirectClient } from '../property/providers/beike/beike-direct-client.js';

/** 一个可供 AI 调用的工具描述 */
export interface AssistantToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema 形式的参数定义（可直接喂给支持 tool-calling 的模型） */
  parameters: Record<string, unknown>;
  required: string[];
}

/** 工具调用结果 */
export interface AssistantToolResult {
  ok: boolean;
  tool: string;
  text: string;
  durationMs: number;
  error?: string;
}

/**
 * 有副作用的工具 —— 默认不暴露。
 *
 * 为什么单独列出：这两个工具会在**外部系统**留下痕迹
 * （生成企微活码、把用户查询上报到贝壳后台）。
 * AI 自行决定调用它们，用户是不知情的。默认关闭，
 * 需要时由调用方显式开启。
 */
const SIDE_EFFECT_TOOLS = new Set(['wecom_add_contact_qrcode', 'report_user_intent']);

/**
 * 工具的中文说明补充。
 *
 * 服务端返回的描述已经很详细，但都是"什么时候用"的说明。
 * 这里补充**参数怎么填**的中文提示 —— 尤其 `city_name` 必须是城市名，
 * 不能是区名（写"思明区"会失败）。这类细节模型容易搞错。
 */
const PARAM_HINTS: Record<string, string> = {
  city_name: '城市名称，例如「厦门」「上海」。不要填区名（如「思明区」），区名要写进 query。',
  query: '自然语言查询语句。要把口语问题改写成清晰、单一、可执行的查询，并保留用户明确的限制条件。',
  entity_ids: '实体 ID，多个用英文逗号分隔。ID 来自搜索类工具的返回结果。',
  entity_type: '实体类型：house（二手房）/ newhouse（新房）/ resblock（小区）。',
  fields: '要获取的字段名数组，例如 ["小区图片"]。',
};

@Injectable()
export class BeikeToolBridge {
  private readonly logger = new Logger(BeikeToolBridge.name);

  constructor(private readonly beike: BeikeMcpClient) {}

  /**
   * 取直连客户端。
   *
   * 桥接**只走直连**，不回退 CLI —— 因为 AI 需要看到真实错误。
   * CLI 会把错误压成固定文案，回退过去等于把可观测性丢掉了。
   */
  private directClient(): BeikeDirectClient | null {
    return this.beike.getDirectClient();
  }

  /** 桥接是否可用（Key 已配置且直连就绪） */
  isAvailable(): boolean {
    return this.directClient() !== null;
  }

  /**
   * 列出可供 AI 调用的工具。
   *
   * @param allowSideEffects 是否包含有副作用的工具（默认 false）
   */
  async listTools(
    allowSideEffects = false,
  ): Promise<AssistantToolDescriptor[]> {
    const client = this.directClient();
    if (!client) return [];

    // 绕过熔断：列工具是**协议层**操作，不该被数据层熔断连带阻断
    const tools = await client.listTools({ bypassCircuit: true });

    return tools
      .filter((tool) => allowSideEffects || !SIDE_EFFECT_TOOLS.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: this.enrichParameters(tool.parameters),
        required: tool.required,
      }));
  }

  /** 给参数补上中文提示（服务端描述偏重"何时用"，缺"怎么填"） */
  private enrichParameters(
    parameters: Record<string, unknown>,
  ): Record<string, unknown> {
    const enriched: Record<string, unknown> = {};

    for (const [name, rawSchema] of Object.entries(parameters)) {
      const schema = (rawSchema ?? {}) as Record<string, unknown>;
      const hint = PARAM_HINTS[name];

      enriched[name] = hint
        ? { ...schema, description: `${String(schema['description'] ?? '')}\n【填写提示】${hint}`.trim() }
        : schema;
    }

    return enriched;
  }

  /**
   * 调用一个工具。
   *
   * @param allowSideEffects 是否允许调用有副作用的工具
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    allowSideEffects = false,
  ): Promise<AssistantToolResult> {
    const client = this.directClient();

    if (!client) {
      return {
        ok: false,
        tool: name,
        text: '',
        durationMs: 0,
        error: '贝壳直连客户端不可用（API Key 未配置）',
      };
    }

    // 副作用保护：即使调用方传了工具名，默认也拦住
    if (!allowSideEffects && SIDE_EFFECT_TOOLS.has(name)) {
      return {
        ok: false,
        tool: name,
        text: '',
        durationMs: 0,
        error: `工具 ${name} 会产生外部副作用（生成活码/上报数据），默认禁止调用`,
      };
    }

    const result = await client.callTool(name, args);

    if (!result.ok) {
      this.logger.warn(
        `贝壳工具 ${name} 调用失败（${result.durationMs}ms）：${String(result.error).slice(0, 160)}`,
      );
    } else {
      this.logger.log(
        `贝壳工具 ${name} 调用成功（${result.durationMs}ms，返回 ${result.text.length} 字符）`,
      );
    }

    return {
      ok: result.ok,
      tool: name,
      text: result.text,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  /**
   * 连通性自检。
   *
   * 返回的信息要能区分三种失败：
   *   - Key 未配置
   *   - 网络/协议问题
   *   - **服务端数据层故障**（Key 与协议都对，但工具全挂）
   *
   * 第三种最容易被误判成"没有房源"，因此这里显式探测一个只读工具。
   */
  async healthCheck(): Promise<{
    available: boolean;
    toolCount: number;
    dataLayerOk: boolean;
    message: string;
    detail?: string;
  }> {
    const client = this.directClient();

    if (!client) {
      return {
        available: false,
        toolCount: 0,
        dataLayerOk: false,
        message: '贝壳直连未启用（BEIKE_MCP_API_KEY 未配置）',
      };
    }

    let toolCount = 0;
    try {
      // 绕过熔断：自检要如实反映「协议层是否活着」，
      // 否则数据层故障期间自检会一直报"握手失败"，掩盖协议正常的事实。
      const tools = await client.listTools({ bypassCircuit: true });
      toolCount = tools.length;
    } catch (error) {
      return {
        available: false,
        toolCount: 0,
        dataLayerOk: false,
        message: 'MCP 握手或 tools/list 失败',
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    // 用一个无副作用、参数最简的工具探数据层
    const probe = await client.callTool('plate_search', {
      city_name: '上海',
      query: '浦东',
    });

    if (probe.ok) {
      return {
        available: true,
        toolCount,
        dataLayerOk: true,
        message: `贝壳数据层正常（${toolCount} 个工具可用）`,
      };
    }

    return {
      available: true,
      toolCount,
      dataLayerOk: false,
      message: `MCP 协议正常（${toolCount} 个工具可见），但数据层不可用`,
      detail: probe.error,
    };
  }
}
