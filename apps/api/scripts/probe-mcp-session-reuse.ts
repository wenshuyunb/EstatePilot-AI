/**
 * 探测：MCP 会话能否复用？握手是否每次都必要？
 *
 * ============================================================================
 * 为什么这个探测很关键
 * ============================================================================
 * 用量统计发现：**每次会话的 initialize 与 notifications/initialized 也被计入**。
 * 如果这两个请求真的消耗配额，那么按当前实现（每次调用都重新握手）
 * 一次搜索 3 次请求里有 2 次是握手 —— **2/3 的配额花在握手上**。
 *
 * 本探针要回答：
 *   1. 服务端是否返回 `mcp-session-id`？（返回 → 支持会话复用）
 *   2. **跳过握手**能否直接调用工具？（能 → 握手可省）
 *   3. 同一个会话 ID 复用时，行为是否正常？
 *
 * ⚠️ 探测会消耗配额。因此设计为**最多 3 次请求**，且只在服务可用时执行。
 *
 * 用法：node --experimental-strip-types scripts/probe-mcp-session-reuse.ts
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() ?? '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';
const CLI_VERSION = '0.2.26';

const LOG_FILE = path.resolve(process.cwd(), '..', '..', '.session-log.txt');

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

interface CallOutcome {
  status: number;
  ms: number;
  sessionId: string | null;
  ok: boolean;
  text: string;
  /** 响应头里所有 mcp 相关字段 */
  mcpHeaders: Record<string, string>;
}

async function call(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<CallOutcome> {
  const started = Date.now();

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Beike-Cli-Version': CLI_VERSION,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  const mcpHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (/mcp|session/i.test(key)) mcpHeaders[key] = value;
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
    ms: Date.now() - started,
    sessionId: response.headers.get('mcp-session-id'),
    ok: !isError,
    text: text.slice(0, 200),
    mcpHeaders,
  };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  log('MCP 会话复用探测启动');

  const TOOL_CALL = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'house_search', arguments: { city_name: '厦门', query: '湖里区 三房' } },
  };

  // ========================================================================
  log('');
  log('【第 1 步】不握手，直接调用工具 —— 测试握手是否必要');
  // ========================================================================

  const noHandshake = await call(TOOL_CALL);

  log(`  HTTP ${noHandshake.status} | ${noHandshake.ms}ms`);
  log(`  session-id 响应头：${noHandshake.sessionId ?? '(无)'}`);
  if (Object.keys(noHandshake.mcpHeaders).length > 0) {
    log('  MCP 相关响应头：');
    for (const [key, value] of Object.entries(noHandshake.mcpHeaders)) {
      log(`    ${key}: ${value}`);
    }
  }
  log(`  结果：${noHandshake.ok ? '✅ 成功' : '❌ 失败'}`);
  log(`  正文：${noHandshake.text.slice(0, 120)}`);

  if (noHandshake.ok) {
    log('');
    log('  ★ 结论：**无需握手即可调用工具** —— 握手请求可以完全省掉！');
    log('    这意味着每次调用可少发 2 个请求（initialize + initialized）。');
  } else if (/temporarily unavailable/i.test(noHandshake.text)) {
    log('');
    log('  服务限流中，无法判断握手是否必要。请稍后重试。');
    return;
  } else {
    log('');
    log('  未能成功 —— 可能是协议要求先握手。需要保留握手流程。');
  }

  // ========================================================================
  log('');
  log('【第 2 步】握手一次，看服务端是否发放 session-id');
  // ========================================================================

  const init = await call({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'estatepilot-session-probe', version: '1.0.0' },
    },
  });

  log(`  HTTP ${init.status} | ${init.ms}ms`);
  log(`  session-id：${init.sessionId ?? '(未发放)'}`);

  if (Object.keys(init.mcpHeaders).length > 0) {
    log('  MCP 相关响应头：');
    for (const [key, value] of Object.entries(init.mcpHeaders)) {
      log(`    ${key}: ${value}`);
    }
  } else {
    log('  （响应头里没有任何 session 相关字段）');
  }

  const sessionId = init.sessionId;

  if (!sessionId) {
    log('');
    log('  ★ 结论：服务端**不发放 session-id** —— 它是无状态的。');
    log('    因此"复用会话"无从谈起；能优化的只有"是否每次都要握手"。');
  } else {
    // ======================================================================
    log('');
    log('【第 3 步】带 session-id 调用工具');
    // ======================================================================

    const reused = await call(TOOL_CALL, { 'mcp-session-id': sessionId });
    log(`  HTTP ${reused.status} | ${reused.ms}ms`);
    log(`  结果：${reused.ok ? '✅ 成功（会话可复用）' : '❌ 失败'}`);
    log(`  正文：${reused.text.slice(0, 120)}`);
  }

  // ========================================================================
  log('');
  log('='.repeat(74));
  log('【优化建议】');
  log('='.repeat(74));
  log('');
  if (noHandshake.ok) {
    log('  省掉握手：每次调用从 3 个请求降到 1 个 —— 调用量降 66%');
  } else {
    log('  握手无法省掉，但可**在进程内复用会话状态**（只握手一次）');
  }
  log('');
  log('  其他降频手段：');
  log('    · 详情按需加载（已实现）—— 一次搜索 11 次 → 1 次');
  log('    · 详情缓存 30 分钟（已实现）—— 同一房源不重复取');
  log('    · 节流 400ms + 失败退避（已实现）—— 把突发摊平');
  log('    · 每日调用上限护栏（待实现）—— 接近限额时主动停止');
  log('    · 会话内只握手一次（本次探测的目标）');
  log('');
  log(`日志：${LOG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
