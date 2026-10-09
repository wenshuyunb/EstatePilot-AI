/**
 * 多城市测试 —— 判断是否只有部分城市的数据服务故障
 *
 * ============================================================================
 * 为什么要测这个
 * ============================================================================
 * 之前所有测试都只用「上海」。用户反馈"以前能搜到，现在不行了"，
 * 而且他的主战场是**厦门**。
 *
 * 贝壳的数据服务可能是**按城市分片**的：
 *   - 可能只有部分城市的后端故障
 *   - 也可能厦门本身就不在支持范围
 *
 * 这个测试能一次性回答两个问题：
 *   1. 是否所有城市都故障，还是只有部分
 *   2. 厦门是否被支持（这直接决定用户能不能用）
 *
 * 用法：node --experimental-strip-types scripts/test-beike-cities.ts
 */

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

/** 要测试的城市 */
const CITIES = [
  { name: '厦门', query: '思明区三房' },
  { name: '上海', query: '浦东三房' },
  { name: '北京', query: '朝阳区两房' },
  { name: '深圳', query: '南山区三房' },
  { name: '杭州', query: '西湖区两房' },
  { name: '广州', query: '天河区三房' },
  { name: '福州', query: '鼓楼区两房' },
  { name: '泉州', query: '丰泽区三房' },
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

async function rpc(
  method: string,
  params: unknown,
  id: number,
  isNotification = false,
): Promise<{ status: number; ms: number; parsed: unknown; raw: string }> {
  const startedAt = Date.now();

  const body: Record<string, unknown> = isNotification
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', id, method, params };

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Beike-Cli-Version': CLI_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });

  const raw = await response.text();
  return { status: response.status, ms: Date.now() - startedAt, parsed: parseSse(raw), raw };
}

/** 判定一次工具调用结果 */
function classify(parsed: unknown): { ok: boolean; detail: string } {
  const root = parsed as Record<string, unknown> | null;

  if (root?.['error']) {
    const err = root['error'] as Record<string, unknown>;
    return { ok: false, detail: `JSON-RPC 错误 ${String(err['code'])}: ${String(err['message'] ?? '').slice(0, 80)}` };
  }

  const result = root?.['result'] as Record<string, unknown> | undefined;
  const content = result?.['content'];

  if (!Array.isArray(content)) {
    return { ok: false, detail: `无 content：${JSON.stringify(result ?? {}).slice(0, 100)}` };
  }

  const text = content
    .map((item) =>
      item && typeof item === 'object' ? String((item as Record<string, unknown>)['text'] ?? '') : '',
    )
    .join('\n');

  if (result?.['isError'] === true || /temporarily unavailable/i.test(text)) {
    return { ok: false, detail: '服务层不可用（service temporarily unavailable）' };
  }

  // 成功：数一下房源实体（形如 <123456789>）
  const entities = text.match(/<\d{9,}>/g);
  const recall = /总召回结果数[：:]\s*(\d+)/.exec(text);

  return {
    ok: true,
    detail:
      `✅ 可用` +
      (recall?.[1] ? `（召回 ${recall[1]} 套）` : '') +
      (entities ? `（返回 ${entities.length} 条）` : '') +
      `，内容 ${text.length} 字符`,
  };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('多城市贝壳可用性测试');
  console.log(`Endpoint: ${BASE_URL}\n`);

  // 握手
  await rpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-city-test', version: '1.0.0' },
    },
    1,
  );
  await rpc('notifications/initialized', undefined, 2, true);

  console.log('─'.repeat(74));
  console.log('逐城市测试 house_search（二手房搜索）');
  console.log('─'.repeat(74));
  console.log('');

  const results: Array<{ city: string; ok: boolean; detail: string; ms: number }> = [];

  for (const [index, city] of CITIES.entries()) {
    const call = await rpc(
      'tools/call',
      { name: 'house_search', arguments: { query: city.query, city_name: city.name } },
      100 + index,
    );

    const { ok, detail } = classify(call.parsed);
    results.push({ city: city.name, ok, detail, ms: call.ms });

    console.log(
      `  ${city.name.padEnd(6)} ${ok ? '✅' : '❌'}  ${String(call.ms).padStart(5)}ms  ${detail}`,
    );

    // 间隔，避免触发限流
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  // ------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('结论');
  console.log('─'.repeat(74));

  const working = results.filter((r) => r.ok);
  const broken = results.filter((r) => !r.ok);

  console.log(`  可用城市: ${working.length} / ${results.length}`);
  console.log(`  故障城市: ${broken.length} / ${results.length}`);
  console.log('');

  if (working.length === results.length) {
    console.log('  ★ 所有城市都可用 —— 服务已恢复！');
    console.log(`    可用城市: ${working.map((r) => r.city).join('、')}`);
  } else if (working.length === 0) {
    console.log('  ★ 所有城市都不可用');
    console.log('    → 服务端数据层整体故障，与城市无关');
    console.log('    → 包含厦门在内的所有城市受影响');
  } else {
    console.log('  ★ 部分城市可用 —— **按城市分片故障**');
    console.log('');
    console.log(`    可用: ${working.map((r) => r.city).join('、')}`);
    console.log(`    故障: ${broken.map((r) => r.city).join('、')}`);
    console.log('');
    console.log('    → 如果厦门在"可用"列表里，用户可以立即开始用！');
  }

  // 厦门单独强调
  const xiamen = results.find((r) => r.city === '厦门');
  if (xiamen) {
    console.log('');
    console.log(`  【厦门】${xiamen.ok ? '✅ 可用' : '❌ 不可用'} —— ${xiamen.detail}`);
  }
}

main().catch((error) => {
  console.error('测试异常：', error);
  process.exit(1);
});
