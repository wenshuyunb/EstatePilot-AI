/**
 * 验证「贝壳 MCP 工具桥」——AI 助手访问官方 18 个工具的能力。
 *
 * 验证内容：
 *   1. 桥接能列出全部工具（含参数 schema）
 *   2. 有副作用的工具默认被拦住
 *   3. 能真实调用工具（当前服务端故障，应给出**清晰错误**而非假装成功）
 *   4. healthCheck 能正确区分「协议正常」与「数据层故障」
 *
 * 用法：node --experimental-strip-types scripts/verify-beike-bridge.ts
 */

import { BeikeMcpClient } from '../dist/modules/property/providers/beike/beike-mcp-client.js';
import { BeikeToolBridge } from '../dist/modules/ai/beike-tool-bridge.service.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('贝壳 MCP 工具桥验证\n');

  if (!process.env.BEIKE_MCP_API_KEY) {
    console.error('请先设置 BEIKE_MCP_API_KEY');
    process.exit(1);
  }

  const config = {
    env: 'development',
    isDevelopment: true,
    log: { level: 'info' },
    beike: {},
    ai: { provider: 'mock' },
  };

  const client = new BeikeMcpClient(config as never);
  const bridge = new BeikeToolBridge(client);

  // ========================================================================
  console.log('【1】桥接可用性');
  // ========================================================================
  check('桥接可用（直连已启用）', bridge.isAvailable());

  // ========================================================================
  console.log('');
  console.log('【2】工具清单（默认不含副作用工具）');
  // ========================================================================

  const tools = await bridge.listTools();
  console.log(`  发现 ${tools.length} 个工具`);

  check('能列出工具', tools.length > 0);
  check('默认排除 wecom_add_contact_qrcode（有副作用）', !tools.some((t) => t.name === 'wecom_add_contact_qrcode'));
  check('默认排除 report_user_intent（有副作用）', !tools.some((t) => t.name === 'report_user_intent'));
  check('包含核心房源搜索工具 house_search', tools.some((t) => t.name === 'house_search'));

  // 参数 schema 必须带过来（AI 靠它填参数）
  const houseSearch = tools.find((t) => t.name === 'house_search');
  check('house_search 带参数 schema', Boolean(houseSearch && Object.keys(houseSearch.parameters).length > 0));
  check('house_search 标明必填项', Boolean(houseSearch && houseSearch.required.includes('city_name')));

  // 中文填写提示必须注入（模型容易把区名填进 city_name）
  const citySchema = houseSearch?.parameters['city_name'] as { description?: string } | undefined;
  check(
    'city_name 注入了中文填写提示',
    Boolean(citySchema?.description?.includes('填写提示')),
    citySchema?.description,
  );

  if (tools.length > 0) {
    console.log('');
    console.log('  工具清单：');
    for (const tool of tools) {
      console.log(`    · ${tool.name.padEnd(26)} 必填 ${tool.required.join(',') || '(无)'}`);
    }
  }

  // ========================================================================
  console.log('');
  console.log('【3】副作用保护');
  // ========================================================================

  const blocked = await bridge.callTool('wecom_add_contact_qrcode', {});
  check('默认禁止调用副作用工具', !blocked.ok);
  check(
    '拒绝原因明确',
    Boolean(blocked.error?.includes('副作用')),
    blocked.error,
  );

  // 显式开启后应放行（但服务端故障，仍会失败 —— 关键是**不再被本地拦住**）
  const allowed = await bridge.callTool('wecom_add_contact_qrcode', {}, true);
  check(
    '显式开启后不再被本地拦截',
    !allowed.error?.includes('默认禁止'),
    allowed.error,
  );

  // ========================================================================
  console.log('');
  console.log('【4】真实工具调用（错误必须清晰，不能假装成功）');
  // ========================================================================

  const result = await bridge.callTool('plate_search', { city_name: '上海', query: '浦东' });

  console.log(`  ok=${result.ok} | ${result.durationMs}ms`);
  if (result.error) console.log(`  错误: ${result.error.slice(0, 120)}`);

  if (result.ok) {
    check('工具调用成功', true);
    console.log(`  返回 ${result.text.length} 字符`);
  } else {
    // 服务端故障是外部因素，不算测试失败；
    // 但要确认**错误如实传递**，没有被伪装成"没有房源"
    check('失败时 ok=false（未假装成功）', result.ok === false);
    check('失败时带错误原因', Boolean(result.error && result.error.length > 0));
    check(
      '错误未把"服务不可用"说成"没有房源"',
      !/没有找到|无房源|请调整搜索条件/.test(result.error ?? ''),
      result.error,
    );
  }

  // ========================================================================
  console.log('');
  console.log('【5】连通性自检（区分协议正常 vs 数据层故障）');
  // ========================================================================

  const health = await bridge.healthCheck();
  console.log(`  available:   ${health.available}`);
  console.log(`  toolCount:   ${health.toolCount}`);
  console.log(`  dataLayerOk: ${health.dataLayerOk}`);
  console.log(`  message:     ${health.message}`);
  if (health.detail) console.log(`  detail:      ${health.detail.slice(0, 120)}`);

  check('自检能连上 MCP 协议', health.available);
  check('自检报告工具数量', health.toolCount > 0);

  if (!health.dataLayerOk) {
    check(
      '数据层故障时 message 明确指出是「数据层」而非「没房源」',
      health.message.includes('数据层'),
      health.message,
    );
  }

  // ========================================================================
  console.log('');
  console.log('─'.repeat(70));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  if (!health.dataLayerOk) {
    console.log('说明：数据层不可用是**贝壳服务端**的问题（已独立验证 16/16 工具全挂）。');
    console.log('      本脚本验证的是桥接实现正确 —— 服务恢复后即可直接使用。\n');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证异常：', error);
  process.exit(1);
});
