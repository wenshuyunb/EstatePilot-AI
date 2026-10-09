/**
 * 贝壳调用节流器 —— 从源头控制请求速率，避免触发服务端限流。
 *
 * ============================================================================
 * 为什么需要它（真实事故）
 * ============================================================================
 * 实测：一次用户点击「AI 识别需求并匹配房源」会产生约 12-15 次贝壳调用：
 *   · 搜索 1 次
 *   · 详情补全 Top5 × 2 次（entity_detail + entity_material）
 *   · 加上失败重试
 *
 * 这些调用在几秒内密集发出 → 触发贝壳限流 →
 * 所有工具返回 `service temporarily unavailable`（约 220ms 快速失败）→
 * **原本正常的搜索也被熔断挡住**，经纪人看到"贝壳暂时无法查询"。
 *
 * 更糟的是：我们的重试逻辑在限流时**继续发请求**，等于火上浇油。
 *
 * ============================================================================
 * 设计
 * ============================================================================
 *   1. **全局最小间隔**：任意两次贝壳调用之间至少间隔 N 毫秒。
 *      不并发、不突发 —— 用一点延迟换稳定性。
 *   2. **失败退避**：连续失败时自动拉长间隔（指数退避 + 上限）。
 *   3. **成功恢复**：连续成功若干次后逐步恢复到基础间隔。
 *
 * 为什么是"全局"而不是"每工具"：贝壳的限流是按账号/Key 计的，
 * 按工具分别限流没有意义。
 */

import { Injectable, Logger } from '@nestjs/common';

import { BEIKE_USAGE_POLICY } from './beike-usage-policy.js';
import { BeikeUsageStats } from './beike-usage-stats.service.js';
import { BeikeQuotaGuard } from './beike-quota-guard.service.js';

/**
 * 调用预算超限错误。
 *
 * 为什么需要专门的错误类型：调用方要能把"预算用尽"
 * 与"贝壳故障"区分开 —— 前者是**我们主动停止**（可预期、可恢复），
 * 后者是外部故障。两者的用户提示与降级路径都不同。
 */
export class BeikeQuotaExceededError extends Error {
  readonly errorCode = 'BEIKE_QUOTA_EXCEEDED';

  constructor(
    message: string,
    /** 建议的重试时间（ISO） */
    readonly retryAfter: string | null,
  ) {
    super(message);
    this.name = 'BeikeQuotaExceededError';
  }
}

@Injectable()
export class BeikeRateLimiter {
  private readonly logger = new Logger(BeikeRateLimiter.name);

  /**
   * 基础最小间隔（毫秒）。
   *
   * 取值依据：实测正常调用耗时 2-6 秒，因此 400ms 的间隔对总耗时影响很小
   * （Top5 详情 10 次调用 → 增加约 4 秒），但能显著降低突发压力。
   *
   * 为什么不是更大（如 1000ms）：会让 10 次详情调用多花 10 秒，
   * 用户等待明显变长。400ms 是"能压住突发"与"不拖慢体验"的折中。
   *
   * ⚠️ 显式标注 `number`：策略常量用了 `as const`，
   *    不加标注会被推断成字面量类型 `400`，导致后续赋值报错。
   */
  private readonly baseIntervalMs: number = BEIKE_USAGE_POLICY.minCallIntervalMs;

  /** 当前生效的间隔（失败退避时会临时拉长） */
  private currentIntervalMs: number = this.baseIntervalMs;

  /** 最大间隔上限：连续失败时最多拉长到这里 */
  private readonly maxIntervalMs: number = BEIKE_USAGE_POLICY.maxCallIntervalMs;

  /**
   * 用量统计。
   *
   * 与节流器放在一起是有意的：节流器已经掌握每次调用的成败与时刻，
   * 统计直接复用这些信息，不需要在客户端里重复埋点。
   *
   * 用 setter 注入而不是构造函数注入的原因：
   * `BeikeMcpClient` 是**手动 new 出来的**（不走 Nest 依赖注入，
   * 因为它要同时管理 CLI 子进程与直连两条通道），
   * 因此节流器也无法走构造注入。用默认实例 + 可选替换的方式最省事。
   */
  private usageStats = new BeikeUsageStats();

  attachUsageStats(stats: BeikeUsageStats): void {
    this.usageStats = stats;
  }

  /** 取用量统计（供诊断端点读取） */
  getUsageStats(): BeikeUsageStats {
    return this.usageStats;
  }

  /**
   * 调用预算护栏。
   *
   * 与节流器的分工：
   *   · 节流器控制**速率**（调用间隔）—— 防止突发
   *   · 护栏控制**总量**（每小时/每日上限）—— 防止打满配额
   *
   * 两者都需要：速率控制挡不住"稳定但持续过量"的调用；
   * 总量控制挡不住"瞬间爆发"。实测这两种模式都会触发限流。
   */
  private quotaGuard = new BeikeQuotaGuard();

  attachQuotaGuard(guard: BeikeQuotaGuard): void {
    this.quotaGuard = guard;
  }

  getQuotaGuard(): BeikeQuotaGuard {
    return this.quotaGuard;
  }

