/**
 * 检查编译产物中中文字符串的完整性。
 *
 * 背景：API 收到的 city 参数码点是 [0x3f, 0x3f]（即 "??"），
 * 而源码中的默认值应该是 "上海"（码点 [0x4e0a, 0x6d77]）。
 * 这说明在编译或读取环节字符已经丢失。
 */

import { readFileSync } from 'node:fs';

const files = [
  'D:/Projects/EstatePilot-AI/apps/api/src/modules/property/beike.controller.ts',
  'D:/Projects/EstatePilot-AI/apps/api/dist/modules/property/beike.controller.js',
  'D:/Projects/EstatePilot-AI/apps/api/src/modules/property/providers/beike/beike-property.provider.ts',
  'D:/Projects/EstatePilot-AI/apps/api/dist/modules/property/providers/beike/beike-property.provider.js',
];

for (const file of files) {
  console.log(`\n=== ${file.split('/').slice(-2).join('/')} ===`);
  try {
    const content = readFileSync(file, 'utf8');

    // 找 city 默认值
    const patterns = [
      /city:\s*z\.string\(\)[^,]*\.default\((['"])(.*?)\1\)/,
      /city\s*=\s*(['"])(.*?)\1/,
      /'(上海|北京)'/g,
    ];

    let found = false;
    for (const pattern of patterns) {
      const matches = [...content.matchAll(new RegExp(pattern.source, 'g'))];
      for (const match of matches.slice(0, 3)) {
        const value = match[2] ?? match[0];
        const points = [...value]
          .slice(0, 20)
          .map((c) => c.codePointAt(0)?.toString(16))
          .join(',');
        console.log(`  匹配: ${JSON.stringify(value)}  码点: [${points}]`);
        found = true;
      }
    }

    if (!found) console.log('  未找到 city 默认值');

    // 统计替换字符与问号
    const replacement = (content.match(/\uFFFD/g) ?? []).length;
    console.log(`  替换字符(U+FFFD) 数量: ${replacement}`);

    // 检查是否包含中文字符
    const hasChinese = /[\u4e00-\u9fff]/.test(content);
    console.log(`  含中文字符: ${hasChinese}`);
  } catch (error) {
    console.log(`  读取失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('\n=== 关键对比 ===');
console.log('「上海」的正确码点: 4e0a, 6d77');
console.log('「??」的码点:       3f, 3f');
