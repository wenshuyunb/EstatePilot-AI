/**
 * 探测贝壳是否提供"查询配额"的能力。
 *
 * ============================================================================
 * 背景
 * ============================================================================
 * 实测发现：贝壳限流时返回 HTTP 200 + 正文 `service temporarily unavailable`，
 * **响应头里没有任何限流字段**（无 Retry-After、无 X-RateLimit-*）。
 *
 * 因此需要确认还有没有别的途径能查到配额：
 *   1. MCP 协议层是否有 quota/usage 之类的方法？
 *   2. 拿 Key 的页面（building.ke.com）是否显示账号额度？
 *   3. 是否有 REST 端点暴露配额？
 *
 * ⚠️ 本探针**只查元数据**（协议方法列表、页面内容），
 *    不调用数据检索工具 —— 避免在限流期间加重负担。
 *
 * 用法：node --experimental-strip-types scripts/probe-beike-quota.ts
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

const LOG_FILE = path.resolve(process.cwd(), '..', '..', '.quota-log.txt');

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG_FILE, `${stamped}\n`, 'utf8');
  } catch {
    // 忽略
  }
}

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

async function rpc(method: string, params: unknown, isNotification = false): Promise<{
  status: number;
  ms: number;
  headers: Record<string, string>;
  body: unknown;
}> {
  const started = Date.now();
  const body: Record<string, unknown> = isNotification
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params };

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

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const raw = await response.text();
  return { status: response.status, ms: Date.now() - started, headers, body: parseSse(raw) };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  log('贝壳配额探测启动');

  // ========================================================================
  log('');
  log('【1】MCP 协议层：列出所有可用方法，找 quota / usage 相关');
  // ========================================================================

  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-quota-probe', version: '1.0.0' },
    });
    await rpc('notifications/initialized', undefined, true);

    const listed = await rpc('tools/list', {});
    const parsed = listed.body as Record<string, unknown> | null;
    const result = parsed?.['result'] as Record<string, unknown> | undefined;
    const tools = result?.['tools'];

    if (Array.isArray(tools)) {
      log(`  共 ${tools.length} 个工具`);

      const quotaLike = tools.filter((tool) => {
        const name = String((tool as Record<string, unknown>)['name'] ?? '');
        const description = String((tool as Record<string, unknown>)['description'] ?? '');
        return /quota|usage|limit|account|balance|credit|remain|stat/i.test(`${name} ${description}`);
      });

      log('');
      log('  与"配额/用量"可能相关的工具：');
      if (quotaLike.length === 0) {
        log('    （无）—— 说明贝壳未通过 MCP 暴露配额查询');
      } else {
        for (const tool of quotaLike) {
          const entry = tool as Record<string, unknown>;
          log(`    · ${String(entry['name'])}`);
          log(`      ${String(entry['description'] ?? '').slice(0, 120)}`);
        }
      }

      log('');
      log('  全部工具名：');
      log(
        '    ' +
          tools
            .map((tool) => String((tool as Record<string, unknown>)['name']))
            .join(', '),
      );
    } else {
      log('  未能获取工具列表');
    }

    // ---- 检查响应头是否有任何配额线索 ----
    log('');
    log('  tools/list 的响应头（找配额字段）：');
    const headerEntries = Object.entries(listed.headers);
    const suspicious = headerEntries.filter(([key]) =>
      /limit|quota|rate|remain|usage|credit|reset|retry/i.test(key),
    );
    if (suspicious.length === 0) {
      log('    （无配额相关字段）');
    } else {
      for (const [key, value] of suspicious) log(`    ${key}: ${value}`);
    }
  } catch (error) {
    log(`  协议层探测失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // ========================================================================
  log('');
  log('【2】拿 Key 的页面是否显示账号额度');
  // ========================================================================

  for (const url of [
    'https://building.ke.com/',
    'https://building.ke.com/?action=get-key&source=estatepilot',
  ]) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 EstatePilot/1.0' },
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });

      const html = await response.text();

      log('');
      log(`  ${url}`);
      log(`    HTTP ${response.status} | ${html.length} 字符`);

      // 找配额相关文案
      const keywords = ['配额', '额度', '剩余', '调用', '次数', '限制', 'quota', 'limit', 'usage'];
      const found = keywords.filter((keyword) => html.includes(keyword));
      log(`    页面中出现的相关词：${found.length > 0 ? found.join('、') : '（无）'}`);

      // 抓取上下文
      for (const keyword of found.slice(0, 3)) {
        const index = html.indexOf(keyword);
        if (index < 0) continue;
        const snippet = html
          .slice(Math.max(0, index - 60), index + 80)
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        log(`      「${keyword}」上下文：${snippet.slice(0, 140)}`);
      }
    } catch (error) {
      log(`  ${url} → 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ========================================================================
  log('');
  log('='.repeat(74));
  log('【结论】');
  log('='.repeat(74));
  log('');
  log('  如果上面没有找到配额查询途径，说明：');
  log('    · 贝壳**不对外公开配额数值**');
  log('    · 只能通过**观测实际调用**反推（这正是我们探针在做的事）');
  log('');
  log('  可行的替代做法：');
  log('    1. 自己统计调用量（我们已在节流器里计数，可扩展为持久化统计）');
  log('    2. 观测被限流的时刻，反推"多少请求/多长时间"会触发');
  log('    3. 直接问贝壳的对接人（若有商务渠道）—— 这是最准的');
  log('');
  log(`日志：${LOG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
