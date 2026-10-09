/**
 * 调试：API 暴露的 detail 路径。
 * 用法：node --experimental-strip-types scripts/debug-detail-name.ts
 */

import { BeikePropertyProvider } from '../dist/modules/property/providers/beike/beike-property.provider.js';
import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';

// 构造一个最小的 config（MCP 客户端只用到 process.env，config 参数实际未使用）
const fakeConfig = {} as never;

const client = new BeikeMcpClient(fakeConfig);
const provider = new BeikePropertyProvider(client);

console.log('=== Provider 可用性 ===');
console.log(JSON.stringify(provider.describeAvailability(), null, 2));

console.log('\n=== 客户端状态 ===');
console.log(JSON.stringify(client.describeStatus(), null, 2));

async function main(): Promise<void> {
  const id = '107112596630';

  console.log(`\n=== 测试 fetchPropertyDetail("${id}") ===`);
  try {
    const result = await provider.fetchPropertyDetail(id);
    if (result) {
      console.log(`✓ 成功: ${result.title}`);
      console.log(`  ${result.community} | ${result.totalPrice / 10000}万 | ${result.area}㎡`);
    } else {
      console.log('✗ 返回 null');
    }
  } catch (error) {
    console.log(`✗ 抛错: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`\n=== 测试 fetchPropertiesDetail(["${id}"]) ===`);
  try {
    const results = await provider.fetchPropertiesDetail([id], '上海');
    console.log(`返回 ${results.length} 套`);
    for (const property of results) {
      console.log(`  · ${property.title} | ${property.totalPrice / 10000}万`);
    }
  } catch (error) {
    console.log(`✗ 抛错: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch(console.error);
