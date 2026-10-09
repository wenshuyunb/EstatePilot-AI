/**
 * 定位「CLI 为什么不发送 X-Beike-Cli-Version 头」
 *
 * ============================================================================
 * 已知事实
 * ============================================================================
 *   ✓ Key 有效、Endpoint 正确、协议格式正确
 *   ✓ 手动补上 `X-Beike-Cli-Version: 0.2.26` 头后，服务端返回 18 个工具
 *   ✗ 通过 CLI 调用时，服务端报「未检测到 CLI 版本」
 *
 * 而本地 CLI **已经是最新版 0.2.26**，所以不是"版本太旧"，
 * 而是 **CLI 在该运行环境下没有把版本头发出去**。
 *
 * 项目的调用代码传了两个特殊环境变量（beike-mcp-client.ts:398-403）：
 *   BEIKE_MCP_API_KEY     （凭证，必需）
 *   BEIKE_NO_CONFIG_WRITE （注释写"避免 CLI 读写用户目录配置"）
 *
 * 本脚本逐个环境组合做对照实验，定位是哪个变量导致版本头丢失。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diagnose-cli-env.ts
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

interface RunResult {
  ok: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(cliArgs: string[], env: Record<string, string>, timeoutMs = 45_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    execFile(
      CLI_PATH,
      cliArgs,
      { timeout: timeoutMs, maxBuffer: 40 * 1024 * 1024, windowsHide: true, env },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
        resolve({
          ok: !error,
          ms: Date.now() - startedAt,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err && typeof err.code === 'number' ? err.code : error ? -1 : 0,
        });
      },
    );
  });
}

/** 判定一次调用的结果 */
function classify(result: RunResult): string {
  const out = result.stdout;

  if (/CLI_UPGRADE_REQUIRED|未检测到 CLI 版本/.test(out)) {
    return '❌ 被拒：未检测到 CLI 版本';
  }
  if (/temporarily unavailable/i.test(out)) {
    return '⚠ 服务不可用（但已通过版本检查）';
  }
  if (/"ok"\s*:\s*true|总召回结果数|参考数据/.test(out)) {
    return '✅ 成功拿到数据';
  }
  if (out.trim().length > 0) {
    return `? 返回了内容（${out.trim().length} 字符）`;
  }
  return `? 无输出（stderr ${result.stderr.trim().length} 字符）`;
}

