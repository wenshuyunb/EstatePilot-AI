/**
 * 显示限流探针的完整时间线。
 * 用脚本而不是命令行拼接，避免 shell 转义问题。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const LOG = path.resolve(process.cwd(), '..', '..', '.probe-log.txt');

if (!existsSync(LOG)) {
  console.log('暂无探针日志');
  process.exit(0);
}

const lines = readFileSync(LOG, 'utf8').trim().split('\n');
const probes = lines.filter((line) => line.includes('次探测'));

console.log(`限流探针时间线（共 ${probes.length} 次探测）\n`);
console.log('='.repeat(78));

let firstAt = null;
let lastAt = null;

for (const line of probes) {
  const timeMatch = /^\[([^\]]+)\]/.exec(line);
  const body = line.replace(/^\[[^\]]+\]\s*/, '');

  if (timeMatch) {
    const at = new Date(timeMatch[1]);
    if (!firstAt) firstAt = at;
    lastAt = at;

    // 计算相对首次的时间
    const minutes = Math.round((at.getTime() - firstAt.getTime()) / 60_000);
    const clock = timeMatch[1].slice(11, 19);
    console.log(`  ${clock}  (+${String(minutes).padStart(3)} 分钟)  ${body}`);
  } else {
    console.log(`  ${body}`);
  }
}

console.log('='.repeat(78));

if (firstAt && lastAt) {
  const totalMinutes = Math.round((lastAt.getTime() - firstAt.getTime()) / 60_000);
  console.log(`\n  已持续：约 ${totalMinutes} 分钟（${(totalMinutes / 60).toFixed(1)} 小时）`);
}

const recovered = probes.some((line) => line.includes('已恢复'));
console.log(`  状态：${recovered ? '✅ 已恢复' : '❌ 仍在限流'}`);
console.log('');
console.log('  说明：探针每 5 分钟探测 1 次，恢复时会记录确切时间。');
console.log('        探测本身是「1 次请求」的低频操作，不会加重限流。');
console.log('');
