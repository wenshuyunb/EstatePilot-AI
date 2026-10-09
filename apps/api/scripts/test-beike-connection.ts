/**
 * test-beike-connection —— 贝壳连通性最小诊断
 *
 * ============================================================================
 * 目的：证明「项目本身能否调用贝壳」，与业务代码完全隔离
 * ============================================================================
 * 严格不经过：AI / Matching / Property / Database
 * 只做三件事：
 *   1. 读取环境变量（打印，Key 脱敏）
 *   2. 调用贝壳（两种方式：CLI + 直连 HTTP）
 *   3. 返回 HTTP Status / Response Time / 错误信息
 *
 * ============================================================================
 * 为什么同时测 CLI 与直连 HTTP
 * ============================================================================
 * 现象是「控制台确认 Key 有效，但项目里的调用全部返回
 * service temporarily unavailable」。
 *
 * 这个矛盾只有两种解释：
 *   A. CLI 层的问题（凭证读取、参数构造、协议格式）
 *   B. API 侧确实不可用（Key 有效 ≠ 服务可用）
 *
 * 分别验证：
 *   CLI 探测  → 复现项目当前的真实路径
 *   HTTP 探测 → 绕过 CLI，直接证明 Key + Endpoint 是否工作
 * 两者对比就能定位问题在哪一层。
 *
 * 用法：
 *   node --experimental-strip-types scripts/test-beike-connection.ts
 *   node --experimental-strip-types scripts/test-beike-connection.ts -- --http-only
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ============================================================================
// 配置（只读环境变量，不改任何业务代码）
// ============================================================================

const CLI_PATH =
  process.env.BEIKE_CLI_PATH?.trim() ||
  path.resolve(
    process.cwd(),
    '..',
    '..',
    'infrastructure',
    'beike',
    'bin',
    process.platform === 'win32' ? 'beike.exe' : 'beike',
  );

const API_KEY = process.env.BEIKE_MCP_API_KEY?.trim() || '';
const BASE_URL = process.env.BEIKE_MCP_BASE_URL?.trim() || 'https://building.ke.com/mcp';

const args = process.argv.slice(2);
const httpOnly = args.includes('--http-only');
const keepGoing = args.includes('--keep-going');

// ============================================================================
// 工具
// ============================================================================

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

function section(title: string): void {
  console.log('');
  console.log('─'.repeat(74));
  console.log(title);
  console.log('─'.repeat(74));
}

/** 执行 CLI 并捕获结果（不改业务代码，独立实现） */
function runCli(
  cliArgs: string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    execFile(
      CLI_PATH,
      cliArgs,
      {
        timeout: timeoutMs,
        maxBuffer: 40 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          // 与业务代码一致：Key 通过 env 注入，不走 args
          BEIKE_MCP_API_KEY: API_KEY,
          BEIKE_NO_CONFIG_WRITE: '1',
        },
      },
      (error, stdout, stderr) => {
        const ms = Date.now() - startedAt;

        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
          resolve({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: typeof err.code === 'number' ? err.code : null,
            ms,
            error: err.killed ? `超时（${timeoutMs}ms）` : err.message,
          });
          return;
        }

        resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0, ms });
      },
    );
  });
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  console.log('贝壳连通性诊断（test-beike-connection）');
  console.log('不经过 AI / Matching / Property / Database');

  // --------------------------------------------------------------------------
  section('1. 环境变量');
  // --------------------------------------------------------------------------

  console.log(`  BEIKE_MCP_API_KEY     ${API_KEY ? maskKey(API_KEY) : '(未设置)'}`);
  console.log(`  BEIKE_MCP_BASE_URL    ${process.env.BEIKE_MCP_BASE_URL ?? '(未设置，使用默认)'}`);
  console.log(`  BEIKE_CLI_PATH        ${process.env.BEIKE_CLI_PATH ?? '(未设置，使用默认)'}`);
  console.log(`  NODE_ENV              ${process.env.NODE_ENV ?? '(未设置)'}`);
  console.log('');
  console.log(`  解析后的 CLI 路径      ${CLI_PATH}`);
  console.log(`  CLI 文件存在           ${existsSync(CLI_PATH) ? '是' : '否 ← 阻断项'}`);
  console.log(`  实际使用的 API 地址    ${BASE_URL}`);

  const blockers: string[] = [];
  if (!API_KEY) blockers.push('BEIKE_MCP_API_KEY 未设置');
  if (!existsSync(CLI_PATH)) blockers.push('CLI 二进制不存在');

  // --------------------------------------------------------------------------
  section('2. CLI 层探测（复现项目当前路径）');
  // --------------------------------------------------------------------------

  if (httpOnly) {
    console.log('  (--http-only，跳过 CLI 探测)');
  } else if (!existsSync(CLI_PATH)) {
    console.log('  跳过：CLI 不存在');
  } else {
    // 2.1 doctor —— 只验证版本/Key/连通性，不查数据
    console.log('  [2.1] beike doctor（环境诊断）');
    const doctor = await runCli(['doctor']);

    console.log(`        HTTP/退出    ${doctor.ok ? 'OK' : `失败（code=${doctor.code}）`}`);
    console.log(`        响应时间      ${doctor.ms}ms`);
    if (doctor.error) console.log(`        错误          ${doctor.error}`);

    for (const line of doctor.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[✓]') || trimmed.startsWith('[✗]') || trimmed.startsWith('[')) {
        console.log(`        ${trimmed}`);
      }
    }

    // 2.2 真实数据查询 —— 这才是"能不能用"的关键
    console.log('');
    console.log('  [2.2] beike buy plate（最小数据查询，验证数据平面）');
    const plate = await runCli(['buy', 'plate', '-c', '上海', '-q', '张江', '--json']);

    console.log(`        退出码        ${plate.code}`);
    console.log(`        响应时间      ${plate.ms}ms`);

    const plateOutput = plate.stdout.trim();
    const isServiceError = /temporarily unavailable|ok"\s*:\s*false/i.test(plateOutput);

    if (isServiceError) {
      console.log(`        业务错误      是 ← "service temporarily unavailable"`);
    } else if (plateOutput.length > 0) {
      console.log(`        返回长度      ${plateOutput.length} 字符`);
    }

    if (plateOutput.length > 0) {
      console.log(`        返回内容前 300 字：`);
      console.log(`        ${plateOutput.slice(0, 300)}`);
    }
    if (plate.stderr.trim().length > 0) {
      console.log(`        stderr        ${plate.stderr.trim().slice(0, 300)}`);
    }

    // 2.3 搜索（业务真正用到的命令）
    console.log('');
    console.log('  [2.3] beike buy search（业务实际使用的命令）');
    const search = await runCli([
      'buy',
      'search',
      '-c',
      '上海',
      '-q',
      '浦东三房',
      '--house-type',
      'second',
      '--json',
    ]);

    console.log(`        退出码        ${search.code}`);
    console.log(`        响应时间      ${search.ms}ms`);

    const searchOutput = search.stdout.trim();
    const searchIsError = /temporarily unavailable|ok"\s*:\s*false/i.test(searchOutput);

    if (searchIsError) {
      console.log(`        业务错误      是`);
      const errMatch = /"error"\s*:\s*"([^"]*)"/.exec(searchOutput);
      if (errMatch?.[1]) console.log(`        错误内容      ${errMatch[1]}`);
    } else if (searchOutput.length > 0) {
      console.log(`        返回长度      ${searchOutput.length} 字符`);
      const recall = /总召回结果数[：:]\s*(\d+)/.exec(searchOutput);
      if (recall?.[1]) console.log(`        召回数量      ${recall[1]} 套 ← 数据平面正常`);
    }

    if (searchOutput.length > 0 && !searchIsError) {
      console.log(`        返回内容前 300 字：`);
      console.log(`        ${searchOutput.slice(0, 300)}`);
    }
  }

  // --------------------------------------------------------------------------
  section('3. 直连 HTTP 探测（绕过 CLI，验证 Key + Endpoint）');
  // --------------------------------------------------------------------------

  if (!API_KEY) {
    console.log('  跳过：没有 API Key');
  } else {
    // MCP 是 JSON-RPC 2.0 协议，必须带 initialize 握手
    const mcpBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'estatepilot-diagnostic', version: '1.0.0' },
      },
    };

    console.log('  [3.1] POST /mcp  initialize 握手');
    console.log(`        URL           ${BASE_URL}`);
    console.log(`        Header        Authorization: Bearer ${maskKey(API_KEY)}`);
    console.log(`        Header        Content-Type: application/json`);
    console.log(`        Header        Accept: application/json, text/event-stream`);

    const startedAt = Date.now();
    let status = 0;
    let statusText = '';
    let bodyText = '';
    let networkError: string | null = null;
    let serverHeader: string | null = null;
    let contentType: string | null = null;

    try {
      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(mcpBody),
        signal: AbortSignal.timeout(30_000),
      });

      status = response.status;
      statusText = response.statusText;
      serverHeader = response.headers.get('server');
      contentType = response.headers.get('content-type');
      bodyText = await response.text();
    } catch (error) {
      networkError = error instanceof Error ? error.message : String(error);
    }

    const elapsedMs = Date.now() - startedAt;

    console.log('');
    console.log(`        HTTP Status   ${status || '(无响应)'} ${statusText}`);
    console.log(`        Response Time ${elapsedMs}ms`);
    if (serverHeader) console.log(`        Server        ${serverHeader}`);
    if (contentType) console.log(`        Content-Type  ${contentType}`);

    if (networkError) {
      console.log(`        网络错误      ${networkError}`);
      console.log('');
      console.log('        → 结论：网络层不通（DNS / 代理 / 防火墙）');
    } else {
      console.log(`        Body 长度     ${bodyText.length}`);
      if (bodyText.length > 0) {
        console.log(`        Body 前 500 字：`);
        console.log(`        ${bodyText.slice(0, 500).replace(/\n/g, '\n        ')}`);
      }

      // 判定
      console.log('');
      if (status === 401 || status === 403) {
        console.log('        → 结论：授权失败（Key 无效或权限不足）');
      } else if (status === 200 && bodyText.includes('"result"')) {
        console.log('        → 结论：✓ MCP 握手成功 —— Key 与 Endpoint 均有效');
      } else if (status === 200 && /temporarily unavailable/i.test(bodyText)) {
        console.log('        → 结论：Service 层不可用（Key 有效，但数据服务故障）');
      } else if (status === 200) {
        console.log('        → 结论：HTTP 通，但返回非标准 MCP 结果（需看 Body）');
      } else {
        console.log(`        → 结论：HTTP ${status}，需结合 Body 判断`);
      }
    }
  }

  // --------------------------------------------------------------------------
  section('4. 诊断结论');
  // --------------------------------------------------------------------------

  if (blockers.length > 0) {
    console.log('  ✗ 存在阻断项：');
    for (const blocker of blockers) console.log(`      · ${blocker}`);
  } else {
    console.log('  ✓ 环境变量与 CLI 文件均就绪');
  }

  console.log('');
  console.log('  判定顺序（按此排查）：');
  console.log('    1. Key          → 环境变量是否设置且与控制台一致（见第 1 节掩码比对）');
  console.log('    2. Environment  → CLI 路径、BASE_URL 是否正确（见第 1 节）');
  console.log('    3. Endpoint     → 见第 3 节直连结果');
  console.log('    4. Authorization→ 见第 3 节 HTTP Status（401/403 = 授权问题）');
  console.log('    5. CLI          → 见第 2 节（doctor 正常但数据查询失败 = 服务侧问题）');
  console.log('    6. Network      → 见第 3 节网络错误字段');
  console.log('');
  console.log('  关键区分：');
  console.log('    doctor 正常 + 数据查询失败 = 服务侧问题（我方无法修复）');
  console.log('    doctor 失败               = 环境/凭证问题（可修复）');
  console.log('    直连 HTTP 401/403         = Key 问题');
  console.log('    直连 HTTP 200 + result    = Key 有效，问题在 CLI 层');
  console.log('');

  if (!keepGoing) {
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('诊断脚本异常：', error);
  process.exit(1);
});
