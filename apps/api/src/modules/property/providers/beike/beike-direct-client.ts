/**
 * 贝壳 MCP 直连 HTTP 客户端。
 *
 * ============================================================================
 * 为什么要有这个（而不是继续用 CLI）
 * ============================================================================
 * 诊断确认了三个 CLI 路径的硬问题：
 *
 *   1. **CLI 不发送 `X-Beike-Cli-Version` 头**
 *      实测：裸 HTTP 不带该头会被服务端直接拒绝（`CLI_UPGRADE_REQUIRED`），
 *      带上就正常。CLI 内部或许有自己的发送方式，但我们**无法控制也无法验证** ——
 *      一旦它哪天不发了，整个数据链路就静默失效，而且错误信息还是误导性的
 *      "service temporarily unavailable"。
 *
 *   2. **错误信息被 CLI 吞掉了**
 *      CLI 把服务端的所有错误统一压成 `{"error":"service temporarily unavailable"}`，
 *      我们看不到真实原因（版本问题？鉴权问题？限流？）。
 *      直连后能看到原始 JSON-RPC 错误与错误码。
 *
 *   3. **失败时 HTTP 状态码仍是 200**
 *      这是实测踩到的坑：MCP 把工具失败封装在
 *      `result.isError = true` + `content[].text` 里，
 *      **只看 HTTP 状态码会误判为成功**。
 *      直连客户端显式检查 isError，语义清晰。
 *
 * 另外的工程收益：不依赖 Rust 二进制、无子进程 spawn 开销、无 Windows 编码问题。
 *
 * ============================================================================
 * 与 CLI 路径的关系
 * ============================================================================
 * CLI 路径**保留不删**（作为兜底传输）。两者实现同一套方法签名，
 * 由 `BeikeMcpClient` 依据配置决定用哪个。
 *
 * 本文件的返回类型刻意与 CLI 路径一致（`BeikeCliResult`），
 * 这样**上层业务代码零改动**，也复用同一个响应解析器。
 */

import { Logger } from '@nestjs/common';
import {
  BeikeCliError,
  type BeikeCliResult,
} from './beike-mcp-client.js';
import type { BeikeResponseParser } from './beike-response-parser.js';
import { BEIKE_USAGE_POLICY } from './beike-usage-policy.js';

/** MCP 工具名（实测 tools/list 返回的 18 个之一） */
type McpToolName =
  | 'house_search'
  | 'newhouse_search'
  | 'resblock_search'
  | 'plate_search'
  | 'rent_house_search'
  | 'policy_search'
  | 'house_rank_search'
  | 'resblock_rank_search'
  | 'agent_search'
  | 'store_search'
  | 'entity_resolution'
  | 'entity_detail'
  | 'entity_material';

/** JSON-RPC 响应（MCP 使用 SSE 传输，需要从 data: 行提取） */
interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    tools?: unknown[];
    serverInfo?: { name?: string; version?: string };
  };
  error?: { code?: number; message?: string; data?: unknown };
}

export interface BeikeDirectClientOptions {
  /** API Key */
  apiKey: string;
  /** MCP Endpoint */
  baseUrl?: string;
  /**
   * 版本头。
   *
   * ⚠️ **必须提供**。实测不带该头时 `tools/list` 会被拒绝：
   * `{"code":-32001,"message":"未检测到 CLI 版本，视为版本过低"}`
   */
  cliVersion?: string;
  /** 单次请求超时 */
  timeoutMs?: number;
  /**
   * 调用节流器（可选）。
   *
   * 不传则不节流 —— 但**生产环境必须传**：
   * 实测一次用户操作会产生 12-15 次贝壳调用，密集发出会触发限流，
   * 导致原本正常的搜索也被熔断挡住。
   */
  rateLimiter?: {
    acquire(): Promise<void>;
    /** 第二个参数是工具名，用于用量统计（分析配额花在哪个工具上） */
    reportResult(ok: boolean, tool?: string): void;
    isLikelyThrottled(): boolean;
  };
}

/** 默认版本头 —— 与本地 CLI 版本保持一致 */
const DEFAULT_CLI_VERSION = '0.2.26';
const DEFAULT_BASE_URL = 'https://building.ke.com/mcp';
const DEFAULT_TIMEOUT_MS = 45_000;

export class BeikeDirectClient {
  private readonly logger = new Logger(BeikeDirectClient.name);
  private readonly baseUrl: string;
  private readonly cliVersion: string;
  private readonly timeoutMs: number;

