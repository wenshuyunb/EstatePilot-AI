/**
 * 精确复刻 BeikeDirectClient 的调用序列，定位 -32602
 *
 * 已知：手动直连 tools/call 能到达服务层（返回 service temporarily unavailable）。
 * 但客户端实现返回 -32602 Invalid request parameters。
 * 说明客户端某一步与手动调用有差异。本脚本逐步复刻并打印每一帧。
 *
 * 用法：node --experimental-strip-types scripts/diagnose-direct-client.ts
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

interface Frame {
  label: string;
  requestBody: string;
  status: number;
  ms: number;
  responseBody: string;
  parsed: unknown;
}

/** 完全复刻客户端的 rpc() 实现 */
async function rpc(body: unknown, label: string): Promise<Frame> {
  const startedAt = Date.now();

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Beike-Cli-Version': CLI_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();

  return {
    label,
    requestBody: JSON.stringify(body),
    status: response.status,
    ms: Date.now() - startedAt,
    responseBody: text,
    parsed: parseSse(text),
  };
}

function report(frame: Frame): void {
  const parsed = frame.parsed as Record<string, unknown> | null;
  const error = parsed?.['error'] as Record<string, unknown> | undefined;
  const result = parsed?.['result'] as Record<string, unknown> | undefined;

  console.log('');
  console.log(`  ── ${frame.label} ──`);
  console.log(`  请求: ${frame.requestBody.slice(0, 220)}`);
  console.log(`  HTTP ${frame.status} | ${frame.ms}ms`);

  if (error) {
    console.log(`  ❌ 错误 code=${String(error['code'])}: ${String(error['message'] ?? '')}`);
    if (error['data']) {
      console.log(`     data: ${JSON.stringify(error['data']).slice(0, 300)}`);
    }
  } else if (result) {
    const content = result['content'];
    if (Array.isArray(content)) {
      const text = content
        .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>)['text'] ?? '') : ''))
        .join(' ');
      console.log(`  工具返回: isError=${String(result['isError'])} text="${text.slice(0, 120)}"`);
    } else if (result['tools']) {
      console.log(`  ✓ 返回 ${(result['tools'] as unknown[]).length} 个工具`);
    } else if (result['serverInfo']) {
      const info = result['serverInfo'] as Record<string, unknown>;
      console.log(`  ✓ 握手成功: ${String(info['name'])} v${String(info['version'])}`);
    } else {
      console.log(`  ✓ 返回: ${JSON.stringify(result).slice(0, 200)}`);
    }
  } else {
    console.log(`  响应体: ${frame.responseBody.slice(0, 200) || '(空)'}`);
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  const frames: Frame[] = [];

  // ------------------------------------------------------------------------
  console.log('='.repeat(74));
  console.log('[A] 变体 1：完全按客户端实现（id 从 1 开始，notifications 也带 id）');
  console.log('='.repeat(74));

  let rpcId = 0;

  frames.push(
    await rpc(
      {
        jsonrpc: '2.0',
        id: (rpcId += 1),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'estatepilot-ai', version: '1.0.0' },
        },
      },
      'A1 initialize',
    ),
  );
  report(frames[frames.length - 1]!);

  frames.push(
    await rpc(
      { jsonrpc: '2.0', id: (rpcId += 1), method: 'notifications/initialized', params: {} },
      'A2 notifications/initialized（带 id）',
    ),
  );
  report(frames[frames.length - 1]!);

  frames.push(
    await rpc(
      { jsonrpc: '2.0', id: (rpcId += 1), method: 'tools/call', params: { name: 'house_search', arguments: { query: '浦东三房', city_name: '上海' } } },
      'A3 tools/call',
    ),
  );
  report(frames[frames.length - 1]!);

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[B] 变体 2：notifications 不带 id（符合 JSON-RPC 规范）');
  console.log('='.repeat(74));

  let rpcId2 = 100;

  frames.push(
    await rpc(
      {
        jsonrpc: '2.0',
        id: (rpcId2 += 1),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'estatepilot-ai', version: '1.0.0' },
        },
      },
      'B1 initialize',
    ),
  );
  report(frames[frames.length - 1]!);

  frames.push(
    await rpc(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      'B2 notifications/initialized（不带 id、不带 params）',
    ),
  );
  report(frames[frames.length - 1]!);

  frames.push(
    await rpc(
      { jsonrpc: '2.0', id: (rpcId2 += 1), method: 'tools/call', params: { name: 'house_search', arguments: { query: '浦东三房', city_name: '上海' } } },
      'B3 tools/call',
    ),
  );
  report(frames[frames.length - 1]!);

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[C] 变体 3：跳过 notifications，直接 initialize → tools/call');
  console.log('='.repeat(74));

  let rpcId3 = 200;

  frames.push(
    await rpc(
      {
        jsonrpc: '2.0',
        id: (rpcId3 += 1),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'estatepilot-ai', version: '1.0.0' },
        },
      },
      'C1 initialize',
    ),
  );
  report(frames[frames.length - 1]!);

  frames.push(
    await rpc(
      { jsonrpc: '2.0', id: (rpcId3 += 1), method: 'tools/call', params: { name: 'house_search', arguments: { query: '浦东三房', city_name: '上海' } } },
      'C2 tools/call（跳过 notifications）',
    ),
  );
  report(frames[frames.length - 1]!);

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[结论]');
  console.log('='.repeat(74));

  const results = frames.map((frame) => {
    const parsed = frame.parsed as Record<string, unknown> | null;
    const error = parsed?.['error'] as Record<string, unknown> | undefined;
    const result = parsed?.['result'] as Record<string, unknown> | undefined;
    const content = result?.['content'];
    const text = Array.isArray(content)
      ? content
          .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>)['text'] ?? '') : ''))
          .join(' ')
      : '';

    return {
      label: frame.label,
      verdict: error
        ? `❌ -32602 类错误`
        : text.includes('temporarily unavailable')
          ? '✅ 到达服务层（服务不可用）'
          : result
            ? '✅ 成功'
            : '? 未知',
    };
  });

  for (const result of results) {
    console.log(`  ${result.verdict.padEnd(28)} ← ${result.label}`);
  }

  console.log('');
  const calls = results.filter((r) => r.label.includes('tools/call'));
  const working = calls.filter((c) => c.verdict.includes('到达服务层') || c.verdict.includes('成功'));

  if (working.length === calls.length) {
    console.log('  ★ 所有变体的 tools/call 都能到达服务层');
    console.log('    → 说明 -32602 是客户端代码里的其他问题（如并发/状态）');
  } else if (working.length > 0) {
    console.log('  ★ 只有部分变体成功 → 差异点就是原因');
    console.log(`    成功的: ${working.map((w) => w.label).join(', ')}`);
    console.log(`    失败的: ${calls.filter((c) => !working.includes(c)).map((c) => c.label).join(', ')}`);
  } else {
    console.log('  ★ 所有变体都失败 → 与请求序列无关，是参数或环境问题');
  }
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
