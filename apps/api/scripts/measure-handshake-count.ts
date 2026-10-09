/**
 * 测量：一次真实搜索流程里，握手被重复执行了几次？
 *
 * ============================================================================
 * 为什么需要测量
 * ============================================================================
 * 用量统计显示一次搜索产生了 3 次调用：
 *   initialize + notifications/initialized + house_search
 *
 * 但握手逻辑已记忆化（`this.handshake ??= ...`），每个客户端实例只应握一次。
 * 若每次搜索都重新握手，说明**客户端实例被反复创建** ——
 * 那是 2/3 的配额白白浪费。
 *
 * 本脚本通过包装 fetch 统计**实际发出的每个请求**，精确定位问题。
 *
 * ⚠️ 每个场景最多 2-3 次请求。限流期间会自动退出。
 *
 * 用法：node --experimental-strip-types scripts/measure-handshake-count.ts
 */

import { BeikeDirectClient } from '../dist/modules/property/providers/beike/beike-direct-client.js';
import { BeikeResponseParser } from '../dist/modules/property/providers/beike/beike-response-parser.js';

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';

/** 记录所有实际发出的请求 */
const requests: Array<{ method: string; tool: string | null; ms: number; throttled: boolean }> = [];

/** 包装全局 fetch 以观测请求 */
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const started = Date.now();
  let method = '?';
  let tool: string | null = null;

  try {
    if (init?.body && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      method = String(body['method'] ?? '?');
      const params = body['params'] as Record<string, unknown> | undefined;
      if (typeof params?.['name'] === 'string') tool = String(params['name']);
    }
  } catch {
    // 忽略
  }

  const response = await originalFetch(input, init);
  const clone = response.clone();
  const text = await clone.text().catch(() => '');
  const throttled = /temporarily unavailable/i.test(text);

  requests.push({ method, tool, ms: Date.now() - started, throttled });

  return response;
}) as typeof fetch;

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('测量握手次数与请求构成\n');
  console.log('='.repeat(74));

  const client = new BeikeDirectClient({ apiKey: API_KEY }, new BeikeResponseParser());

  // ---- 场景：同一个客户端实例连续调用 2 次 ----
  console.log('\n【场景】同一个客户端实例，连续调用 2 个工具\n');

  const first = await client.callTool('house_search', {
    city_name: '厦门',
    query: '湖里区 三房',
  });

  console.log(`  第 1 次调用：${first.ok ? '✅' : '❌'}`);
  console.log(`    期间发出的请求：${requests.length} 个`);
  for (const request of requests) {
    console.log(`      · ${request.method}${request.tool ? ` (${request.tool})` : ''} ${request.ms}ms`);
  }

  if (!first.ok && /temporarily unavailable/i.test(String(first.error))) {
    console.log('');
    console.log('  服务限流中，无法完成测量。请在恢复后重试。');
    return;
  }

  const beforeSecond = requests.length;

  const second = await client.callTool('house_search', {
    city_name: '厦门',
    query: '集美区 两房',
  });

  const secondRequests = requests.slice(beforeSecond);

  console.log('');
  console.log(`  第 2 次调用：${second.ok ? '✅' : '❌'}`);
  console.log(`    期间发出的请求：${secondRequests.length} 个`);
  for (const request of secondRequests) {
    console.log(`      · ${request.method}${request.tool ? ` (${request.tool})` : ''} ${request.ms}ms`);
  }

  // ========================================================================
  console.log('');
  console.log('='.repeat(74));
  console.log('\n【结论】\n');

  const handshakes = requests.filter((request) => request.method === 'initialize').length;

  console.log(`  initialize 总次数：${handshakes}（2 次工具调用）`);
  console.log(`  总请求数：${requests.length}`);
  console.log('');

  if (handshakes === 1) {
    console.log('  ✅ 握手只执行了 1 次 —— 记忆化生效，没有重复握手。');
    console.log('     说明"每次搜索都握手"的猜测**不成立**，');
    console.log('     之前统计里的 initialize 是进程启动后的首次握手。');
  } else if (handshakes > 1) {
    console.log(`  ⚠️ 握手执行了 ${handshakes} 次 —— 存在重复握手，可优化。`);
  }

  console.log('');
  console.log('  每次工具调用的请求构成：');
  const perCall = (requests.length - handshakes) / 2;
  console.log(`    握手（仅首次）：${handshakes} 个`);
  console.log(`    业务调用：      ${requests.length - handshakes} 个（平均每次工具调用 ${perCall.toFixed(1)} 个请求）`);
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
