/**
 * 代理影响对照实验
 *
 * ============================================================================
 * 背景
 * ============================================================================
 * 用户的机器开了系统代理（注册表 ProxyEnable=1, ProxyServer=127.0.0.1:17891）。
 *
 * 关键差异：
 *   - **Node.js fetch 不读系统代理**，只认 HTTP_PROXY / HTTPS_PROXY 环境变量
 *   - **Rust reqwest（贝壳 CLI）会读系统代理**
 *
 * 因此两条路径的网络出口可能完全不同：
 *   直连 → 直连 building.ke.com
 *   CLI  → 经代理访问 building.ke.com
 *
 * 如果代理把国内域名也转发到海外节点，就会导致：
 *   地域限制、超时、被风控 —— 表现成 "service temporarily unavailable"
 *
 * 本脚本通过对照实验判定代理是否是根因。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diagnose-proxy.ts
 */

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';
const PROXY = 'http://127.0.0.1:17891';

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

interface ProbeOutcome {
  label: string;
  status: number;
  ms: number;
  verdict: string;
}

/**
 * 发起一次请求。
 *
 * @param proxyUrl 传入代理 URL 时走代理，传 null 时强制直连
 *
 * 实现说明：用 Node 24 内置的 `EnvHttpProxyAgent`（来自 node:undici 的内部实现），
 * 不依赖第三方 undici 包。配合 `setGlobalDispatcher` 让 fetch 走代理。
 */
async function withProxy<T>(proxyUrl: string | null, fn: () => Promise<T>): Promise<T> {
  if (!proxyUrl) return fn();

  // 优先用 Node 内置的代理 agent
  try {
    const undiciModule = (await import('node:undici')) as {
      EnvHttpProxyAgent?: new (options: { httpProxy: string; httpsProxy: string }) => unknown;
      setGlobalDispatcher?: (dispatcher: unknown) => void;
    };

    if (undiciModule.EnvHttpProxyAgent && undiciModule.setGlobalDispatcher) {
      const agent = new undiciModule.EnvHttpProxyAgent({
        httpProxy: proxyUrl,
        httpsProxy: proxyUrl,
      });
      undiciModule.setGlobalDispatcher(agent);
      return fn();
    }
  } catch {
    // 回退到环境变量方式
  }

  // 回退：设置环境变量（部分 Node 版本会读）
  const original = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;

  try {
    return await fn();
  } finally {
    if (original.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = original.HTTP_PROXY;
    if (original.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = original.HTTPS_PROXY;
  }
}

async function probeSearch(label: string, proxyUrl: string | null): Promise<ProbeOutcome> {
  const startedAt = Date.now();

  try {
    return await withProxy(proxyUrl, async () => {
      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Beike-Cli-Version': CLI_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'estatepilot-proxy-diag', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(25_000),
      });

      const text = await response.text();
      const ms = Date.now() - startedAt;

      const parsed = parseSse(text) as Record<string, unknown> | null;
      const result = parsed?.['result'] as Record<string, unknown> | undefined;
      const info = result?.['serverInfo'] as Record<string, unknown> | undefined;

      if (info) {
        return {
          label,
          status: response.status,
          ms,
          verdict: `✅ 握手成功：${String(info['name'])} v${String(info['version'])}`,
        };
      }

      return {
        label,
        status: response.status,
        ms,
        verdict: `⚠ HTTP ${response.status}，响应：${text.slice(0, 120)}`,
      };
    });
  } catch (error) {
    return {
      label,
      status: 0,
      ms: Date.now() - startedAt,
      verdict: `❌ 网络错误：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 直接测一次 house_search（走或不走代理） */
async function probeHouseSearch(proxyUrl: string | null): Promise<string> {
  try {
    return await withProxy(proxyUrl, async () => {
      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Beike-Cli-Version': CLI_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'house_search', arguments: { query: '浦东三房', city_name: '上海' } },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const text = await response.text();
      const parsed = parseSse(text) as Record<string, unknown> | null;
      const result = parsed?.['result'] as Record<string, unknown> | undefined;
      const content = result?.['content'];

      if (Array.isArray(content)) {
        const inner = content
          .map((item) =>
            item && typeof item === 'object'
              ? String((item as Record<string, unknown>)['text'] ?? '')
              : '',
          )
          .join(' ');
        return `isError=${String(result?.['isError'])} text="${inner.slice(0, 90)}"`;
      }
      return `无 content：${text.slice(0, 120)}`;
    });
  } catch (error) {
    return `❌ 网络错误：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  console.log('代理影响对照实验');
  console.log(`Endpoint: ${BASE_URL}`);
  console.log(`系统代理: ${PROXY}（注册表 ProxyEnable=1）`);
  console.log(`环境变量 HTTP_PROXY: ${process.env.HTTP_PROXY ?? '(未设置)'}`);
  console.log(`环境变量 HTTPS_PROXY: ${process.env.HTTPS_PROXY ?? '(未设置)'}`);
  console.log('');

  // ------------------------------------------------------------------------
  console.log('='.repeat(74));
  console.log('[1] 握手对照：直连 vs 走代理');
  console.log('='.repeat(74));

  const direct = await probeSearch('直连（绕过代理）', null);
  console.log(`  直连    HTTP ${direct.status} | ${direct.ms}ms | ${direct.verdict}`);

  const viaProxy = await probeSearch('走代理 127.0.0.1:17891', PROXY);
  console.log(`  走代理  HTTP ${viaProxy.status} | ${viaProxy.ms}ms | ${viaProxy.verdict}`);

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[2] 数据调用对照：house_search');
  console.log('='.repeat(74));

  const directSearch = await probeHouseSearch(null);
  console.log(`  直连:   ${directSearch}`);

  const proxySearch = await probeHouseSearch(PROXY);
  console.log(`  走代理: ${proxySearch}`);

  // ------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(74));
  console.log('[3] 结论');
  console.log('='.repeat(74));

  const directOk = direct.verdict.startsWith('✅');
  const proxyOk = viaProxy.verdict.startsWith('✅');

  console.log(`  直连握手:   ${directOk ? '成功' : '失败'}`);
  console.log(`  代理握手:   ${proxyOk ? '成功' : '失败'}`);
  console.log('');

  if (directOk && proxyOk) {
    console.log('  ★ 两条路径都能握手 → 代理不是握手层的问题');
  } else if (directOk && !proxyOk) {
    console.log('  ★ 直连成功但代理失败 → **代理有问题**');
    console.log('    → 代理可能把国内域名转发到海外，导致被拒或超时');
    console.log('    → 建议：把 *.ke.com 加入代理白名单（绕过代理）');
  } else if (!directOk && proxyOk) {
    console.log('  ★ 代理成功但直连失败 → **必须走代理**');
  } else {
    console.log('  ★ 两条路径都失败 → 与代理无关');
  }

  console.log('');
  console.log('  数据调用结果对比：');
  console.log(`    直连:   ${directSearch.includes('temporarily unavailable') ? '到达服务层（服务不可用）' : directSearch.slice(0, 80)}`);
  console.log(`    走代理: ${proxySearch.includes('temporarily unavailable') ? '到达服务层（服务不可用）' : proxySearch.slice(0, 80)}`);

  if (
    directSearch.includes('temporarily unavailable') &&
    proxySearch.includes('temporarily unavailable')
  ) {
    console.log('');
    console.log('  ★ 两种网络路径都到达了服务层，且返回同样的错误');
    console.log('    → **代理不是原因**，是服务端本身的状态');
  }
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
