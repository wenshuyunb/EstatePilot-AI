/**
 * 修复 .env 里被错误写入的字面量 \n。
 *
 * 背景：之前用 node -e 加 PowerShell 双层转义写 .env，
 * 结果 `\n` 被当成字面字符写进了文件，产生了一行
 * `\nBEIKE_HOURLY_LIMIT=12`（变量名不合法）。
 *
 * 用法：node scripts/fix-env-quota-lines.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(process.cwd(), '.env');

if (!existsSync(FILE)) {
  console.log('.env 不存在，跳过');
  process.exit(0);
}

const original = readFileSync(FILE, 'utf8');
const lines = original.split(/\r?\n/);

const fixed = [];
let repairs = 0;

for (const line of lines) {
  /**
   * 匹配形如 `\nBEIKE_XXX=yyy` 的坏行
   * （反斜杠 + n 开头的字面量，后面紧跟合法变量名）
   */
  const match = /^\\n([A-Z][A-Z_0-9]*=.*)$/.exec(line.trim());

  if (match) {
    fixed.push(match[1]);
    repairs += 1;
    console.log(`  修复: ${JSON.stringify(line)} → ${JSON.stringify(match[1])}`);
    continue;
  }

  fixed.push(line);
}

if (repairs === 0) {
  console.log('✓ 未发现需要修复的坏行');
} else {
  writeFileSync(FILE, fixed.join('\n'), 'utf8');
  console.log(`✓ 修复 ${repairs} 行`);
}

// ---- 验证 ----
const verify = readFileSync(FILE, 'utf8');
console.log('');
console.log('配额相关配置：');
for (const line of verify.split('\n')) {
  if (/BEIKE_(HOURLY|DAILY)_LIMIT/.test(line)) {
    console.log(`  ${line.trim()}`);
  }
}

console.log('');
console.log(`替换字符数：${(verify.match(/\uFFFD/g) ?? []).length}`);
console.log(`总行数：${verify.split('\n').length}`);

// 检查是否还有坏行
const stillBad = verify.split('\n').filter((line) => /^\\n[A-Z]/.test(line.trim()));
if (stillBad.length > 0) {
  console.log('');
  console.log('⚠️ 仍有坏行：');
  for (const line of stillBad) console.log(`  ${JSON.stringify(line)}`);
  process.exit(1);
}
