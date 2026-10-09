/**
 * 贝壳 MCP 全工具可用性诊断（第四阶段）
 * ============================================================================
 * 目的
 * ============================================================================
 * 前三阶段已确认：
 *   ① Key 有效、Endpoint 正确、initialize 握手成功（布丁MCP服务 v3.4.7）
 *   ② 不带 `X-Beike-Cli-Version` 时 tools/list 被拒（CLI_UPGRADE_REQUIRED）
 *   ③ 带上该头后 tools/list 成功，返回 18 个工具
 *   ④ 但数据查询全部返回 {"error":"service temporarily unavailable","ok":false}
 *
 * 遗留问题：**18 个工具里到底有没有能用的？** 之前的探测只覆盖了 5 个工具，
 * 而且用的是 CLI 的子命令名（buy_search / buy_plate ...），与 MCP 的真实工具名
 * （house_search / plate_search ...）并不一致，等于没测到点上。
 *
 * 本脚本逐一调用真实的 18 个工具，给出可判定的结论。
 *
 * ============================================================================
 * 实现要点
 * ============================================================================
 * 1. 只读诊断：不碰任何业务代码，直连 MCP。
 * 2. 每个请求都带 `X-Beike-Cli-Version: 0.2.26`（缺了会被判版本过低）。
 * 3. 协议顺序：initialize → notifications/initialized → tools/call。
 * 4. 参数不写死：先 tools/list 拿到 inputSchema，**按 schema 的 required 自动
 *    构造最小参数**（贝壳的工具参数名各不相同，写死必然踩空）。
 * 5. 有副作用的工具直接跳过（见 SKIPPED_TOOLS），不做任何写操作/数据外发。
 * 6. 每次调用间隔 300ms，避免限流。
 * 7. 兼容 Node 的 strip-only 类型擦除模式：不用 TS 参数属性 / enum / namespace。
 *
 * 用法：
 *   cd apps/api
 *   $env:BEIKE_MCP_API_KEY = '<KEY>'
 *   node --experimental-strip-types --no-warnings scripts/test-beike-all-tools.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = (process.env.BEIKE_MCP_API_KEY ?? '').trim();
const BASE_URL = (process.env.BEIKE_MCP_BASE_URL ?? '').trim() || 'https://building.ke.com/mcp';
/** 必须带，否则 tools/list 被拒（CLI_UPGRADE_REQUIRED） */
const CLI_VERSION = (process.env.BEIKE_CLI_VERSION ?? '').trim() || '0.2.26';

/** 每次 tools/call 之间的间隔（限流保护） */
const CALL_INTERVAL_MS = 300;
/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 40_000;
/** 测试用城市 */
const CITY = '上海';

/**
 * 跳过清单：这两个工具有副作用，只读诊断绝不调用。
 */
const SKIPPED_TOOLS: Array<{ name: string; reason: string }> = [
  {
    name: 'wecom_add_contact_qrcode',
    reason: '有副作用：会为指定经纪人生成并登记企微专属活码（写操作，且会暴露联系人入口）',
  },
  {
    name: 'report_user_intent',
    reason: '有副作用：会把用户原始查询与需求上下文上报到贝壳分析后台（数据外发）',
  },
];

/** 每个工具用的自然语言 query（贝壳的查询工具基本都吃自然语言） */
const QUERY_BY_TOOL: Record<string, string> = {
  house_search: '浦东三房',
  newhouse_search: '浦东新盘',
  resblock_search: '张江',
  plate_search: '浦东',
  rent_house_search: '张江整租一居室',
  policy_search: '上海购房资格与首付比例',
  decorate_search: '上海浦东现代简约风格装修案例',
  house_rank_search: '浦东热门房源排行榜',
  resblock_rank_search: '浦东热门小区排行榜',
  agent_search: '张江房产经纪人',
  store_search: '张江门店',
  entity_resolution: '张江',
};

