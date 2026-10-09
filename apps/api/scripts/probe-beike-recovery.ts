/**
 * 限流恢复探针 —— 隔一段时间探测一次，记录限流到底持续多久。
 *
 * ============================================================================
 * 为什么要做这个
 * ============================================================================
 * 我们对贝壳的限流规则**完全不了解**：
 *   · 是按分钟 / 小时 / 天 计？
 *   · 是按账号 / Key / IP 计？
 *   · 触发后多久恢复？
 *
 * 与其猜，不如测。用**极低频**探测（每 5 分钟 1 次，只发 1 个请求）
 * 把恢复时间测出来 —— 这样以后就能据此设计调用策略。
 *
 * ⚠️ 探测频率必须很低：每次探测本身也是一次调用，
 *    探得太勤等于自己延长限流。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-beike-recovery.ts
 *   （后台运行，结果追加到 .probe-log.txt）
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

/** 探测间隔：5 分钟。低频是关键，探测本身也消耗配额 */
const INTERVAL_MS = 5 * 60_000;

/** 最多探测次数（24 小时 = 288 次，设 60 次约 5 小时） */
const MAX_PROBES = 60;

const LOG_FILE = path.resolve(process.cwd(), '..', '..', '.probe-log.txt');

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

async function rpc(method: string, params: unknown, isNotification = false): Promise<{
  ms: number;
  parsed: unknown;
}> {
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
    signal: AbortSignal.timeout(45_000),
  });

  const raw = await response.text();
  return { ms: Date.now() - startedAt, parsed: parseSse(raw) };
}

interface ProbeOutcome {
  ok: boolean;
  ms: number;
  recall: number | null;
  error: string | null;
}

async function probe(): Promise<ProbeOutcome> {
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-recovery-probe', version: '1.0.0' },
    });
    await rpc('notifications/initialized', undefined, true);

    const call = await rpc('tools/call', {
      name: 'house_search',
      arguments: { city_name: '厦门', query: '湖里区 三房' },
    });

    const root = call.parsed as Record<string, unknown> | null;
    const result = root?.['result'] as Record<string, unknown> | undefined;
    const content = result?.['content'];

    const text = Array.isArray(content)
      ? content
          .map((item) =>
            item && typeof item === 'object'
              ? String((item as Record<string, unknown>)['text'] ?? '')
              : '',
          )
          .join('\n')
      : '';

    if (result?.['isError'] === true || /temporarily unavailable/i.test(text)) {
      return { ok: false, ms: call.ms, recall: null, error: text.slice(0, 80) };
    }

    const recallMatch = /总召回结果数[：:]\s*(\d+)/.exec(text);
    return {
      ok: true,
      ms: call.ms,
      recall: recallMatch?.[1] ? Number(recallMatch[1]) : null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      ms: 0,
      recall: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG_FILE, `${stamped}\n`, 'utf8');
  } catch {
    // 写日志失败不影响探测
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  log('限流恢复探针启动');
  log(`探测间隔 ${INTERVAL_MS / 60_000} 分钟，最多 ${MAX_PROBES} 次`);
  log(`日志文件：${LOG_FILE}`);
  log('');

  const firstFailureAt = Date.now();
  let recoveredAt: number | null = null;

  for (let i = 1; i <= MAX_PROBES; i += 1) {
    const outcome = await probe();
    const elapsedMin = Math.round((Date.now() - firstFailureAt) / 60_000);

    if (outcome.ok) {
      log(
        `✅ 第 ${i} 次探测：已恢复！（耗时 ${outcome.ms}ms，召回 ${outcome.recall ?? '?'} 套）` +
          ` —— 从首次探测算起约 ${elapsedMin} 分钟`,
      );
      recoveredAt = Date.now();
      break;
    }

    log(
      `❌ 第 ${i} 次探测：仍限流（耗时 ${outcome.ms}ms，已持续约 ${elapsedMin} 分钟）` +
        `${outcome.error ? ` —— ${outcome.error}` : ''}`,
    );

    if (i < MAX_PROBES) {
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  }

  log('');
  if (recoveredAt) {
    log(`结论：限流约在 ${Math.round((recoveredAt - firstFailureAt) / 60_000)} 分钟后恢复`);
  } else {
    log(`结论：${MAX_PROBES} 次探测（约 ${Math.round((MAX_PROBES * INTERVAL_MS) / 3_600_000)} 小时）内未恢复`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