async function main(): Promise<void> {
  console.log('CLI 环境变量对照实验');
  console.log(`CLI: ${CLI_PATH}`);
  console.log(`已安装: ${existsSync(CLI_PATH) ? '是' : '否'}`);
  console.log('');

  // --------------------------------------------------------------------------
  console.log('─'.repeat(74));
  console.log('[0] 先看 CLI 的配置文件（版本头可能来自这里）');
  console.log('─'.repeat(74));

  const homeDir = os.homedir();
  const beikeDir = path.join(homeDir, '.beike');

  console.log(`  用户目录: ${homeDir}`);
  console.log(`  .beike 目录: ${existsSync(beikeDir) ? '存在' : '不存在'}`);

  if (existsSync(beikeDir)) {
    try {
      for (const entry of readdirSync(beikeDir)) {
        const full = path.join(beikeDir, entry);
        console.log(`    · ${entry}`);
        // 只读取小文件，避免打印凭证
        try {
          const content = readFileSync(full, 'utf8');
          if (content.length < 800) {
            const masked = content.replace(/[A-Za-z0-9_-]{20,}/g, (match) => {
              // 长度 >=20 的疑似 Key / token 一律脱敏
              return `${match.slice(0, 4)}****`;
            });
            console.log(`      ${masked.trim().replace(/\n/g, '\n      ')}`);
          } else {
            console.log(`      (${content.length} 字符，略)`);
          }
        } catch {
          // 二进制或不可读，跳过
        }
      }
    } catch {
      console.log('    (无法读取)');
    }
  }

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[1] 对照实验：不同环境变量组合下，CLI 是否被版本检查拒绝');
  console.log('─'.repeat(74));

  // 用最小查询（plate）做探测 —— 它最快，且能区分"版本被拒"与"服务不可用"
  const probeArgs = ['buy', 'plate', '-c', '上海', '-q', '张江', '--json'];

  const baseEnv = { ...process.env } as Record<string, string>;

  const experiments: Array<{ label: string; env: Record<string, string> }> = [
    {
      label: 'A. 仅注入 Key（最少干预）',
      env: { ...baseEnv, BEIKE_MCP_API_KEY: API_KEY },
    },
    {
      label: 'B. Key + BEIKE_NO_CONFIG_WRITE=1（项目当前做法）',
      env: { ...baseEnv, BEIKE_MCP_API_KEY: API_KEY, BEIKE_NO_CONFIG_WRITE: '1' },
    },
    {
      label: 'C. 仅 Key，且清空 HOME/USERPROFILE（模拟不可写用户目录）',
      env: {
        ...baseEnv,
        BEIKE_MCP_API_KEY: API_KEY,
        HOME: '',
        USERPROFILE: '',
      },
    },
    {
      label: 'D. 仅 Key + 显式指定版本头来源（BEIKE_SOURCE=cli）',
      env: { ...baseEnv, BEIKE_MCP_API_KEY: API_KEY, BEIKE_SOURCE: 'cli' },
    },
  ];

  const results: Array<{ label: string; outcome: string; ms: number }> = [];

  for (const experiment of experiments) {
    const result = await runCli(probeArgs, experiment.env);
    const outcome = classify(result);

    results.push({ label: experiment.label, outcome, ms: result.ms });

    console.log('');
    console.log(`  ${experiment.label}`);
    console.log(`    耗时:   ${result.ms}ms`);
    console.log(`    退出码: ${result.code}`);
    console.log(`    结果:   ${outcome}`);

    if (result.stdout.trim().length > 0 && result.stdout.trim().length < 400) {
      console.log(`    输出:   ${result.stdout.trim().replace(/\n/g, ' ').slice(0, 200)}`);
    }
    if (result.stderr.trim().length > 0) {
      console.log(`    stderr: ${result.stderr.trim().slice(0, 200)}`);
    }
  }

  // --------------------------------------------------------------------------
  console.log('');
  console.log('─'.repeat(74));
  console.log('[2] 对照结果汇总');
  console.log('─'.repeat(74));

  for (const result of results) {
    console.log(`  ${result.outcome.padEnd(34)} ← ${result.label}`);
  }

  console.log('');
  const upgradeRejected = results.filter((r) => r.outcome.includes('CLI_UPGRADE_REQUIRED'));
  const passedVersion = results.filter((r) => !r.outcome.includes('CLI_UPGRADE_REQUIRED'));

  if (upgradeRejected.length === 0) {
    console.log('  ★ 所有组合都通过了版本检查 —— 之前的失败可能是服务端抖动');
    console.log('    建议重新运行 test-beike-connection.ts 确认。');
  } else if (passedVersion.length === 0) {
    console.log('  ★ 所有组合都被版本检查拒绝');
    console.log('    → 说明 CLI 本身不发送版本头（可能是该构建的缺陷）');
    console.log('    → 修复方向：在调用层补发 X-Beike-Cli-Version 头，绕过 CLI');
  } else {
    console.log('  ★ 存在差异 —— 环境变量影响了版本头的发送');
    console.log('');
    console.log('    被拒绝的组合：');
    for (const result of upgradeRejected) console.log(`      · ${result.label}`);
    console.log('    通过的组合：');
    for (const result of passedVersion) console.log(`      · ${result.label}（${result.outcome}）`);
    console.log('');
    console.log('    → 对比两组差异即可定位是哪个环境变量导致的问题');
  }
}

main().catch((error) => {
  console.error('诊断异常：', error);
  process.exit(1);
});