/** 业务分类（便于报告分组） */
const CATEGORY_BY_TOOL: Record<string, string> = {
  house_search: '二手房',
  newhouse_search: '新房',
  resblock_search: '小区',
  plate_search: '板块',
  rent_house_search: '租房',
  policy_search: '政策',
  decorate_search: '装修案例',
  house_rank_search: '榜单',
  resblock_rank_search: '榜单',
  agent_search: '经纪人',
  store_search: '门店',
  entity_resolution: '实体',
  entity_detail: '实体',
  entity_material: '实体',
  decor_store_search: '装修门店',
  decor_price_query: '装修报价',
  wecom_add_contact_qrcode: '企微（跳过）',
  report_user_intent: '上报（跳过）',
};

/** 若前面没有任何工具返回真实 ID，用 schema 示例里的 ID 兜底 */
const FALLBACK_ENTITY_IDS = '1111027378138';
const FALLBACK_ENTITY_TYPE = 'house';

// ============================================================================
// 类型（只做类型标注，全部可被 strip-only 擦除）
// ============================================================================

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: { type?: string; enum?: unknown[] };
  minItems?: number;
}

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

interface RpcOutcome {
  status: number;
  ms: number;
  payload: Record<string, unknown> | null;
  raw: string;
  error?: string;
}

type ToolStatus =
  | 'OK'
  | 'SERVICE_DOWN'
  | 'TOOL_ERROR'
  | 'RPC_ERROR'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'NOT_CALLED';

interface CallDiagnosis {
  status: ToolStatus;
  evidence: string;
  errorText: string;
  entityIds: string[];
}

interface ToolReport {
  name: string;
  category: string;
  status: ToolStatus;
  httpStatus: number;
  ms: number;
  args: Record<string, unknown>;
  evidence: string;
  errorText: string;
  responseChars: number;
}

/** 从前面成功工具里学到的真实 ID，供 entity_detail / entity_material 使用 */
const hints: { entityIds: string; entityType: string } = {
  entityIds: FALLBACK_ENTITY_IDS,
  entityType: FALLBACK_ENTITY_TYPE,
};

// ============================================================================
// 小工具
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 是否宽字符（中日韩），用于终端对齐 */
function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code > 0x2e80 && code < 0xfe70;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += isWide(char) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const char of text) {
    const w = isWide(char) ? 2 : 1;
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }
  return `${out}…`;
}

function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

function section(title: string): void {
  console.log('');
  console.log('─'.repeat(78));
  console.log(title);
  console.log('─'.repeat(78));
}

// ============================================================================
// MCP 传输层
// ============================================================================

/** 解析响应：MCP 走 SSE（`event: message\ndata: {...}`），也兼容裸 JSON */
function parseRpcPayload(text: string): Record<string, unknown> | null {
  const payloads: Record<string, unknown>[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const json = trimmed.slice(5).trim();
    if (json.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === 'object') payloads.push(parsed as Record<string, unknown>);
    } catch {
      // 忽略无法解析的行，继续找下一条
    }
  }

  if (payloads.length === 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') payloads.push(parsed as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  // 优先取带 result / error 的那条
  for (const payload of payloads) {
    if (payload['result'] !== undefined || payload['error'] !== undefined) return payload;
  }
  return payloads[0] ?? null;
}

/** 服务端若下发 session id，后续请求要带上 */
let sessionId: string | null = null;

