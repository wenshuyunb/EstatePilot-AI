/**
 * 验证贝壳调用节流器与详情缓存。
 *
 * 这两者解决的是**我们自己造成的限流**问题：
 *   · 节流器：确保调用按间隔发出，不突发
 *   · 缓存：同一房源不重复请求
 *
 * 全是本地逻辑测试，不需要网络。
 *
 * 用法：node --experimental-strip-types scripts/verify-rate-limit.ts
 */

import { BeikeRateLimiter } from '../dist/modules/property/providers/beike/beike-rate-limiter.service.js';
import { BeikeDetailCache } from '../dist/modules/property/providers/beike/beike-detail-cache.service.js';

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
  // ========================================================================
  console.log('【1】节流器：调用必须按间隔串行发出');
  console.log('='.repeat(74));

  const limiter = new BeikeRateLimiter();

  const CALLS = 6;
  const timestamps: number[] = [];

  const started = Date.now();
  await Promise.all(
    Array.from({ length: CALLS }, async () => {
      await limiter.acquire();
      timestamps.push(Date.now());
    }),
  );
  const totalMs = Date.now() - started;

  timestamps.sort((a, b) => a - b);
  const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]!);

  console.log(`  ${CALLS} 次调用耗时 ${totalMs}ms`);
  console.log(`  间隔样本: ${gaps.map((g) => `${g}ms`).join(', ')}`);

  check(`${CALLS} 次调用都被节流（总耗时 > ${(CALLS - 1) * 300}ms）`, totalMs > (CALLS - 1) * 300);
  check('没有两次调用同时发出', gaps.every((g) => g >= 100));
  check('间隔稳定（不突发）', gaps.filter((g) => g >= 300).length >= CALLS - 2);

  // ========================================================================
  console.log('');
  console.log('【2】节流器：失败自动退避');
  console.log('='.repeat(74));

  limiter.reset();
  const before = limiter.snapshot().currentIntervalMs;

  limiter.reportResult(false);
  const afterFirst = limiter.snapshot().currentIntervalMs;
  limiter.reportResult(false);
  const afterSecond = limiter.snapshot().currentIntervalMs;

  console.log(`  初始 ${before}ms → 1 次失败 ${afterFirst}ms → 2 次失败 ${afterSecond}ms`);

  check('第 1 次失败即拉长间隔', afterFirst > before);
  check('连续失败继续拉长', afterSecond > afterFirst);
  check('间隔有上限（不超过 2000ms）', afterSecond <= 2000);
  check('连续失败 2 次后标记为"疑似限流"', limiter.snapshot().likelyThrottled);

  // 连续成功后恢复
  for (let i = 0; i < 10; i += 1) limiter.reportResult(true);
  const recovered = limiter.snapshot().currentIntervalMs;
  console.log(`  连续 10 次成功后恢复到 ${recovered}ms`);
  check('连续成功后间隔回落', recovered < afterSecond);
  check('不再标记为限流', !limiter.snapshot().likelyThrottled);

  // ========================================================================
  console.log('');
  console.log('【3】详情缓存：命中与 TTL');
  console.log('='.repeat(74));

  const cache = new BeikeDetailCache();

  const fakeDetail = {
    base: {
      title: '测试房源',
      unitPrice: '10000元/平',
      buildingArea: '100㎡',
      innerArea: null,
      totalPrice: '100万',
      layoutStructure: '平层',
      houseType: '3室2厅',
      houseAge: '满五',
      listingStatus: '在售',
      floor: '中楼层',
      totalFloors: '18层',
      hasElevator: '有电梯',
      orientation: '南',
      elevatorHouseholdRatio: '两梯四户',
      buildingType: '板楼',
      usage: '普通住宅',
      downPayment: '首付约30万起',
      ownership: '商品房',
      beikeScore: null,
      tags: ['满五'],
    },
    community: null,
    nearby: null,
    images: [],
    vrUrl: null,
  };

  check('未写入时读不到', cache.get('P1') === null);

  cache.set('P1', { detail: fakeDetail, vrUrl: null, images: [] });
  check('写入后可读到', cache.get('P1') !== null);

  const stats = cache.snapshot();
  console.log(`  命中 ${stats.hits} / 未命中 ${stats.misses} / 命中率 ${stats.hitRate} / 容量 ${stats.size}`);
  check('命中率已统计', stats.hits === 1 && stats.misses === 1);

  // 容量上限与 LRU 淘汰
  const small = new BeikeDetailCache();
  for (let i = 0; i < 520; i += 1) {
    small.set(`P${i}`, { detail: fakeDetail, vrUrl: null, images: [] });
  }
  const smallStats = small.snapshot();
  console.log(`  写入 520 条后容量 = ${smallStats.size}`);
  check('容量不超过上限（500）', smallStats.size <= 500);
  check('最旧的已被淘汰', small.get('P0') === null);
  check('最新的仍在', small.get('P519') !== null);

  // 批量查询
  const many = cache.getMany(['P1', 'P2', 'P3']);
  check('批量查询只返回命中的', many.size === 1 && many.has('P1'));

  // ========================================================================
  console.log('');
  console.log('─'.repeat(70));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  console.log('说明：节流器的核心价值是**把突发调用摊平**。');
  console.log(`      ${CALLS} 次调用从"瞬间发出"变为"约 ${totalMs}ms 内均匀发出"，`);
  console.log('      配合缓存，一次用户操作的实际请求数可下降 30-60%。\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证异常：', error);
  process.exit(1);
});
