/**
 * 决定性测试：带 X-Beike-Cli-Version 头直连调用 house_search
 *
 * ============================================================================
 * 为什么这一个测试就能定论
 * ============================================================================
 * 已知：
 *   ✓ Key 有效、Endpoint 正确、MCP 握手成功
 *   ✓ 不带版本头 → tools/list 被拒（CLI_UPGRADE_REQUIRED）
 *   ✓ 带版本头   → tools/list 成功，返回 18 个工具
 *   ✗ 通过 CLI 调用数据 → 全部 service temporarily unavailable
 *
 * 本测试用「带版本头的直连 HTTP」调用真正的房源搜索工具：
 *   若成功 → 问题在 CLI 层，可以绕过 CLI 修复（我方可控）
 *   若失败 → 服务端数据平面故障（我方无法修复）
 *
 * 用法：
 *   node --experimental-strip-types scripts/test-beike-direct.ts
 */

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

function parseSse(text: string): unknown | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try {
      return JSON.parse(trimmed.slice(5).trim());
    } catch {
      // 换下一行
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function mcp(
  method: string,
  params: unknown,
  id: number,
  timeoutMs = 40_000,
): Promise<{ status: number; ms: number; json: unknown; raw: string; error?: string }> {
  const startedAt = Date.now();

  try {
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        // ★ 关键：这个头是服务端要求的
        'X-Beike-Cli-Version': CLI_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const raw = await response.text();
    return { status: response.status, ms: Date.now() - startedAt, json: parseSse(raw), raw };
  } catch (error) {
    return {
      status: 0,
      ms: Date.now() - startedAt,
      json: null,
      raw: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 从工具返回里抽文本 */
function extractText(json: unknown): string {
  const root = json as Record<string, unknown> | null;
  const result = root?.['result'] as Record<string, unknown> | undefined;
  const content = result?.['content'];

  if (!Array.isArray(content)) return '';

  return content
    .map((item) =>
      item && typeof item === 'object' ? String((item as Record<string, unknown>)['text'] ?? '') : '',
    )
    .filter((text) => text.length > 0)
    .join('\n');
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('决定性测试：直连调用 house_search');
  console.log(`Endpoint: ${BASE_URL}`);
  console.log(`Header:   X-Beike-Cli-Version: ${CLI_VERSION}`);
  console.log('');

  // 握手
  await mcp(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-direct', version: '1.0.0' },
    },
    1,
  );
  await mcp('notifications/initialized', {}, 2, 10_000);

  // 取工具 schema（用于构造正确参数）
  const listResult = await mcp('tools/list', {}, 3);
  const tools =
    (((listResult.json as Record<string, unknown> | null)?.['result'] as
      | Record<string, unknown>
      | undefined)?.['tools'] ?? []) as ToolSchema[];

  const houseSearch = tools.find((tool) => tool.name === 'house_search');
  if (!houseSearch) {
    console.error('未找到 house_search 工具');
    process.exit(1);
  }

  console.log('─'.repeat(74));
  console.log('house_search 参数 schema');
  console.log('─'.repeat(74));
  if (houseSearch.inputSchema?.properties) {
    for (const [name, schema] of Object.entries(houseSearch.inputSchema.properties)) {
      const required = houseSearch.inputSchema.required?.includes(name) ? ' (必填)' : '';
      console.log(`  ${name.padEnd(18)} ${schema.type ?? '?'}${required}`);
      if (schema.description) {
        console.log(`      ${schema.description.slice(0, 100)}`);
      }
    }
  }
  if (houseSearch.inputSchema?.required) {
    console.log(`\n  必填项: ${houseSearch.inputSchema.required.join(', ')}`);
  }

  // ---- 实际调用 ----
  const attempts: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: 'city_name + query', args: { city_name: '上海', query: '浦东三房' } },
    { label: '加 house_type', args: { city_name: '上海', query: '浦东三房', house_type: 'second' } },
  ];

  console.log('');
  console.log('─'.repeat(74));
  console.log('调用结果');
  console.log('─'.repeat(74));

  let anySuccess = false;

  for (const [index, attempt] of attempts.entries()) {
    const call = await mcp(
      'tools/call',
      { name: 'house_search', arguments: attempt.args },
      100 + index,
    );

    const text = extractText(call.json);
    const root = call.json as Record<string, unknown> | null;
    const rpcError = root?.['error'] as Record<string, unknown> | undefined;

    console.log('');
    console.log(`  [${index + 1}] 参数: ${JSON.stringify(attempt.args)}`);
    console.log(`      HTTP ${call.status} | ${call.ms}ms`);

    if (call.error) {
      console.log(`      网络错误: ${call.error}`);
      continue;
    }

    if (rpcError) {
      console.log(`      ❌ JSON-RPC 错误: ${String(rpcError['message'] ?? '').slice(0, 200)}`);
      continue;
    }

    if (text.length === 0) {
      console.log(`      ⚠ 无文本内容，原始响应:`);
      console.log(`      ${call.raw.slice(0, 300)}`);
      continue;
    }

    if (/temporarily unavailable/i.test(text)) {
      const errMatch = /"error"\s*:\s*"([^"]*)"/.exec(text);
      console.log(`      ❌ 服务层不可用${errMatch?.[1] ? `: ${errMatch[1]}` : ''}`);
      console.log(`      原始前 200 字: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
      continue;
    }

    if (/"ok"\s*:\s*false/i.test(text)) {
      const errMatch = /"error"\s*:\s*"([^"]*)"/.exec(text);
      console.log(`      ❌ ok=false${errMatch?.[1] ? `: ${errMatch[1]}` : ''}`);
      continue;
    }

    // 成功！
    anySuccess = true;
    console.log(`      ✅ 成功！返回 ${text.length} 字符`);

    const recall = /总召回结果数[：:]\s*(\d+)/.exec(text);
    if (recall?.[1]) console.log(`      总召回: ${recall[1]} 套`);

    // 数房源实体
    const houseMatches = text.match(/<(\d{9,})>/g);
    if (houseMatches) console.log(`      返回房源数: ${houseMatches.length}`);

    console.log('');
    console.log(`      内容前 600 字：`);
    console.log(
      text
        .slice(0, 600)
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n'),
    );
  }

  // ---- 结论 ----
  console.log('');
  console.log('─'.repeat(74));
  console.log('结论');
  console.log('─'.repeat(74));

  if (anySuccess) {
    console.log('  ★ 直连 HTTP 可以拿到真实房源数据！');
    console.log('');
    console.log('    → 问题出在 CLI 层（CLI 的调用方式与服务端期望不符）');
    console.log('    → 这是**可修复的**：绕过 CLI，改用直连 HTTP');
    console.log('    → 修复后项目即可正常搜索房源');
  } else {
    console.log('  ★ 直连 HTTP 同样拿不到数据');
    console.log('');
    console.log('    → 服务端数据平面确实不可用（Key 有效但服务故障）');
    console.log('    → 我方无法修复，只能等待对方恢复');
    console.log('    → 系统已有的本地真实房源降级会继续生效');
  }
}

main().catch((error) => {
  console.error('测试异常：', error);
  process.exit(1);
});
