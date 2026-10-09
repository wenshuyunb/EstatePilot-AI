/**
 * 贝壳 house_search 查询语句写法对照实验。
 *
 * ============================================================================
 * 目的
 * ============================================================================
 * 实测发现贝壳会**解析自然语言查询**，并把它翻译成结构化检索条件：
 *   「浦东三房」 → 卧室数 = 3.0 + 城区 = 浦东新区
 *
 * 但我们的自动生成查询（如「集美区 海沧区 3居室 400万以内 较新小区 近地铁」）
 * 是否也能被正确解析？如果贝壳只认了后两个条件、忽略了区域，
 * 就会在全城范围搜索，返回的结果与客户需求不符。
 *
 * 本脚本用不同写法做对照，找出**贝壳实际能解析的查询格式**。
 *
 * 用法：node --experimental-strip-types scripts/test-beike-query-formats.ts
 */

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

/** 要对照的查询写法（都是"厦门岛外三房 400万"的等价表达） */
const VARIANTS: Array<{ label: string; query: string }> = [
  { label: '① 我们当前自动生成的写法', query: '厦门 集美、海沧、同安 3房 460万以内' },
  { label: '② 只写区域与户型', query: '集美区 海沧区 同安区 三房' },
  { label: '③ 口语化完整句', query: '厦门岛外三房，总价四百万左右' },
  { label: '④ 单区域精确写法', query: '集美区三房' },
  { label: '⑤ 带价格的自然语言', query: '集美区 三房 四百万以内' },
  { label: '⑥ 岛外（俗称）', query: '厦门岛外 三房' },
];

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

let rpcId = 0;

async function rpc(
  method: string,
  params: unknown,
  isNotification = false,
): Promise<{ status: number; ms: number; parsed: unknown }> {
  const startedAt = Date.now();
  const body: Record<string, unknown> = isNotification
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', id: (rpcId += 1), method, params };

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Beike-Cli-Version': CLI_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const raw = await response.text();
  return { status: response.status, ms: Date.now() - startedAt, parsed: parseSse(raw) };
}

/** 从返回里提取"贝壳实际命中的检索条件" */
function extractConditions(parsed: unknown): string[] {
  const root = parsed as Record<string, unknown> | null;
  const content = (root?.['result'] as Record<string, unknown> | undefined)?.['content'];
  if (!Array.isArray(content)) return [];

  const text = content
    .map((item) =>
      item && typeof item === 'object' ? String((item as Record<string, unknown>)['text'] ?? '') : '',
    )
    .join('\n');

  const conditions: string[] = [];
  const block = /【本次实际命中的检索条件】\s*(\[[\s\S]*?\])/.exec(text);
  if (block?.[1]) {
    try {
      const list = JSON.parse(block[1]) as Array<Record<string, string>>;
      for (const item of list) {
        conditions.push(`${item['检索条件'] ?? '?'}`);
      }
    } catch {
      conditions.push('(解析失败)');
    }
  }

  const recall = /总召回结果数[：:]\s*(\d+)/.exec(text);
  if (recall?.[1]) conditions.push(`召回=${recall[1]}`);

  // 返回的实体 ID 数量
  const entities = text.match(/'(\d{9,})'/g);
  if (entities) conditions.push(`返回=${entities.length}条`);

  return conditions;
}

function isUnavailable(parsed: unknown): boolean {
  const root = parsed as Record<string, unknown> | null;
  const result = root?.['result'] as Record<string, unknown> | undefined;
  if (result?.['isError'] !== true) return false;

  const content = result['content'];
  const text = Array.isArray(content)
    ? content
        .map((item) =>
          item && typeof item === 'object' ? String((item as Record<string, unknown>)['text'] ?? '') : '',
        )
        .join(' ')
    : '';
  return /temporarily unavailable/i.test(text);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('贝壳 house_search 查询写法对照实验');
  console.log(`城市固定为：厦门\n`);

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'estatepilot-query-test', version: '1.0.0' },
  });
  await rpc('notifications/initialized', undefined, true);

  console.log('='.repeat(76));

  for (const [index, variant] of VARIANTS.entries()) {
    // 每次调用间隔 4 秒，避开限流（实测连续调用会触发 220ms 快速失败）
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 4000));

    const call = await rpc('tools/call', {
      name: 'house_search',
      arguments: { city_name: '厦门', query: variant.query },
    });

    console.log('');
    console.log(`  ${variant.label}`);
    console.log(`  查询语句: 「${variant.query}」`);
    console.log(`  HTTP ${call.status} | ${call.ms}ms`);

    if (isUnavailable(call.parsed)) {
      console.log(`  ⚠ 限流/服务不可用（跳过）`);
      continue;
    }

    const conditions = extractConditions(call.parsed);
    if (conditions.length === 0) {
      console.log(`  ✗ 未提取到检索条件`);
      continue;
    }

    console.log(`  贝壳实际解析为:`);
    for (const condition of conditions) {
      console.log(`    · ${condition}`);
    }
  }

  console.log('');
  console.log('='.repeat(76));
  console.log('');
  console.log('判读方法：');
  console.log('  · 若"检索条件"里出现「城区 = 集美区」等，说明区域被正确解析');
  console.log('  · 若只有「卧室数 = 3.0」而没有区域，说明区域被忽略');
  console.log('  · 对比哪种写法能同时命中「区域 + 户型 + 价格」');
}

main().catch((error) => {
  console.error('测试异常：', error);
  process.exit(1);
});
