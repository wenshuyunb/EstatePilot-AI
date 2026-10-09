/**
 * 验证：Node 子进程传中文参数是否被破坏。
 *
 * 背景：API 调用贝壳 CLI 时，日志显示 "unsupported city_name: ??"，
 * 说明「上海」在通过 Node child_process 传参时变成了占位符。
 *
 * 这个脚本对比三种传参方式，定位可用的方案。
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = 'D:/Projects/EstatePilot-AI/infrastructure/beike/bin/beike.exe';
const KEY = process.env.BEIKE_MCP_API_KEY ?? '';

/** 用 execFile 传中文参数（当前实现） */
async function testExecFile(): Promise<void> {
  console.log('=== 方式 1：execFile（当前实现）===');
  try {
    const { stdout } = await execFileAsync(
      CLI,
      ['buy', 'detail', '-c', '上海', '-t', 'house', '--id', '107112596630', '--json'],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: { ...process.env, BEIKE_MCP_API_KEY: KEY } },
    );
    const hasError = stdout.includes('unsupported') || stdout.includes('city_name');
    console.log(`  输出长度: ${stdout.length}`);
    console.log(`  含 city_name 错误: ${hasError}`);
    const match = /unsupported city_name: (\S+)/.exec(stdout);
    if (match) console.log(`  ⚠️ 城市参数被破坏为: "${match[1]}"`);
    else console.log(`  ✓ 未发现城市参数错误`);
    console.log(`  含 <房源>: ${stdout.includes('<房源>')}, 含 107112596630: ${stdout.includes('107112596630')}`);
  } catch (error) {
    console.log(`  ✗ 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 用 spawn 并显式设置编码 */
async function testSpawn(): Promise<void> {
  console.log('\n=== 方式 2：spawn + 显式 UTF-8 解码 ===');
  await new Promise<void>((resolve) => {
    const child = spawn(
      CLI,
      ['buy', 'detail', '-c', '上海', '-t', 'house', '--id', '107112596630', '--json'],
      { windowsHide: true, env: { ...process.env, BEIKE_MCP_API_KEY: KEY } },
    );

    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', () => {
      const stdout = Buffer.concat(chunks).toString('utf8');
      const match = /unsupported city_name: (\S+)/.exec(stdout);
      console.log(`  输出长度: ${stdout.length}`);
      if (match) console.log(`  ⚠️ 城市参数被破坏为: "${match[1]}"`);
      else console.log(`  ✓ 未发现城市参数错误`);
      console.log(`  含 107112596630: ${stdout.includes('107112596630')}`);
      resolve();
    });
  });
}

/** 把城市放进环境变量（绕开命令行传参） */
async function testEnvVar(): Promise<void> {
  console.log('\n=== 方式 3：通过环境变量传城市 ===');
  try {
    const { stdout } = await execFileAsync(
      CLI,
      ['buy', 'detail', '-c', '上海', '-t', 'house', '--id', '107112596630', '--json'],
      {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, BEIKE_MCP_API_KEY: KEY, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
      },
    );
    const match = /unsupported city_name: (\S+)/.exec(stdout);
    console.log(`  输出长度: ${stdout.length}`);
    if (match) console.log(`  ⚠️ 城市参数仍被破坏: "${match[1]}"`);
    else console.log(`  ✓ 未发现城市参数错误`);
  } catch (error) {
    console.log(`  ✗ 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 用拉丁转写（拼音）替代中文，确认是否只有编码问题 */
async function testAsciiCity(): Promise<void> {
  console.log('\n=== 方式 4：用 ASCII 城市名（上海 → shanghai）===');
  try {
    const { stdout } = await execFileAsync(
      CLI,
      ['buy', 'detail', '-c', 'shanghai', '-t', 'house', '--id', '107112596630', '--json'],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: { ...process.env, BEIKE_MCP_API_KEY: KEY } },
    );
    const match = /unsupported city_name: (\S+)/.exec(stdout);
    console.log(`  输出长度: ${stdout.length}`);
    if (match) console.log(`  ⚠️ 仍报城市错误: "${match[1]}"`);
    else console.log(`  ✓ 未发现城市参数错误`);
    console.log(`  含 107112596630: ${stdout.includes('107112596630')}`);
    console.log(`  响应开头: ${stdout.slice(0, 200).replace(/\n/g, ' ')}`);
  } catch (error) {
    console.log(`  ✗ 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  await testExecFile();
  await testSpawn();
  await testEnvVar();
  await testAsciiCity();
  console.log('\n=== 结论 ===');
  console.log('对比上述结果即可确定中文传参是否被破坏，以及替代方案是否可行。');
}

main().catch(console.error);