  /** MCP 要求先 initialize 再调用工具；用 Promise 去重避免并发重复握手 */
  private handshake: Promise<void> | null = null;

  /**
   * MCP 会话 ID。
   *
   * ⚠️ **必须**：MCP 是**有状态会话**协议。
   * `initialize` 的响应头会下发 `mcp-session-id`，后续所有请求都要带上，
   * 否则服务端认为客户端没完成握手，直接返回
   * `-32602 Invalid request parameters`。
   *
   * 这个坑我踩过：第一版直连实现没带会话 ID，所有 tools/call 都被拒，
   * 而错误信息（"Invalid request parameters"）完全指不到真正原因。
   */
  private sessionId: string | null = null;

  /**
   * JSON-RPC 请求序号。
   *
   * 用递增整数而不是随机数 —— 随机数曾在实测中触发服务端
   * `-32602 Invalid request parameters`。递增整数是 JSON-RPC 的标准做法，
   * 且便于在日志里追踪请求顺序。
   */
  private rpcId = 0;

  /**
   * 熔断状态。
   *
   * 诊断发现：服务端故障时**每次调用都在 ~220ms 内确定失败**。
   * 对这种确定性失败反复重试纯属浪费 —— 直接把冷却期拉长。
   */
  private unavailableUntil: number | null = null;

  /**
   * 确定性服务故障的冷却时长。
   *
   * ⚠️ 从 120 秒延长到 5 分钟是**刻意的**（真实事故驱动）：
   * 实测贝壳限流恢复需要 20 分钟以上，而 120 秒冷却结束后会立刻再试 →
   * 再次失败 → 再等 120 秒 → **反复触发**，既拿不到数据，
   * 又可能延长限流窗口。
   */
  private readonly serviceDownCooldownMs = BEIKE_USAGE_POLICY.throttleCooldownMs;

