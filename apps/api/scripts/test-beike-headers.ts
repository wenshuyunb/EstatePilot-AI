/**
 * 贝壳 MCP 报文头诊断（第三阶段）—— 验证 X-Beike-Cli-Version
 *
 * ============================================================================
 * 背景
 * ============================================================================
 * 前两阶段结论：
 *   ✓ Key 有效、Endpoint 正确、initialize 握手成功（服务端：布丁MCP服务 v3.4.7）
 *   ✗ tools/list 返回 -32001「未检测到 CLI 版本，视为版本过低」
 *
 * 从 CLI 二进制里提取到关键 header 名：`X-Beike-Cli-Version`
 * 以及 `beike-mcp-proxy`（提示可能存在代理层）。
 *
 * 本脚本验证：**补上版本头是否就能通过**。
 * 这能确定问题是「CLI 没发版本头」还是「服务端确实故障」。
 *
 * 用法：
 *   node --experimental-strip-types scripts/test-beike-headers.ts
 */

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';

function parseSse(text: string): unknown | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try {
      return JSON.parse(trimmed.slice(5).trim());
    } catch {
      // 尝试下一行
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface ProbeResult {
  label: string;
  status: number;
  ms: number;
  body: string;
  parsed: unknown;
}

async function probe(
  label: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<ProbeResult> {
  const startedAt = Date.now();

  try {
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();

    return {
      label,
      status: response.status,
      ms: Date.now() - startedAt,
      body: text,
      parsed: parseSse(text),
    };
  } catch (error) {
    return {
      label,
      status: 0,
      ms: Date.now() - startedAt,
      body: error instanceof Error ? error.message : String(error),
      parsed: null,
    };
  }
}

/** 提取可读结论 */
function verdict(result: ProbeResult): string {
  const root = result.parsed as Record<string, unknown> | null;

  if (root?.['error']) {
    const err = root['error'] as Record<string, unknown>;
    const data = err['data'] as Record<string, unknown> | undefined;
    const code = data?.['code'] ?? err['code'];
    return `❌ 被拒绝（${String(code)}）：${String(err['message'] ?? '').slice(0, 90)}`;
  }

  const resultObj = root?.['result'] as Record<string, unknown> | undefined;
  if (!resultObj) return `⚠ 无法解析（HTTP ${result.status}）`;

  const tools = resultObj['tools'];
  if (Array.isArray(tools)) {
    return `✅ 成功：返回 ${tools.length} 个工具`;
  }
  if (resultObj['serverInfo']) {
    const info = resultObj['serverInfo'] as Record<string, unknown>;
    return `✅ 握手成功：${String(info['name'])} v${String(info['version'])}`;
  }

  return `⚠ 成功但结构未知：${JSON.stringify(resultObj).slice(0, 100)}`;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('贝壳 MCP 报文头诊断');
  console.log(`Endpoint: ${BASE_URL}`);
  console.log('');

  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-header-diagnostic', version: '1.0.0' },
    },
  };

  const listBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

  // --------------------------------------------------------------------------
  console.log('─'.repeat(74));
  console.log('[实验 1] 不带版本头（复现当前失败）');
  console.log('─'.repeat(74));

  const init1 = await probe('initialize 无版本头', initBody);
  console.log(`  initialize   HTTP ${init1.status} | ${init1.ms}ms | ${verdict(init1)}`);

  const list1 = await probe('tools/list 无版本头', listBody);
  console.log(`  tools/list   HTTP ${list1.status} | ${list1.ms}ms | ${verdict(list1)}`);

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[实验 2] 带 X-Beike-Cli-Version: 0.2.26（本地 CLI 版本）');
  console.log('─'.repeat(74));

  const versionHeader = { 'X-Beike-Cli-Version': '0.2.26' };

  const init2 = await probe('initialize 带版本头', initBody, versionHeader);
  console.log(`  initialize   HTTP ${init2.status} | ${init2.ms}ms | ${verdict(init2)}`);

  const list2 = await probe('tools/list 带版本头', listBody, versionHeader);
  console.log(`  tools/list   HTTP ${list2.status} | ${list2.ms}ms | ${verdict(list2)}`);

  if (list2.status === 200) {
    const root = list2.parsed as Record<string, unknown> | null;
    const tools = ((root?.['result'] as Record<string, unknown> | undefined)?.['tools'] ?? []) as Array<{
      name: string;
    }>;
    if (tools.length > 0) {
      console.log('');
      console.log(`  发现 ${tools.length} 个工具：`);
      for (const tool of tools) console.log(`    · ${tool.name}`);
    }
  }

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[实验 3] 追加 User-Agent（有些网关按 UA 判定客户端）');
  console.log('─'.repeat(74));

  const fullHeaders = {
    ...versionHeader,
    'User-Agent': 'beike-cli/0.2.26',
  };

  const list3 = await probe('tools/list 带版本头+UA', listBody, fullHeaders);
  console.log(`  tools/list   HTTP ${list3.status} | ${list3.ms}ms | ${verdict(list3)}`);

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[结论]');
  console.log('─'.repeat(74));

  const withoutHeader = verdict(list1);
  const withHeader = verdict(list2);

  console.log(`  不带版本头:  ${withoutHeader}`);
  console.log(`  带版本头:    ${withHeader}`);
  console.log('');

  if (withoutHeader.startsWith('❌') && withHeader.startsWith('✅')) {
    console.log('  ★ 结论：问题是「CLI 未发送 X-Beike-Cli-Version 头」');
    console.log('    Key、Endpoint、协议格式全部正确。');
    console.log('    修复方向：让 CLI 补上该头，或在调用层补发。');
  } else if (withoutHeader.startsWith('❌') && withHeader.startsWith('❌')) {
    console.log('  ★ 结论：加版本头也无效 → 服务端确实不可用');
    console.log('    Key 有效但数据服务故障，我方无法修复。');
    console.log('');
    console.log(`    服务端返回的完整错误：`);
    console.log(`    ${list2.body.slice(0, 400)}`);
  } else {
    console.log('  ★ 结论：不带版本头也能成功 → 之前的失败可能是服务端抖动');
    console.log('    建议重复运行几次确认稳定性。');
  }
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
