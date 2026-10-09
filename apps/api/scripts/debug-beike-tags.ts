/**
 * 调试：贝壳响应中的标签匹配情况。
 * 用法：node --experimental-strip-types scripts/debug-beike-tags.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = 'D:/Projects/EstatePilot-AI/infrastructure/beike/bin/beike.exe';
const KEY = process.env.BEIKE_MCP_API_KEY ?? '';

async function runCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(CLI, args, {
    timeout: 60_000,
    maxBuffer: 40 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, BEIKE_MCP_API_KEY: KEY },
  });
  return stdout;
}

async function main(): Promise<void> {
  const stdout = await runCli([
    'buy', 'search', '-c', '上海', '-q', '浦东三房', '--house-type', 'second', '--json',
  ]);

  // 取 data 字段
  const firstBrace = stdout.indexOf('{');
  let data = stdout;
  try {
    const env = JSON.parse(stdout.slice(firstBrace)) as { data?: string };
    if (typeof env.data === 'string') data = env.data;
  } catch (error) {
    console.log('顶层 JSON 解析失败:', error instanceof Error ? error.message : error);
  }

  console.log(`data 长度: ${data.length}\n`);

  // 1. 列出所有开标签
  const openTags = [...data.matchAll(/<([^<>\n/][^<>\n]{0,60}?)>/g)].map((m) => m[1]);
  const uniqueTags = [...new Set(openTags)];
  console.log('=== 所有开标签 ===');
  for (const tag of uniqueTags) {
    const count = openTags.filter((t) => t === tag).length;
    console.log(`  <${tag}>  ×${count}`);
  }

  // 2. 检查闭标签
  const closeTags = [...data.matchAll(/<\/([^<>\n]{1,60}?)>/g)].map((m) => m[1]);
  const uniqueClose = [...new Set(closeTags)];
  console.log('\n=== 所有闭标签 ===');
  for (const tag of uniqueClose) {
    const count = closeTags.filter((t) => t === tag).length;
    console.log(`  </${tag}>  ×${count}`);
  }

  // 3. 用当前正则测试
  console.log('\n=== 当前正则的匹配结果 ===');
  const tagPattern = /<([^<>\n/][^<>\n]{0,60}?)>\s*\n([\s\S]*?)\n\s*<\/\1>/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = tagPattern.exec(data)) !== null && index < 15) {
    console.log(`  [${index}] <${match[1]}>  内容 ${match[2]?.length ?? 0} 字符`);
    index += 1;
  }
  console.log(`  （共匹配 ${index}${index >= 15 ? '+' : ''} 处）`);

  // 4. 打印房源区域的实际文本片段
  console.log('\n=== <房源> 区域的实际文本（前 600 字符）===');
  const houseStart = data.indexOf('<房源>');
  if (houseStart >= 0) {
    const snippet = data.slice(houseStart, houseStart + 600);
    console.log(JSON.stringify(snippet));
  } else {
    console.log('未找到 <房源> 标签');
    // 找可能是房源标签的形式
    const numTag = /<(\d{6,})>/.exec(data);
    console.log('数字标签匹配:', numTag ? numTag[1] : '无');
  }

  // 5. 直接测试数字标签的正则
  console.log('\n=== 数字 ID 标签测试 ===');
  const numPattern = /<(\d{6,})>\s*\n([\s\S]*?)\n\s*<\/\1>/g;
  let numMatch: RegExpExecArray | null;
  let numCount = 0;
  while ((numMatch = numPattern.exec(data)) !== null && numCount < 5) {
    console.log(`  <${numMatch[1]}>  ${numMatch[2]?.length ?? 0} 字符`);
    numCount += 1;
  }
  console.log(`  （共 ${numCount} 处）`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