  /** 上次调用完成的时间戳 */
  private lastCallAt = 0;

  /** 连续失败次数（用于退避） */
  private consecutiveFailures = 0;

  /** 连续成功次数（用于恢复） */
  private consecutiveSuccesses = 0;

  /** 串行化队列：确保调用按顺序、按间隔执行，不会突发 */
  private queue: Promise<void> = Promise.resolve();

  /**
   * 取得"可以发起调用"的许可。
   *
   * 用法：`await limiter.acquire(); await 真正调用(); limiter.reportResult(ok)`
   *
   * 实现说明：用 Promise 链串行化，保证多个并发调用方
   * **排队**而不是同时冲出。这是避免突发的关键 ——
   * 单纯靠 sleep 无法约束并发调用（各自 sleep 后仍会同时发出）。
   */
  async acquire(): Promise<void> {
    /**
     * ---- 预算检查（在排队**之前**做）----
     *
     * 为什么放在排队前：若已超预算，没必要占用队列等待 ——
     * 直接快速失败，让调用方立刻降级到本地缓存，
     * 使用者等待时间更短。
     */
    const decision = this.quotaGuard.check();

    if (!decision.allowed) {
      this.quotaGuard.recordRejection();
      throw new BeikeQuotaExceededError(decision.reason ?? '调用预算已用尽', decision.retryAfter);
    }

    const previous = this.queue;

    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      const elapsed = Date.now() - this.lastCallAt;
      const wait = this.currentIntervalMs - elapsed;

      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      this.lastCallAt = Date.now();

      // 记入预算（真正要发请求了才算）
      this.quotaGuard.record();
    } finally {
      // 无论等待是否异常，都要放行队列，避免死锁
      release();
    }
  }

  /**
   * 上报调用结果，用于动态调整间隔。
   *
   * @param ok 本次调用是否成功（指拿到有效数据，不是 HTTP 200）
   * @param tool 工具名（可选）—— 传入则记录到用量统计，便于分析配额花在哪
   */
  reportResult(ok: boolean, tool?: string): void {
    /**
     * 记录到用量统计。
     *
     * 为什么要统计：贝壳**不提供配额查询**（实测 18 个工具里没有、
     * 响应头里没有、页面里没有），因此只能自己量化用量，
     * 并通过"首次限流前的调用量"反推阈值。
     */
    this.usageStats.record({
      tool: tool ?? 'unknown',
      ok,
      durationMs: Date.now() - this.lastCallAt,
      throttled: !ok && this.consecutiveFailures >= 2,
    });

    if (ok) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses += 1;

      // 连续 5 次成功后逐步恢复
      if (this.consecutiveSuccesses >= 5 && this.currentIntervalMs > this.baseIntervalMs) {
        this.currentIntervalMs = Math.max(this.baseIntervalMs, this.currentIntervalMs - 200);
        this.logger.log(`贝壳调用恢复正常，间隔调整为 ${this.currentIntervalMs}ms`);
      }
      return;
    }

    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;

    /**
     * 连续失败 2 次 → 判定为限流，进入冷却。
     *
     * 为什么是 2 次而不是 1 次：单次失败可能是网络抖动，
     * 但连续 2 次失败且都很快返回（限流的特征），
     * 基本可以确定是服务端在拒绝。
     *
     * 为什么上报给护栏：护栏会让**所有后续调用**立即快速失败并降级到缓存，
     * 而不是继续一个个试 —— 后者会让限流窗口延长。
     */
    if (this.consecutiveFailures >= 2) {
      this.quotaGuard.reportThrottled();
    }

    /**
     * 失败退避：第 1 次失败就开始拉长。
     *
     * 为什么立即退避而不是"连续 3 次才退避"：
     * 贝壳的限流是**触发式**的 —— 一旦被限流，继续发请求会让
     * 限流窗口延长。宁可早退避，也不要火上浇油。
     */
    const next = Math.min(this.maxIntervalMs, this.baseIntervalMs * 2 ** this.consecutiveFailures);

    if (next > this.currentIntervalMs) {
      this.currentIntervalMs = next;
      this.logger.warn(
        `贝壳调用失败（连续 ${this.consecutiveFailures} 次），退避间隔调整为 ${this.currentIntervalMs}ms`,
      );
    }
  }

  /**
   * 是否处于"疑似被限流"状态。
   *
   * 供上层决定：此时**不应重试**，而应直接降级到本地缓存 ——
   * 重试只会让限流更严重。
   */
  isLikelyThrottled(): boolean {
    return this.consecutiveFailures >= 2;
  }

  /** 当前状态快照（供诊断展示） */
  snapshot(): {
    currentIntervalMs: number;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    likelyThrottled: boolean;
  } {
    return {
      currentIntervalMs: this.currentIntervalMs,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      likelyThrottled: this.isLikelyThrottled(),
    };
  }

  /** 手动重置（测试用） */
  reset(): void {
    this.currentIntervalMs = this.baseIntervalMs;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastCallAt = 0;
    this.queue = Promise.resolve();
  }
}