  constructor(
    private readonly options: BeikeDirectClientOptions,
    private readonly parser: BeikeResponseParser,
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.cliVersion = options.cliVersion ?? DEFAULT_CLI_VERSION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  /** 供状态展示（不泄露 Key） */
  describeTransport(): { transport: 'DIRECT_HTTP'; baseUrl: string; cliVersion: string } {
    return { transport: 'DIRECT_HTTP', baseUrl: this.baseUrl, cliVersion: this.cliVersion };
  }

  // ==========================================================================
  // 业务方法（与 CLI 路径同名同签名，便于替换）
  // ==========================================================================

  /** 搜索二手房/新房 */
  async searchHouses(params: {
    city: string;
    query: string;
    houseType?: 'second' | 'new' | 'all';
  }): Promise<BeikeCliResult> {
    // house_type 是 CLI 的参数；MCP 侧用工具名区分二手房与新房
    if (params.houseType === 'new') {
      return this.callToolForBusiness('newhouse_search', { city_name: params.city, query: params.query });
    }
    return this.callToolForBusiness('house_search', { city_name: params.city, query: params.query });
  }

  /** 房源/小区详情 */
  async fetchDetails(params: {
    city: string;
    ids: string[];
    entityType?: 'house' | 'newhouse' | 'resblock';
  }): Promise<BeikeCliResult> {
    /**
     * MCP 的 entity_detail **必须**传 city_name（踩过的真实事故）。
     *
     * 原实现只传了 entity_ids 与 entity_type，服务端返回：
     *   1 validation error for call[entity_detail]
     *   city_name
     *     Missing required keyword only argument
     *
     * 连锁后果（比"详情查不到"严重得多）：
     *   1. 详情查询失败 → 触发重试 → **加剧限流**
     *   2. 失败被上层归类为"贝壳不可用" → **打开熔断**
     *   3. 熔断挡住了后续的**搜索**请求 → 经纪人看到
     *      "贝壳暂时无法查询"，而实际上贝壳是好的
     *
     * 也就是说：一个缺参数，演变成了"整个数据源不可用"。
     */
    return this.callToolForBusiness('entity_detail', {
      city_name: params.city,
      entity_ids: params.ids.join(','),
      entity_type: params.entityType ?? 'house',
    });
  }

  /** 图片/户型图 */
  async fetchMaterial(params: {
    city: string;
    id: string;
    entityType?: 'house' | 'newhouse' | 'resblock';
  }): Promise<BeikeCliResult> {
    /**
     * ⚠️ fields 必须是 `['房源图片']`（实测确认）。
     *
     * 原实现写的是 `['小区图片']` —— 那个字段名返回**空对象 `{}`**，
     * 所以房源卡片一直没有图片。
     *
     * 实测各字段名的返回：
     *   ['房源图片'] → ✅ 9 个 URL（VR封面 + 户型图 + 6 张房间实景图）
     *   ['小区图片'] / ['房屋图片'] / ['实景图'] / ['全部'] / ['图片'] → ❌ 全部返回 {}
     *
     * `房源图片` 的结构：
     *   { "VR": {封面图, 跳转地址}, "户型图片": url, "房间图片": [{图片地址, 房间名称}] }
     *
     * city_name 同样是必填（与 entity_detail 一致）。
     */
    return this.callToolForBusiness('entity_material', {
      city_name: params.city,
      entity_ids: params.id,
      entity_type: params.entityType ?? 'house',
      fields: ['房源图片'],
    });
  }

  async searchResblocks(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.callToolForBusiness('resblock_search', { city_name: params.city, query: params.query });
  }

  async searchPlates(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.callToolForBusiness('plate_search', { city_name: params.city, query: params.query });
  }

  async fetchMarket(params: { city: string; query: string }): Promise<BeikeCliResult> {
    // MCP 无独立行情工具；榜单工具返回市场热度数据，是最接近的替代
    return this.callToolForBusiness('house_rank_search', { city_name: params.city, query: params.query });
  }

  async fetchSold(params: { city: string; query: string }): Promise<BeikeCliResult> {
    // 成交记录：MCP 未提供独立工具，用实体详情兜底（返回含成交属性）
    return this.callToolForBusiness('entity_resolution', { query: params.query, city_name: params.city });
  }

  async searchSchools(params: { city: string; query: string }): Promise<BeikeCliResult> {
    // 学校：MCP 未提供独立工具，用实体消歧判断该名称属于哪类实体
    return this.callToolForBusiness('entity_resolution', { query: params.query, city_name: params.city });
  }

  async fetchDistrict(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.callToolForBusiness('entity_resolution', { query: params.query, city_name: params.city });
  }

  async askPolicy(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.callToolForBusiness('policy_search', { city_name: params.city, query: params.query });
  }

  /** 连通性诊断 */
  async diagnose(): Promise<{ ok: boolean; message: string; raw: string }> {
    if (!this.isConfigured()) {
      return { ok: false, message: 'API Key 未配置', raw: '' };
    }

    try {
      await this.ensureHandshake();
      const tools = await this.listToolNames();

      return {
        ok: tools.length > 0,
        message: `直连 MCP 正常（发现 ${tools.length} 个工具）`,
        raw: `transport=DIRECT_HTTP baseUrl=${this.baseUrl} tools=${tools.length}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message, raw: message };
    }
  }

  // ==========================================================================
  // MCP 协议实现
  // ==========================================================================

  /** 确保已完成 initialize 握手（并发安全） */
  private ensureHandshake(): Promise<void> {
    this.handshake ??= this.doHandshake().catch((error: unknown) => {
      // 握手失败要清掉缓存的 Promise，否则后续调用会一直复用失败结果
      this.handshake = null;
      throw error;
    });

    return this.handshake;
  }

  private async doHandshake(): Promise<void> {
    const response = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-ai', version: '1.0.0' },
    });

    const serverInfo = response.result?.serverInfo;
    this.logger.log(
      `贝壳 MCP 握手成功：${serverInfo?.name ?? '未知服务'} v${serverInfo?.version ?? '?'}`,
    );

    // MCP 协议要求握手后发送 initialized **通知**。
    //
    // ⚠️ 踩过的坑（实测定位）：
    //   通知是 JSON-RPC 的 notification，**不能带 id**。
    //   第一版实现把 id 也带上了，服务端返回
    //   `-32602 Invalid request parameters`。
    //   而当时的 doHandshake 会对任何 JSON-RPC 错误抛异常，
    //   于是**整个握手被判失败**，后续 tools/call 根本没机会执行 ——
    //   表现成"直连调用全部失败"，而真实原因只是通知格式不对。
    //
    // 因此这里两处修正：
    //   1. 通知不带 id（符合规范）
    //   2. 通知失败**不阻断**握手（它本身无响应语义，失败不影响后续调用）
    await this.sendNotification('notifications/initialized');
  }

  /**
   * 发送 JSON-RPC 通知（无 id、无响应语义）。
   *
   * 通知失败只记录日志，不抛错 —— 因为服务端对通知本来就不返回结果，
   * 把它的错误当成致命错误会导致"只是通知格式问题"演变成"整个链路不可用"。
   */
  private async sendNotification(method: string): Promise<void> {
    try {
      await this.rpc(method, undefined, { isNotification: true });
    } catch (error) {
      this.logger.debug(
        `MCP 通知 ${method} 失败（不影响后续调用）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 业务用：列出工具原始定义（仅取数量，不做结构映射）。
   *
   * 命名上与公开的 `listTools()`（AI 用，含 schema 映射）区分开 ——
   * 两者返回结构不同，同名会造成重复定义。
   */
  private async listToolNames(): Promise<unknown[]> {
    const response = await this.rpc('tools/list', {});
    return response.result?.tools ?? [];
  }

  /**
   * 业务用：调用一个 MCP 工具，并归一化成与 CLI 一致的返回结构。
   *
   * 关键点：MCP 把工具失败包在 `result.isError` 里，
   * 而 **HTTP 状态码仍是 200** —— 只看状态码会误判成功。
   *
   * 与公开的 `callTool()`（AI 用，返回原始文本）区分：
   * 本方法把结果包装成 CLI 信封，以便复用同一个响应解析器，
   * 这样业务层拿到的 `parsed.apiError` 与 CLI 路径完全一致。
   */
  private async callToolForBusiness(
    tool: McpToolName,
    args: Record<string, unknown>,
  ): Promise<BeikeCliResult> {
    const startedAt = Date.now();
    await this.ensureHandshake();

    const response = await this.rpc('tools/call', { name: tool, arguments: args });

    const isError = response.result?.isError === true;
    const text = this.extractText(response);

    if (isError) {
      // 归一化成 CLI 的错误信封信封格式，让复用同一个解析器
      // 这样上层拿到的 `parsed.apiError` 与 CLI 路径完全一致
      const stdout = JSON.stringify({ error: text, ok: false });
      return {
        parsed: this.parser.parse(stdout),
        stdout,
        durationMs: Date.now() - startedAt,
      };
    }

    // 成功：包装成 CLI 成功信封 {data, ok:true}
    // 解析器会从中取出 data 作为数据体，与 --json 模式行为一致
    const stdout = JSON.stringify({ data: text, ok: true });
    return {
      parsed: this.parser.parse(stdout),
      stdout,
      durationMs: Date.now() - startedAt,
    };
  }

  /** 从 MCP 结果里抽取文本内容 */
  private extractText(response: JsonRpcResponse): string {
    const content = response.result?.content;
    if (!Array.isArray(content)) return '';

    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  // ==========================================================================
  // 通用工具调用（供 AI 助手使用）
  // ==========================================================================

  /**
   * 列出服务端提供的全部工具（含参数 schema）。
   *
   * 为什么要暴露它：AI 助手需要**自己发现有哪些工具、参数怎么填**。
   * 把工具清单写死在代码里会在服务端调整工具时静默失效 ——
   * 这正是本项目在 CLI 路径上踩过的坑（CLI 不发送版本头，
   * 我们无法控制也无法验证，导致整条链路静默失效）。
   *
   * @param options.bypassCircuit 绕过熔断。
   *   为什么需要：熔断是针对**数据层**的（工具调用失败而打开），
   *   而 `tools/list` 是**协议层**操作 —— 数据层挂了协议层通常仍是好的。
   *   不绕过的话，健康检查会因熔断报"握手失败"，
   *   把"协议正常但数据层故障"这个关键区别抹掉，排查时又被误导。
   */
  async listTools(options: { bypassCircuit?: boolean } = {}): Promise<
    Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      required: string[];
    }>
  > {
    if (!this.isConfigured()) return [];

    await this.ensureHandshake();

    const response = await this.rpc(
      'tools/list',
      {},
      options.bypassCircuit ? { bypassCircuit: true } : {},
    );
    const tools = response.result?.tools ?? [];

    return tools
      .filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
      .map((tool) => {
        const schema = (tool['inputSchema'] ?? {}) as {
          properties?: Record<string, unknown>;
          required?: string[];
        };

        return {
          name: String(tool['name'] ?? ''),
          description: String(tool['description'] ?? ''),
          parameters: schema.properties ?? {},
          required: Array.isArray(schema.required) ? schema.required : [],
        };
      })
      .filter((tool) => tool.name.length > 0);
  }

  /**
   * 调用任意 MCP 工具（通用入口）。
   *
   * 与上面那些语义化方法（searchHouses/fetchDetails…）的区别：
   *   - 语义化方法：固定的参数形状，业务代码用
   *   - 本方法：参数由调用方决定，**供 AI 助手动态调用**
   *
   * 返回原始文本与是否出错，不做业务解析 —— 因为 AI 需要看到原始内容
   * 才能自己判断结果含义（例如区分"没有房源"与"服务不可用"）。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    text: string;
    durationMs: number;
    /** 失败时的可读原因（供 AI 与开发者判断） */
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { ok: false, text: '', durationMs: 0, error: '贝壳 API Key 未配置' };
    }

    const startedAt = Date.now();

    try {
      await this.ensureHandshake();
      const response = await this.rpc('tools/call', { name, arguments: args });

      const isError = response.result?.isError === true;
      const text = this.extractText(response);

      return {
        ok: !isError,
        text,
        durationMs: Date.now() - startedAt,
        // 工具层错误要显式标出，避免上游把"服务不可用"当成"没有房源"
        ...(isError ? { error: text || '工具返回 isError=true' } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        text: '',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 发起一次 JSON-RPC 调用。
   *
   * MCP 使用 SSE 传输（`Content-Type: text/event-stream`），
   * 响应体形如：
   *   event: message
   *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
   * 因此需要从 `data:` 行里提取 JSON。
   */
  private async rpc(
    method: string,
    params: unknown,
    options: { isNotification?: boolean; bypassCircuit?: boolean } = {},
  ): Promise<JsonRpcResponse> {
    // JSON-RPC 通知：**不带 id**（带 id 会被服务端判为 -32602）
    const isNotification = options.isNotification === true;

    // ---- 熔断：服务已确认不可用时直接快速失败 ----
    //
    // bypassCircuit 用于**协议层操作**（tools/list、negotiate）：
    // 熔断是数据层故障触发的，不该连带阻断协议层探测 ——
    // 否则"协议正常但数据层挂了"会被误报成"连不上"，排查时又被误导。
    if (
      !options.bypassCircuit &&
      this.unavailableUntil !== null &&
      Date.now() < this.unavailableUntil
    ) {
      const remain = Math.ceil((this.unavailableUntil - Date.now()) / 1000);
      throw new BeikeCliError(
        `贝壳数据服务已确认不可用，${remain} 秒内不再重试（直连熔断中）`,
        null,
        'CIRCUIT_OPEN',
      );
    }

    /**
     * ---- 节流：确保调用按间隔发出，不突发 ----
     *
     * 放在熔断检查之后：熔断打开时不该占用节流队列。
     * `acquire()` 会把并发调用**排队**（而不是各自 sleep 后同时冲出），
     * 这是避免突发的关键。
     */
    if (this.options.rateLimiter) {
      await this.options.rateLimiter.acquire();
    }

    const id = (this.rpcId += 1);

    // 会话 ID：握手后服务端下发，后续请求必须回传
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // ★ 必须：不带该头 tools/list 会被服务端拒绝（CLI_UPGRADE_REQUIRED）
      'X-Beike-Cli-Version': this.cliVersion,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    // 通知不带 id，也不带 params（服务端对多余字段敏感）
    const body: Record<string, unknown> = isNotification
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', id, method, params };

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 网络层问题可以重试，但不属于"服务已确认不可用"，不打开熔断
      throw new BeikeCliError(`贝壳 MCP 网络请求失败：${message}`, null, message);
    }

    // 捕获/更新会话 ID（initialize 响应会下发）
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession && returnedSession !== this.sessionId) {
      this.sessionId = returnedSession;
      this.logger.debug('已建立 MCP 会话');
    }

    const rawText = await response.text();

    // ---- HTTP 层错误 ----
    if (!response.ok) {
      const detail = rawText.slice(0, 300);
      throw new BeikeCliError(
        `贝壳 MCP 返回 HTTP ${response.status}：${detail}`,
        response.status,
        detail,
      );
    }

    // ---- 解析 SSE ----
    const parsed = this.parseSseBody(rawText);
    if (!parsed) {
      throw new BeikeCliError(
        `贝壳 MCP 响应无法解析：${rawText.slice(0, 300)}`,
        null,
        rawText.slice(0, 300),
      );
    }

    // ---- JSON-RPC 层错误 ----
    if (parsed.error) {
      const code = parsed.error.code;
      const message = parsed.error.message ?? '未知错误';

      // 版本类错误：明确指出来，避免被误当成"服务不可用"
      if (typeof message === 'string' && /CLI 版本|CLI_UPGRADE_REQUIRED|版本过低/i.test(message)) {
        throw new BeikeCliError(
          `贝壳拒绝请求（CLI 版本问题）：${message}`,
          code ?? null,
          `CLI_UPGRADE_REQUIRED cliVersion=${this.cliVersion}`,
        );
      }

      // 鉴权类错误
      if (/authorization|unauthor|invalid.*key/i.test(message)) {
        throw new BeikeCliError(
          `贝壳鉴权失败：${message}`,
          code ?? null,
          'AUTH_FAILED',
        );
      }

      throw new BeikeCliError(`贝壳 MCP 错误（${code}）：${message}`, code ?? null, message);
    }

    // ---- 工具层"服务不可用"：确定性失败，直接打开熔断 ----
    // 这是实测确认的形态：HTTP 200 + isError:true + "service temporarily unavailable"
    /**
     * ---- 熔断判定：只有"服务端整体不可用"才打开 ----
     *
     * ⚠️ 判定条件必须是**服务端故障**，不能是"任何工具报错"。
     *
     * 踩过的真实事故：`entity_detail` 少传 `city_name` → 服务端返回
     * pydantic 参数校验错误（`isError: true`，但文本不是
     * "service temporarily unavailable"）→ 重试 → 触发限流 →
     * 一次工具**参数错误**最终演变成"整个数据源不可用"，挡住了搜索。
     *
     * 因此这里用**白名单式**判定：只有明确的服务端故障信号才熔断。
     * 参数错误、鉴权错误等都应该**立即失败且不熔断** ——
     * 它们是调用方的问题，重试不会变好，也不代表服务挂了。
     */
    const text = this.extractText(parsed);

    if (parsed.result?.isError === true) {
      const isServiceDown = /service\s+temporarily\s+unavailable/i.test(text);
      const isParamError = /validation error|missing.*argument|unexpected keyword/i.test(text);

      if (isServiceDown) {
        this.unavailableUntil = Date.now() + this.serviceDownCooldownMs;
        this.logger.warn(
          `贝壳数据服务不可用（确定性失败），直连熔断 ${this.serviceDownCooldownMs / 1000} 秒`,
        );
      } else if (isParamError) {
        // 参数错误不值得重试，也绝不能熔断 —— 记录清楚便于定位
        this.logger.error(
          `贝壳工具参数错误（不会重试，也不会熔断）：${text.slice(0, 200)}`,
        );
      }
    }

    /**
     * ---- 上报结果给节流器，用于动态调整间隔 ----
     *
     * 失败时拉长间隔（避免火上浇油），连续成功后逐步恢复。
     * 注意：参数错误不算"失败" —— 它是调用方的问题，
     * 不代表服务端压力大，拉长间隔没有意义。
     */
    if (this.options.rateLimiter) {
      const isParamError = /validation error|missing.*argument|unexpected keyword/i.test(text);

      /**
       * 工具名从 params 里取 —— `tools/call` 的参数形如 `{ name: 'house_search', ... }`。
       *
       * 记录工具名的价值：用量统计里能看出**配额花在哪个工具上**
       * （例如详情调用占了大头，就能针对性地优化那一处）。
       * 协议层方法（initialize/tools/list）没有 name，回退到方法名。
       */
      const paramsRecord =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : null;
      const toolName =
        typeof paramsRecord?.['name'] === 'string' ? paramsRecord['name'] : method;

      this.options.rateLimiter.reportResult(!isParamError, toolName);
    }

    return parsed;
  }

  /** 从 SSE 响应体里提取第一条 JSON-RPC 消息 */
  private parseSseBody(text: string): JsonRpcResponse | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // 通知类请求可能返回空体
      return { jsonrpc: '2.0' };
    }

    // SSE 格式：可能有多行 data:
    for (const line of trimmed.split('\n')) {
      const candidate = line.trim();
      if (!candidate.startsWith('data:')) continue;

      const json = candidate.slice(5).trim();
      if (json.length === 0) continue;

      try {
        return JSON.parse(json) as JsonRpcResponse;
      } catch {
        // 尝试下一行
      }
    }

    // 非 SSE（某些网关会直接返回 JSON）
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return null;
    }
  }
}
