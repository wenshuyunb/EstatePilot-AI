/**
 * 探测贝壳限流的确切阈值与恢复时间。
 *
 * ============================================================================
 * 为什么必须实测而不是猜
 * ============================================================================
 * 生产环境的正确做法是"以服务端的限流信号为准"（HTTP 429 + Retry-After），
 * 而不是我们自己猜一个间隔。但要做到这点，必须先知道：
 *   · 服务端是否返回 429 / Retry-After？
 *   · 触发阈值大概是多少请求？
 *   · 恢复窗口多长？
 *
 * 本探针**主动记录每一个响应头**，因此能回答上面三个问题。
 *
 * ⚠️ 探测本身会消耗配额，因此设计得尽量省：
 *    · 先单发 1 个请求探活，失败就直接退出（不浪费）
 *    · 只在恢复后才做阈值探测
 *    · 阈值探测用递增间隔，一旦命中限流立即停止
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-beike-threshold.ts
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

const LOG_FILE = path.resolve(process.cwd(), '..', '..', '.threshold-log.txt');

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

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG_FILE, `${stamped}\n`, 'utf8');
  } catch {
    // 忽略写日志失败
  }
}

interface CallResult {
  status: number;
  ms: number;
  ok: boolean;
  /** 服务端是否明确告知限流 */
  retryAfter: string | null;
  /** 响应头快照（用于发现限流信号） */
  headers: Record<string, string>;
  error: string | null;
}

let rpcId = 0;

async function call(
  tool = 'house_search',
  args: Record<string, unknown> = { city_name: '厦门', query: '湖里区 三房' },
): Promise<CallResult> {
  const startedAt = Date.now();

  try {
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
        id: (rpcId += 1),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const raw = await response.text();
    const parsed = parseSse(raw) as Record<string, unknown> | null;
    const result = parsed?.['result'] as Record<string, unknown> | undefined;
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

    const isError = result?.['isError'] === true || /temporarily unavailable/i.test(text);

    return {
      status: response.status,
      ms: Date.now() - startedAt,
      ok: !isError,
      retryAfter: response.headers.get('retry-after'),
      headers,
      error: isError ? text.slice(0, 100) : null,
    };
  } catch (error) {
    return {
      status: 0,
      ms: Date.now() - startedAt,
      ok: false,
      retryAfter: null,
      headers: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 先握手（握手不算业务调用，但也要看是否被限） */
async function handshake(): Promise<void> {
  await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Beike-Cli-Version': CLI_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'estatepilot-threshold-probe', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  log('限流阈值探针启动');

  await handshake();

  // ========================================================================
  log('');
  log('【第 1 步】单发探活');
  // ========================================================================

  const probe = await call();

  log(`  结果：${probe.ok ? '✅ 可用' : '❌ 限流'} | HTTP ${probe.status} | ${probe.ms}ms`);
  if (probe.retryAfter) log(`  ★ Retry-After: ${probe.retryAfter} 秒 ← 服务端给了明确信号！`);

  // 记录所有响应头，看是否有其他限流信号
  const interesting = Object.entries(probe.headers).filter(([key]) =>
    /limit|rate|retry|quota|remain|reset|throttl/i.test(key),
  );
  if (interesting.length > 0) {
    log('  限流相关响应头：');
    for (const [key, value] of interesting) log(`    ${key}: ${value}`);
  } else {
    log('  （响应头中没有常规的限流字段）');
  }

  if (!probe.ok) {
    log('');
    log('服务处于限流状态 —— 阈值探测需要先等恢复。');
    log('请稍后重试本脚本；或运行 probe-beike-recovery.ts 等待恢复。');
    return;
  }

  // ========================================================================
  log('');
  log('【第 2 步】阈值探测（递增间隔，命中限流立即停止）');
  log('='.repeat(74));

  /**
   * 递增间隔：从 400ms 起，每轮翻倍。
   *
   * 目的：找出**在多快的频率下会被限流**。
   * 一旦命中限流就停止 —— 避免把限流窗口拖长。
   */
  const intervals = [400, 800, 1600, 3200];
  let foundLimit = false;

  for (const interval of intervals) {
    log('');
    log(`  测试间隔 ${interval}ms（连发 6 次）`);

    let failures = 0;

    for (let i = 1; i <= 6; i += 1) {
      const result = await call();

      if (!result.ok) {
        failures += 1;
        log(`    第 ${i} 次：❌ ${result.ms}ms${result.error ? ` — ${result.error}` : ''}`);
        break;
      }

      log(`    第 ${i} 次：✅ ${result.ms}ms`);

      if (i < 6) await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (failures > 0) {
      log(`  → 在 ${interval}ms 间隔下被限流，停止探测`);
      foundLimit = true;
      break;
    }

    log(`  → ${interval}ms 间隔下 6 次全部成功`);
  }

  // ========================================================================
  log('');
  log('='.repeat(74));
  log('【结论】');
  log('='.repeat(74));

  if (foundLimit) {
    log('  · 存在可触发的限流阈值（见上方哪一档开始失败）');
    log('  · 生产环境的调用间隔必须**大于**该档位');
  } else {
    log('  · 在测试范围内（≥400ms 间隔、每次 6 连发）未触发限流');
    log('  · 说明 400ms 间隔能撑住这个量级，但不代表无上限');
  }

  log('');
  log(`日志文件：${LOG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
