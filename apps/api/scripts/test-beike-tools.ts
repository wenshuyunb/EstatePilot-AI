/**
 * 贝壳 MCP 逐工具诊断（第二阶段）
 *
 * ============================================================================
 * 目的：定位失败发生在哪一层
 * ============================================================================
 * 第一阶段（test-beike-connection）已证明：
 *   ✓ Key 有效、Endpoint 正确、MCP 握手成功
 *   ✗ 数据查询工具全部返回 service temporarily unavailable
 *
 * 本阶段进一步区分三种可能：
 *   A. 整个工具层都不可用（服务端故障）
 *   B. 只有"数据类工具"不可用（数据引擎故障）
 *   C. 只有部分工具不可用（功能级故障）
 *
 * 做法：直连 MCP，先 tools/list 看清有哪些工具，
 * 再逐个 tools/call，比较每个工具的返回。
 *
 * ⚠️ 只读诊断：只调用查询类工具，不做任何写操作。
 *
 * 用法：
 *   node --experimental-strip-types scripts/test-beike-tools.ts
 */

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

/** 解析 MCP 的 SSE 响应格式（`event: message\ndata: {...}`） */
function parseSse(text: string): unknown | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const json = trimmed.slice(5).trim();
    try {
      return JSON.parse(json);
    } catch {
      // 继续尝试下一行
    }
  }
  return null;
}

