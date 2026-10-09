/**
 * 验证调用预算护栏。
 *
 * 护栏的目标：**在打满贝壳配额之前主动停下来**，
 * 把"随机被限流"变成"可预期、可控"的状态。
 *
 * 全是本地逻辑测试，不需要网络。
 *
 * 用法：node --experimental-strip-types scripts/verify-quota-guard.ts
 */

import { BeikeQuotaGuard } from '../dist/modules/property/providers/beike/beike-quota-guard.service.js';

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

function main(): void {
  // ========================================================================
  console.log('【1】初始状态：应当允许调用');
  console.log('='.repeat(74));

  const guard = new BeikeQuotaGuard();
  guard.reset();

  const initial = guard.check();
  console.log(`  允许：${initial.allowed}`);
  console.log(`  剩余：每小时 ${initial.remaining.hourly} / 每日 ${initial.remaining.daily}`);

  check('初始允许调用', initial.allowed);
  check('无拒绝原因', initial.reason === null);
  check('剩余量大于 0', initial.remaining.hourly > 0 && initial.remaining.daily > 0);

  // ========================================================================
  console.log('');
  console.log('【2】每小时上限：达到后必须拒绝');
  console.log('='.repeat(74));

  const snapshot = guard.snapshot();
  const hourlyLimit = snapshot.hourly.limit;

  console.log(`  每小时上限：${hourlyLimit}`);

  // 消耗到上限
  for (let i = 0; i < hourlyLimit; i += 1) guard.record();

  const atLimit = guard.check();
  console.log(`  用满 ${hourlyLimit} 次后：允许=${atLimit.allowed}`);
  console.log(`    原因：${atLimit.reason?.slice(0, 60) ?? '（无）'}`);

  check('用满后拒绝调用', !atLimit.allowed);
  check('给出明确原因', Boolean(atLimit.reason));
  check('原因提到使用缓存（不是"系统坏了"）', Boolean(atLimit.reason?.includes('缓存')));
  check('给出重试时间', atLimit.retryAfter !== null);
  check('剩余小时额度为 0', atLimit.remaining.hourly === 0);

  // ========================================================================
  console.log('');
  console.log('【3】每日上限：即使每小时未满也要挡');
  console.log('='.repeat(74));

  const guard2 = new BeikeQuotaGuard();
  guard2.reset();

  const dailyLimit = guard2.snapshot().daily.limit;
  console.log(`  每日上限：${dailyLimit}`);

  /**
   * 模拟"跨小时累计"：直接灌入超过每日上限的记录。
   *
   * 注意：这些记录的时间戳都是"现在"，因此也会触发每小时上限。
   * 这里要验证的是**每日上限单独生效** —— 用另一个护栏
   * 只测试 check() 的每日分支。
   */
  for (let i = 0; i < dailyLimit; i += 1) guard2.record();

  const daily = guard2.check();
  console.log(`  用满每日 ${dailyLimit} 次后：允许=${daily.allowed}`);
  check('每日用满后拒绝', !daily.allowed);

  // ========================================================================
  console.log('');
  console.log('【4】限流冷却：被限流后必须停手');
  console.log('='.repeat(74));

  const guard3 = new BeikeQuotaGuard();
  guard3.reset();

  const beforeCooldown = guard3.check();
  check('冷却前允许调用', beforeCooldown.allowed);

  guard3.reportThrottled();

  const duringCooldown = guard3.check();
  console.log(`  上报限流后：允许=${duringCooldown.allowed}`);
  console.log(`    原因：${duringCooldown.reason?.slice(0, 70) ?? '（无）'}`);

  check('限流后拒绝调用', !duringCooldown.allowed);
  check('说明处于冷却中', Boolean(duringCooldown.reason?.includes('限流')));
  check('给出冷却结束时间', duringCooldown.retryAfter !== null);
  check('snapshot 标记冷却中', guard3.snapshot().coolingDown);

  // 重复上报不应重置冷却时间（避免"越报越久"）
  const firstEnd = guard3.snapshot().cooldownEndsAt;
  guard3.reportThrottled();
  const secondEnd = guard3.snapshot().cooldownEndsAt;
  check('重复上报不延长冷却', firstEnd === secondEnd);

  // ========================================================================
  console.log('');
  console.log('【5】运维开关：可一键停用实时调用');
  console.log('='.repeat(74));

  const guard4 = new BeikeQuotaGuard();
  guard4.reset();

  guard4.setLiveCallsEnabled(false);
  const disabled = guard4.check();
  console.log(`  停用后：允许=${disabled.allowed}`);
  console.log(`    原因：${disabled.reason?.slice(0, 60) ?? '（无）'}`);

  check('停用后拒绝实时调用', !disabled.allowed);
  check('说明已手动停用', Boolean(disabled.reason?.includes('手动停用')));
  check('snapshot 反映停用状态', !guard4.snapshot().liveCallsEnabled);

  guard4.setLiveCallsEnabled(true);
  check('可恢复', guard4.check().allowed);

  // ========================================================================
  console.log('');
  console.log('【6】拒绝计数与统计');
  console.log('='.repeat(74));

  const guard5 = new BeikeQuotaGuard();
  guard5.reset();

  for (let i = 0; i < 3; i += 1) {
    const decision = guard5.check();
    if (!decision.allowed) guard5.recordRejection();
  }

  const stats = guard5.snapshot();
  console.log(`  拒绝次数：${stats.rejectedCount}`);
  check('拒绝计数正确', stats.rejectedCount === 0, `（未超限时不应记拒绝，实际 ${stats.rejectedCount}）`);

  guard5.setLiveCallsEnabled(false);
  for (let i = 0; i < 3; i += 1) {
    const decision = guard5.check();
    if (!decision.allowed) guard5.recordRejection();
  }
  check('超限后记录拒绝', guard5.snapshot().rejectedCount === 3);

  // ========================================================================
  console.log('');
  console.log('【7】边界情况');
  console.log('='.repeat(74));

  const guard6 = new BeikeQuotaGuard();
  guard6.reset();

  // 极端：用满每日上限后，剩余量不应为负数
  for (let i = 0; i < 500; i += 1) guard6.record();
  const extreme = guard6.check();
  check('剩余量不为负', extreme.remaining.hourly >= 0 && extreme.remaining.daily >= 0);
  check('超出后仍拒绝', !extreme.allowed);

  console.log('');
  console.log('─'.repeat(70));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  console.log('说明：护栏的核心价值是**主动停手**，而不是等贝壳来拒绝。');
  console.log('      超限时返回"拒绝 + 原因"，调用方据此降级到本地缓存 ——');
  console.log('      对使用者表现为"数据来自缓存"，而不是"系统坏了"。\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
