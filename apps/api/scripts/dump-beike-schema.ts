/**
 * dump 贝壳 MCP 各工具的真实参数 schema。
 *
 * 为什么需要：直连调用返回 -32602 Invalid request parameters，
 * 说明参数名/结构与服务端期望不符。
 *
 * 参数名**必须从 tools/list 的 inputSchema 读取**，不能硬编码 ——
 * 服务端可以随时改参数名，硬编码会静默失效。
 *
 * 用法：node --experimental-strip-types scripts/dump-beike-schema.ts
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

async function rpc(method: string, params: unknown, id: number): Promise<unknown> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Beike-Cli-Version': CLI_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });

  return parseSse(await response.text());
}

interface JsonSchema {
  type?: string;
  properties?: Record<
    string,
    { type?: string; description?: string; enum?: unknown[]; items?: unknown }
  >;
  required?: string[];
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  await rpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-schema-dump', version: '1.0.0' },
    },
    1,
  );
  await rpc('notifications/initialized', {}, 2);

  const listResponse = await rpc('tools/list', {}, 3);
  const tools =
    (((listResponse as Record<string, unknown> | null)?.['result'] as
      | Record<string, unknown>
      | undefined)?.['tools'] ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema?: JsonSchema;
    }>;

  console.log(`共 ${tools.length} 个工具\n`);

  for (const tool of tools) {
    console.log('='.repeat(72));
    console.log(`工具: ${tool.name}`);
    console.log('='.repeat(72));

    if (tool.description) {
      console.log(`说明: ${tool.description.slice(0, 200)}`);
    }

    const schema = tool.inputSchema;
    if (!schema?.properties) {
      console.log('参数: (无 schema)');
      console.log('');
      continue;
    }

    const required = new Set(schema.required ?? []);
    console.log(`必填: ${[...required].join(', ') || '(无)'}`);
    console.log('参数列表:');

    for (const [name, prop] of Object.entries(schema.properties)) {
      const mark = required.has(name) ? '★必填' : '  可选';
      const type = prop.type ?? '?';
      const enumHint = Array.isArray(prop.enum) ? ` enum=[${prop.enum.join('|')}]` : '';
      console.log(`  ${mark}  ${name.padEnd(20)} ${type}${enumHint}`);
      if (prop.description) {
        console.log(`          ${prop.description.slice(0, 120)}`);
      }
    }
    console.log('');
  }
}

main().catch((error) => {
  console.error('dump 异常：', error);
  process.exit(1);
});