async function rpc(
  method: string,
  params: unknown,
  id: number,
  isNotification = false,
): Promise<RpcOutcome> {
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    // 关键：缺这个头会被判定"未检测到 CLI 版本" → CLI_UPGRADE_REQUIRED
    'X-Beike-Cli-Version': CLI_VERSION,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
  if (!isNotification) body['id'] = id;

  try {
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) sessionId = returnedSession;

    const raw = await response.text();

    return {
      status: response.status,
      ms: Date.now() - startedAt,
      payload: parseRpcPayload(raw),
      raw,
    };
  } catch (error) {
    return {
      status: 0,
      ms: Date.now() - startedAt,
      payload: null,
      raw: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// 结果解读
// ============================================================================

const NAME_KEYS = [
  'name',
  'title',
  'resblock_name',
  'community_name',
  'house_title',
  'plate_name',
  'store_name',
  'agent_name',
  'entity_name',
  'zh_name',
  'brand_name',
];

function collectEntityIds(value: unknown, out: string[], depth: number): void {
  if (depth > 6 || out.length >= 4) return;
  if (Array.isArray(value)) {
    for (const item of value) collectEntityIds(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(entity_id|house_id|resblock_id|newhouse_id|id)$/i.test(key)) {
      const text = String(child ?? '').trim();
      if (/^\d{6,}$/.test(text) && !out.includes(text)) out.push(text);
    }
    collectEntityIds(child, out, depth + 1);
  }
}

function findArrayInfo(value: unknown): { length: number; key: string } | null {
  const queue: Array<{ node: unknown; key: string }> = [{ node: value, key: '' }];
  let firstAny: { length: number; key: string } | null = null;
  let guard = 0;

  while (queue.length > 0 && guard < 300) {
    guard += 1;
    const current = queue.shift();
    if (!current) break;
    const node = current.node;

    if (Array.isArray(node)) {
      if (node.length > 0) {
        const hit = { length: node.length, key: current.key };
        if (!firstAny) firstAny = hit;
        if (/data|list|items|result|houses|resblocks|entities|records|stores|agents/i.test(current.key)) {
          return hit;
        }
      }
      for (const item of node.slice(0, 3)) queue.push({ node: item, key: current.key });
      continue;
    }

    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        queue.push({ node: child, key });
      }
    }
  }

  return firstAny;
}

function findDisplayName(value: unknown, depth: number): string | null {
  if (depth > 5) return null;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 2)) {
      const found = findDisplayName(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  for (const key of NAME_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return oneLine(candidate, 60);
    }
  }
  for (const child of Object.values(record)) {
    const found = findDisplayName(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 汇总证据：返回条数 + 首个结果名 + 实体 ID 样例 */
function describePayload(text: string): { summary: string; entityIds: string[] } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { summary: '(返回内容为空)', entityIds: [] };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    return { summary: `非 JSON 文本：${oneLine(trimmed, 160)}`, entityIds: [] };
  }

  const entityIds: string[] = [];
  collectEntityIds(parsed, entityIds, 0);

  const arrayInfo = findArrayInfo(parsed);
  const name = findDisplayName(parsed, 0);

  const parts: string[] = [];
  if (arrayInfo) parts.push(`返回 ${arrayInfo.length} 条`);
  if (name) parts.push(`首个结果：${name}`);
  if (entityIds.length > 0) parts.push(`实体ID：${entityIds.slice(0, 2).join(',')}`);
  if (parts.length === 0) parts.push(oneLine(trimmed, 160));

  return { summary: parts.join(' | '), entityIds };
}

/** 提取 MCP 工具返回里的正文 */
function extractText(result: Record<string, unknown>): string {
  const content = result['content'];
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        if (typeof record['text'] === 'string') chunks.push(record['text']);
        else chunks.push(JSON.stringify(record));
      }
    }
    if (chunks.length > 0) return chunks.join('\n');
  }

  const structured = result['structuredContent'];
  if (structured && typeof structured === 'object') return JSON.stringify(structured);

  return JSON.stringify(result);
}

/** 识别 {"ok":false,"error":"..."} 这类业务错误 */
function extractApiError(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record['ok'] === false) {
    const err = record['error'] ?? record['message'] ?? record['msg'];
    return typeof err === 'string' ? err : oneLine(JSON.stringify(record), 200);
  }
  return null;
}

