/**
 * MCP 会话流程诊断 —— 定位 -32602 的真正原因
 *
 * 现象：直连调用 tools/call 返回 -32602 Invalid request parameters，
 * 但 tools/list 成功。而另一份实现（子代理脚本）能正常调用到工具层。
 *
 * 本脚本把完整会话流程的**每一个响应头与响应体**都打出来，逐项对比。
 *
 * 用法：node --experimental-strip-types scripts/diagnose-mcp-session.ts
 */

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

function parseSse(text: string): unknown | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try {
      return JSON.parse(trimmed.slice(5).trim());
    } catch {
      // 下一行
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface StepResult {
  label: string;
  status: number;
  ms: number;
  sessionHeader: string | null;
  allHeaders: Record<string, string>;
  body: string;
  parsed: unknown;
}

async function step(
  label: string,
  body: unknown,
  sessionId: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<StepResult> {
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Beike-Cli-Version': CLI_VERSION,
    ...extraHeaders,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const collected: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    collected[key] = value;
  });

  return {
    label,
    status: response.status,
    ms: Date.now() - startedAt,
    sessionHeader: response.headers.get('mcp-session-id'),
    allHeaders: collected,
    body: await response.text(),
    parsed: null,
  };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('MCP 会话流程诊断');
  console.log(`Endpoint: ${BASE_URL}\n`);

  // ------------------------------------------------------------------------
  console.log('='.repeat(74));
  console.log('[1] initialize —— 看响应头里有没有 mcp-session-id');
  console.log('='.repeat(74));

  const init = await step(
    'initialize',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'estatepilot-session-diag', version: '1.0.0' },
      },
    },
    null,
  );

  console.log(`HTTP ${init.status} | ${init.ms}ms`);
  console.log(`mcp-session-id 头: ${init.sessionHeader ?? '(未下发)'}`);
  console.log('');
  console.log('全部响应头:');
  for (const [key, value] of Object.entries(init.allHeaders)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log('');
  console.log(`响应体前 400 字:`);
  console.log(`  ${init.body.slice(0, 400).replace(/\n/g, '\n  ')}`);

  const sessionId = init.sessionHeader;

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[2] notifications/initialized');
  console.log('='.repeat(74));

  const notify = await step(
    'notifications/initialized',
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    sessionId,
  );

  console.log(`HTTP ${notify.status} | ${notify.ms}ms`);
  console.log(`mcp-session-id 头: ${notify.sessionHeader ?? '(无)'}`);
  console.log(`响应体: ${notify.body.slice(0, 200) || '(空)'}`);

  const activeSession = notify.sessionHeader ?? sessionId;

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[3] tools/list（验证会话是否有效）');
  console.log('='.repeat(74));

  const list = await step(
    'tools/list',
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    activeSession,
  );

  const listParsed = parseSse(list.body) as Record<string, unknown> | null;
  const tools =
    ((listParsed?.['result'] as Record<string, unknown> | undefined)?.['tools'] ?? []) as unknown[];

  console.log(`HTTP ${list.status} | ${list.ms}ms`);
  console.log(`工具数: ${tools.length}`);
  if (listParsed?.['error']) {
    console.log(`错误: ${JSON.stringify(listParsed['error']).slice(0, 200)}`);
  }

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[4] tools/call house_search —— 关键步骤');
  console.log('='.repeat(74));

  const callBody = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'house_search',
      arguments: { query: '浦东三房', city_name: '上海' },
    },
  };

  console.log('请求体:');
  console.log(`  ${JSON.stringify(callBody)}`);
  console.log(`  会话 ID: ${activeSession ?? '(无)'}`);
  console.log('');

  const call = await step('tools/call', callBody, activeSession);

  const callParsed = parseSse(call.body) as Record<string, unknown> | null;

  console.log(`HTTP ${call.status} | ${call.ms}ms`);
  console.log(`mcp-session-id 头: ${call.sessionHeader ?? '(无)'}`);
  console.log('');
  console.log(`响应体前 500 字:`);
  console.log(`  ${call.body.slice(0, 500).replace(/\n/g, '\n  ')}`);

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[5] 对照：不带会话 ID 调用同一工具');
  console.log('='.repeat(74));

  const noSession = await step('tools/call 无会话', callBody, null);
  const noSessionParsed = parseSse(noSession.body) as Record<string, unknown> | null;

  console.log(`HTTP ${noSession.status} | ${noSession.ms}ms`);
  if (noSessionParsed?.['error']) {
    console.log(`错误: ${JSON.stringify(noSessionParsed['error']).slice(0, 250)}`);
  } else {
    console.log(`响应: ${noSession.body.slice(0, 250)}`);
  }

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[结论]');
  console.log('='.repeat(74));

  const withSessionError = callParsed?.['error'] as Record<string, unknown> | undefined;
  const withoutSessionError = noSessionParsed?.['error'] as Record<string, unknown> | undefined;

  console.log(`  下发会话 ID:        ${init.sessionHeader ? '是' : '否'}`);
  console.log(`  带会话 ID 调用:     ${withSessionError ? `错误 ${String(withSessionError['code'])}` : '成功/有结果'}`);
  console.log(`  不带会话 ID 调用:   ${withoutSessionError ? `错误 ${String(withoutSessionError['code'])}` : '成功/有结果'}`);
  console.log('');

  if (!init.sessionHeader) {
    console.log('  ★ 服务端未下发 mcp-session-id');
    console.log('    → 说明该服务端是无状态模式，会话 ID 不是 -32602 的原因');
    console.log('    → 需要从响应体的错误详情里找真正原因');
  } else if (withSessionError && !withoutSessionError) {
    console.log('  ★ 带会话 ID 反而失败 —— 会话 ID 可能是错的或已过期');
  } else if (withSessionError?.code === withoutSessionError?.code) {
    console.log('  ★ 会话 ID 不影响结果 —— 问题在参数或其他地方');
  } else {
    console.log('  ★ 会话 ID 有影响，已定位差异');
  }

  // 打印错误详情（往往包含具体哪个参数不对）
  if (withSessionError) {
    console.log('');
    console.log('  错误详情（可能指出具体参数问题）：');
    console.log(`  ${JSON.stringify(withSessionError, null, 2).slice(0, 600)}`);
  }
  if (callParsed?.['result']) {
    console.log('');
    console.log('  工具返回成功，内容：');
    console.log(`  ${JSON.stringify(callParsed['result']).slice(0, 400)}`);
  }
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