async function callMcp(
  method: string,
  params: unknown,
  id: number,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; status: number; ms: number; json: unknown; raw: string; error?: string }> {
  const startedAt = Date.now();

  try {
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const raw = await response.text();
    const json = parseSse(raw) ?? safeJson(raw);

    // MCP 的 SSE 需要先 initialize，再发 notifications/initialized
    return { ok: response.ok, status: response.status, ms: Date.now() - startedAt, json, raw };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      json: null,
      raw: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 tools/call 结果里提取可读摘要 */
function summarize(json: unknown): string {
  if (!json || typeof json !== 'object') return '(无解析结果)';

  const root = json as Record<string, unknown>;

  // JSON-RPC 错误
  if (root['error']) {
    const err = root['error'] as Record<string, unknown>;
    return `JSON-RPC 错误: ${String(err['message'] ?? JSON.stringify(err)).slice(0, 160)}`;
  }

  const result = root['result'] as Record<string, unknown> | undefined;
  if (!result) return JSON.stringify(json).slice(0, 160);

  // MCP 工具返回通常在 content[] 里
  const content = result['content'];
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>)['text'] ?? '') : ''))
      .filter((text) => text.length > 0);

    const joined = texts.join(' ').trim();
    if (joined.length === 0) return '(content 为空)';

    if (/temporarily unavailable/i.test(joined)) return '⚠ service temporarily unavailable';
    if (/"ok"\s*:\s*false/i.test(joined)) {
      const match = /"error"\s*:\s*"([^"]*)"/.exec(joined);
      return `⚠ ok=false${match?.[1] ? ` (${match[1]})` : ''}`;
    }

    return joined.slice(0, 160).replace(/\n/g, ' ');
  }

  if (result['isError'] === true) return `⚠ isError=true: ${JSON.stringify(result).slice(0, 140)}`;

  return JSON.stringify(result).slice(0, 160);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('贝壳 MCP 逐工具诊断');
  console.log(`Endpoint: ${BASE_URL}`);
  console.log(`Key:      ${API_KEY.slice(0, 6)}****${API_KEY.slice(-4)}`);

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[1] initialize 握手');
  console.log('─'.repeat(74));

  const init = await callMcp(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-tool-diagnostic', version: '1.0.0' },
    },
    1,
  );

  console.log(`  HTTP ${init.status} | ${init.ms}ms`);
  const initResult = (init.json as Record<string, unknown> | null)?.['result'] as
    | Record<string, unknown>
    | undefined;
  const serverInfo = initResult?.['serverInfo'] as Record<string, unknown> | undefined;
  if (serverInfo) {
    console.log(`  服务端: ${String(serverInfo['name'])} v${String(serverInfo['version'])}`);
  }

  // 握手后的 initialized 通知（MCP 协议要求）
  await callMcp('notifications/initialized', {}, 2, 10_000);

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[2] tools/list —— 列出可用工具');
  console.log('─'.repeat(74));

  const listResult = await callMcp('tools/list', {}, 3);
  console.log(`  HTTP ${listResult.status} | ${listResult.ms}ms`);

  const listRoot = listResult.json as Record<string, unknown> | null;
  const tools = ((listRoot?.['result'] as Record<string, unknown> | undefined)?.['tools'] ??
    []) as McpTool[];

  console.log(`  发现 ${tools.length} 个工具`);
  for (const tool of tools) {
    console.log(`    · ${tool.name}`);
  }

  if (tools.length === 0) {
    console.log('');
    console.log('  ⚠ 没有发现任何工具 —— 这本身就是异常（doctor 报告 18 个）');
    console.log(`  原始响应: ${listResult.raw.slice(0, 400)}`);
    return;
  }

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[3] tools/call —— 逐个调用，定位失败层级');
  console.log('─'.repeat(74));

  /**
   * 挑选有代表性的工具做探测。
   *
   * 分类逻辑：
   *   房源类 → 业务最核心的数据
   *   行情类 → 另一类数据（可能走不同的后端）
   *   非数据类 → 如果连它都失败，说明是工具层整体故障
   */
  const probes: Array<{ tool: string; args: Record<string, unknown>; category: string }> = [
    { tool: 'buy_search', args: { city_name: '上海', query: '浦东三房', house_type: 'second' }, category: '房源' },
    { tool: 'buy_plate', args: { city_name: '上海', query: '张江' }, category: '板块' },
    { tool: 'buy_resblock', args: { city_name: '上海', query: '张江' }, category: '小区' },
    { tool: 'buy_market', args: { city_name: '上海', query: '浦东' }, category: '行情' },
    { tool: 'buy_rank', args: { city_name: '上海' }, category: '榜单' },
  ];

  // 只探测确实存在的工具名
  const availableNames = new Set(tools.map((tool) => tool.name));
  const runnable = probes.filter((probe) => availableNames.has(probe.tool));

  if (runnable.length === 0) {
    console.log('  探测列表里的工具名与 tools/list 不匹配，改用前 5 个工具试调');
    for (const tool of tools.slice(0, 5)) {
      runnable.push({ tool: tool.name, args: {}, category: '未知' });
    }
  }

  let failed = 0;
  let succeeded = 0;

  for (const [index, probe] of runnable.entries()) {
    const call = await callMcp(
      'tools/call',
      { name: probe.tool, arguments: probe.args },
      100 + index,
    );

    const summary = summarize(call.json);
    const isFail = summary.startsWith('⚠') || summary.startsWith('JSON-RPC');

    if (isFail) failed += 1;
    else succeeded += 1;

    console.log('');
    console.log(`  [${probe.category}] ${probe.tool}`);
    console.log(`    HTTP ${call.status} | ${call.ms}ms`);
    console.log(`    结果: ${summary}`);
    if (call.error) console.log(`    错误: ${call.error}`);
  }

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[4] 结论');
  console.log('─'.repeat(74));

  console.log(`  工具总数:   ${tools.length}`);
  console.log(`  探测成功:   ${succeeded}`);
  console.log(`  探测失败:   ${failed}`);
  console.log('');

  if (failed === 0) {
    console.log('  ✓ 所有探测工具均正常 —— 项目可以调用贝壳');
    console.log('    → 下一步应检查业务层（Provider / 编排器 / 解析器）');
  } else if (succeeded === 0) {
    console.log('  ✗ 所有探测工具均失败');
    console.log('    → 服务端数据平面整体不可用（我方无法修复）');
    console.log('    → Key 与协议均正确，问题是对方的服务状态');
  } else {
    console.log('  ⚠ 部分工具失败');
    console.log('    → 功能级故障，可考虑只使用正常的那些工具');
  }
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