function diagnoseCall(outcome: RpcOutcome): CallDiagnosis {
  if (outcome.error) {
    return { status: 'NETWORK_ERROR', evidence: '', errorText: outcome.error, entityIds: [] };
  }

  if (outcome.status !== 200) {
    return {
      status: 'HTTP_ERROR',
      evidence: '',
      errorText: `HTTP ${outcome.status}：${oneLine(outcome.raw, 200)}`,
      entityIds: [],
    };
  }

  const payload = outcome.payload;
  if (!payload) {
    return {
      status: 'RPC_ERROR',
      evidence: '',
      errorText: `响应无法解析：${oneLine(outcome.raw, 200)}`,
      entityIds: [],
    };
  }

  const rpcError = payload['error'];
  if (rpcError && typeof rpcError === 'object') {
    const err = rpcError as Record<string, unknown>;
    const data = err['data'];
    let code: unknown = err['code'];
    if (data && typeof data === 'object') {
      const inner = (data as Record<string, unknown>)['code'];
      if (inner !== undefined) code = inner;
    }
    return {
      status: 'RPC_ERROR',
      evidence: '',
      errorText: `JSON-RPC 错误 ${String(code ?? '')}：${oneLine(String(err['message'] ?? ''), 200)}`,
      entityIds: [],
    };
  }

  const result = payload['result'];
  if (!result || typeof result !== 'object') {
    return {
      status: 'RPC_ERROR',
      evidence: '',
      errorText: `响应缺少 result：${oneLine(JSON.stringify(payload), 200)}`,
      entityIds: [],
    };
  }

  const resultRecord = result as Record<string, unknown>;
  const text = extractText(resultRecord);

  // 服务层不可用（这是本次诊断最关心的失败形态）
  if (/service temporarily unavailable/i.test(text)) {
    return {
      status: 'SERVICE_DOWN',
      evidence: '',
      errorText: 'service temporarily unavailable（服务层不可用）',
      entityIds: [],
    };
  }

  const described = describePayload(text);
  const apiError = extractApiError(text);

  if (resultRecord['isError'] === true || apiError) {
    return {
      status: 'TOOL_ERROR',
      evidence: described.summary,
      errorText: apiError ?? oneLine(text, 200),
      entityIds: described.entityIds,
    };
  }

  return {
    status: 'OK',
    evidence: described.summary,
    errorText: '',
    entityIds: described.entityIds,
  };
}

// ============================================================================
// 参数构造：按 inputSchema 的 required 生成最小参数
// ============================================================================

function buildValue(
  toolName: string,
  propName: string,
  prop: JsonSchemaProperty,
): unknown {
  // 动态 ID 优先（entity_detail / entity_material 需要真实 ID）
  if (propName === 'entity_ids') return hints.entityIds;

  // schema 里写了枚举 → 取第一个合法值
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];

  const type = prop.type ?? 'string';

  if (type === 'array') {
    if (propName === 'fields') return ['小区图片'];
    if (Array.isArray(prop.items?.enum) && prop.items.enum.length > 0) return [prop.items.enum[0]];
    return [QUERY_BY_TOOL[toolName] ?? CITY];
  }

  if (type === 'integer' || type === 'number') {
    if (propName === 'area') return 90;
    // decor_price_query.house_type：1=新房，2=老房（二手房）
    if (propName === 'house_type') return 2;
    if (propName === 'room_cnt') return 3;
    if (propName === 'parlor_cnt') return 1;
    if (propName === 'cookroom_cnt') return 1;
    if (propName === 'toilet_cnt') return 1;
    if (propName === 'from_im') return 0;
    if (propName === 'agent_ucid') return 1;
    return 1;
  }

  if (type === 'boolean') return false;

  if (propName === 'query') return QUERY_BY_TOOL[toolName] ?? CITY;
  if (propName === 'city_name') return CITY;
  if (propName === 'entity_type') return hints.entityType;
  // 字符串形态的 house_type（CLI 用 second/new/all）
  if (propName === 'house_type') return 'second';

  return QUERY_BY_TOOL[toolName] ?? CITY;
}

/** 只填 required 字段 —— 最小参数原则 */
function buildMinimalArgs(tool: McpTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  const args: Record<string, unknown> = {};
  if (!schema) return args;

  const required = schema.required ?? [];
  const properties = schema.properties ?? {};

  for (const propName of required) {
    const prop = properties[propName] ?? {};
    args[propName] = buildValue(tool.name, propName, prop);
  }

  // entity_detail / entity_material：entity_type 若不是字符串枚举，确保是英文枚举值
  if ((tool.name === 'entity_detail' || tool.name === 'entity_material') && 'entity_type' in args) {
    args['entity_type'] = hints.entityType;
  }

  return args;
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  console.log('贝壳 MCP 全工具可用性诊断（test-beike-all-tools）');
  console.log('只读诊断：不修改任何业务代码，不调用有副作用的工具');
  console.log('');
  console.log(`  Endpoint              ${BASE_URL}`);
  console.log(`  Authorization         Bearer ${API_KEY ? maskKey(API_KEY) : '(未设置)'}`);
  console.log(`  X-Beike-Cli-Version   ${CLI_VERSION}`);
  console.log(`  调用间隔              ${CALL_INTERVAL_MS}ms`);

  if (!API_KEY) {
    console.error('');
    console.error('✗ 缺少 BEIKE_MCP_API_KEY，无法继续。');
    process.exitCode = 1;
    return;
  }

  // --------------------------------------------------------------------------
  section('[1] initialize 握手');
  // --------------------------------------------------------------------------

  const init = await rpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-all-tools-diagnostic', version: '1.0.0' },
    },
    1,
  );

  console.log(`  HTTP ${init.status} | ${init.ms}ms`);

  const initResult = (init.payload?.['result'] ?? null) as Record<string, unknown> | null;
  const serverInfo = (initResult?.['serverInfo'] ?? null) as Record<string, unknown> | null;

  if (serverInfo) {
    console.log(`  服务端              ${String(serverInfo['name'])} v${String(serverInfo['version'])}`);
  } else if (init.payload?.['error']) {
    console.log(`  ✗ 握手失败：${oneLine(JSON.stringify(init.payload['error']), 200)}`);
  }

  // MCP 协议要求的 initialized 通知
  const notified = await rpc('notifications/initialized', {}, 2, true);
  console.log(`  notifications/initialized → HTTP ${notified.status} | ${notified.ms}ms`);

  if (!serverInfo) {
    console.log('');
    console.log('  ✗ initialize 未成功，后续 tools/list 与 tools/call 无意义，终止。');
    if (init.raw.length > 0) console.log(`  原始响应：${oneLine(init.raw, 500)}`);
    process.exitCode = 1;
    return;
  }

  // --------------------------------------------------------------------------
  section('[2] tools/list —— 获取工具清单与 inputSchema');
  // --------------------------------------------------------------------------

  await sleep(CALL_INTERVAL_MS);
  const list = await rpc('tools/list', {}, 3);
  console.log(`  HTTP ${list.status} | ${list.ms}ms`);

  const listResult = (list.payload?.['result'] ?? null) as Record<string, unknown> | null;
  const tools = ((listResult?.['tools'] ?? []) as McpTool[]).filter(
    (tool) => tool && typeof tool.name === 'string',
  );

  if (tools.length === 0) {
    console.log('  ✗ 未获取到任何工具。');
    if (list.payload?.['error']) {
      console.log(`  错误：${oneLine(JSON.stringify(list.payload['error']), 400)}`);
    }
    console.log(`  原始响应：${oneLine(list.raw, 400)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`  共 ${tools.length} 个工具：${tools.map((tool) => tool.name).join(', ')}`);

  // --------------------------------------------------------------------------
  section('[3] tools/call —— 逐个调用（有副作用的工具跳过）');
  // --------------------------------------------------------------------------

  const skipMap = new Map<string, string>();
  for (const item of SKIPPED_TOOLS) skipMap.set(item.name, item.reason);

  const reports: ToolReport[] = [];
  let rpcId = 100;

  for (const [index, tool] of tools.entries()) {
    const category = CATEGORY_BY_TOOL[tool.name] ?? '其他';

    // ---- 跳过的工具 ----
    const skipReason = skipMap.get(tool.name);
    if (skipReason) {
      console.log('');
      console.log(`  [${index + 1}/${tools.length}] ${tool.name}（${category}）`);
      console.log(`    ⏭ 已跳过：${skipReason}`);
      reports.push({
        name: tool.name,
        category,
        status: 'NOT_CALLED',
        httpStatus: 0,
        ms: 0,
        args: {},
        evidence: `跳过（${skipReason}）`,
        errorText: '',
        responseChars: 0,
      });
      continue;
    }

    if (reports.length > 0) await sleep(CALL_INTERVAL_MS);

    const args = buildMinimalArgs(tool);
    rpcId += 1;
    const outcome = await rpc('tools/call', { name: tool.name, arguments: args }, rpcId);
    const diagnosis = diagnoseCall(outcome);

    // 学到真实 ID → 供 entity_detail / entity_material 使用
    if (diagnosis.entityIds.length > 0) {
      hints.entityIds = diagnosis.entityIds.slice(0, 2).join(',');
      if (tool.name === 'resblock_search' || tool.name === 'resblock_rank_search') {
        hints.entityType = 'resblock';
      } else if (tool.name === 'house_search' || tool.name === 'house_rank_search') {
        hints.entityType = 'house';
      } else if (tool.name === 'newhouse_search') {
        hints.entityType = 'newhouse';
      }
    }

    const mark =
      diagnosis.status === 'OK'
        ? '✅ 可用'
        : diagnosis.status === 'SERVICE_DOWN'
          ? '⛔ 服务层不可用'
          : '❌ 失败';

    console.log('');
    console.log(`  [${index + 1}/${tools.length}] ${tool.name}（${category}）`);
    console.log(`    HTTP ${outcome.status} | ${outcome.ms}ms | ${mark}`);
    console.log(`    参数        ${oneLine(JSON.stringify(args), 160)}`);

    if (diagnosis.status === 'OK') {
      console.log(`    证据        ${diagnosis.evidence}`);
    } else {
      console.log(`    错误        ${diagnosis.errorText}`);
      if (diagnosis.evidence) console.log(`    附带信息    ${diagnosis.evidence}`);
    }

    reports.push({
      name: tool.name,
      category,
      status: diagnosis.status,
      httpStatus: outcome.status,
      ms: outcome.ms,
      args,
      evidence: diagnosis.evidence,
      errorText: diagnosis.errorText,
      responseChars: outcome.raw.length,
    });
  }

  // --------------------------------------------------------------------------
  section('[4] 结论表');
  // --------------------------------------------------------------------------

  const statusLabel: Record<ToolStatus, string> = {
    OK: '✅ 可用',
    SERVICE_DOWN: '⛔ 服务层不可用',
    TOOL_ERROR: '❌ 工具报错',
    RPC_ERROR: '❌ 协议错误',
    HTTP_ERROR: '❌ HTTP 错误',
    NETWORK_ERROR: '❌ 网络错误',
    NOT_CALLED: '⏭ 已跳过',
  };

  console.log(
    `${pad('工具名', 26)}${pad('类别', 12)}${pad('状态', 18)}${pad('耗时', 10)}证据 / 错误`,
  );
  console.log('─'.repeat(78));

  for (const report of reports) {
    const note =
      report.status === 'OK' ? report.evidence : report.errorText || report.evidence || '(无)';
    console.log(
      `${pad(report.name, 26)}${pad(report.category, 12)}${pad(statusLabel[report.status], 18)}` +
        `${pad(report.status === 'NOT_CALLED' ? '-' : `${report.ms}ms`, 10)}${truncate(note, 60)}`,
    );
  }

  // --------------------------------------------------------------------------
  const usable = reports.filter((report) => report.status === 'OK');
  const serviceDown = reports.filter((report) => report.status === 'SERVICE_DOWN');
  const otherFailed = reports.filter(
    (report) =>
      report.status !== 'OK' && report.status !== 'SERVICE_DOWN' && report.status !== 'NOT_CALLED',
  );
  const skipped = reports.filter((report) => report.status === 'NOT_CALLED');

  section('[5] 可用工具清单');
  if (usable.length === 0) {
    console.log('  （无）');
  } else {
    for (const report of usable) {
      console.log(`  ✅ ${report.name}（${report.category}）${report.ms}ms`);
      console.log(`     参数：${oneLine(JSON.stringify(report.args), 140)}`);
      console.log(`     证据：${report.evidence}`);
    }
  }

  section('[6] 不可用工具清单');
  if (serviceDown.length === 0 && otherFailed.length === 0) {
    console.log('  （无）');
  }
  if (serviceDown.length > 0) {
    console.log(`  ⛔ 服务层不可用（service temporarily unavailable）共 ${serviceDown.length} 个：`);
    console.log(`     ${serviceDown.map((report) => report.name).join(', ')}`);
  }
  if (otherFailed.length > 0) {
    console.log('');
    console.log(`  ❌ 其他失败共 ${otherFailed.length} 个：`);
    for (const report of otherFailed) {
      console.log(`     ${report.name}（${statusLabel[report.status]}）：${oneLine(report.errorText, 140)}`);
    }
  }
  if (skipped.length > 0) {
    console.log('');
    console.log(`  ⏭ 未调用（有副作用，按只读要求跳过）共 ${skipped.length} 个：`);
    for (const report of skipped) {
      console.log(`     ${report.name}：${report.evidence}`);
    }
  }

  // --------------------------------------------------------------------------
  section('[7] 最终判定');
  // --------------------------------------------------------------------------

  const called = reports.filter((report) => report.status !== 'NOT_CALLED');
  const verdict =
    usable.length === 0
      ? '全部不可用（服务端故障）'
      : usable.length === called.length
        ? '全部可用'
        : '部分可用';

  console.log(`  实际调用：${called.length} 个（跳过 ${skipped.length} 个）`);
  console.log(`  可用：    ${usable.length} 个`);
  console.log(`  服务层不可用：${serviceDown.length} 个`);
  console.log(`  其他失败：${otherFailed.length} 个`);
  console.log('');
  console.log(`  ★ 最终判定：${verdict}`);

  if (verdict === '全部不可用（服务端故障）') {
    console.log('     Key / Endpoint / 协议 / 版本头全部正确，失败发生在贝壳服务端的数据层；');
    console.log('     我方无法通过改参数或改客户端修复，只能等待对方恢复或切换数据源。');
  } else if (verdict === '部分可用') {
    console.log('    → 属于功能级故障：只有部分工具挂了，可用的那些应优先接入。');
  }

  // --------------------------------------------------------------------------
  section('[8] 能否替代当前使用的 buy search');
  // --------------------------------------------------------------------------

  const houseSearch = reports.find((report) => report.name === 'house_search');
  const alternatives = ['house_search', 'newhouse_search', 'rent_house_search', 'resblock_search']
    .map((name) => reports.find((report) => report.name === name))
    .filter((report): report is ToolReport => Boolean(report));

  console.log('  当前 CLI 走的路径：beike buy search → MCP 工具 house_search');
  console.log('  （注意：tools/list 里没有 buy_search，CLI 子命令名与 MCP 工具名不是一回事）');
  console.log('');

  for (const report of alternatives) {
    const flag = report.status === 'OK' ? '✅ 可替代' : statusLabel[report.status];
    console.log(`  ${pad(report.name, 20)}${flag}`);
  }

  console.log('');
  if (houseSearch && houseSearch.status === 'OK') {
    console.log('  ★ house_search 可用 —— 它就是 buy search 的 MCP 对应工具，可直接替换。');
  } else if (usable.length > 0) {
    console.log(
      `  ★ house_search 不可用，但以下工具可用：${usable.map((report) => report.name).join(', ')}`,
    );
  } else {
    console.log('  ★ 无任何工具可用，当前不存在能替代 buy search 的工具。');
  }

  // --------------------------------------------------------------------------
  // 落盘一份 JSON，便于上游程序读取
  // --------------------------------------------------------------------------
  try {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const outDir = path.join(repoRoot, '.tmp-beike');
    mkdirSync(outDir, { recursive: true });

    const outputPath = path.join(outDir, 'beike-all-tools-report.json');
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          endpoint: BASE_URL,
          cliVersion: CLI_VERSION,
          server: serverInfo ? { name: serverInfo['name'], version: serverInfo['version'] } : null,
          toolCount: tools.length,
          calledCount: called.length,
          verdict,
          usable: usable.map((report) => report.name),
          serviceDown: serviceDown.map((report) => report.name),
          otherFailed: otherFailed.map((report) => ({ name: report.name, error: report.errorText })),
          skipped: skipped.map((report) => report.name),
          reports,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log('');
    console.log(`  报告已写入：${outputPath}`);
  } catch (error) {
    console.log('');
    console.log(`  （报告落盘失败，不影响结论：${error instanceof Error ? error.message : String(error)}）`);
  }
}

main().catch((error) => {
  console.error('诊断脚本异常：', error);
  process.exitCode = 1;
});
