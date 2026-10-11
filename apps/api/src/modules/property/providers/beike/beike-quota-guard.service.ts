/**
 * 贝壳调用预算护栏 —— 主动限流，避免"不知不觉打满配额"。
 *
 * ============================================================================
 * 为什么需要它（真实事故驱动）
 * ============================================================================
 * 实测发现：贝壳**不提供配额查询**，也**不返回限流信号**
 * （HTTP 200 + 正文 `service temporarily unavailable`，无 Retry-After）。
 *
 * 结果是：我们可能在**完全不知情**的情况下把额度打满，
 * 然后陷入 40 分钟以上的限流期 —— 此时连正常搜索都不可用。
 *
 * 护栏的作用：**在打满之前主动停下来**，并把剩余可用量告诉使用者，
 * 让"限流"从随机事故变成可预期、可控的状态。
 *
 * ============================================================================
 * 三层预算
 * ============================================================================
 *   1. **每小时上限** —— 防止短时间爆发（这是最容易被限流的模式）
 *   2. **每日上限** —— 防止一天累积过量
 *   3. **限流冷却** —— 一旦实际被限流，主动休眠一段时间
 *
 * ============================================================================
 * 超限时的行为
 * ============================================================================
 * **不抛异常**，而是返回"拒绝 + 原因"。
 * 调用方据此降级到本地缓存 —— 对使用者来说，
 * 表现为"数据来自缓存"，而不是"系统坏了"。
 */

import { Injectable, Logger } from '@nestjs/common';

export interface BudgetDecision {
  allowed: boolean;
  /** 拒绝原因（可直接展示给使用者） */
  reason: string | null;
  /** 剩余可用次数 */
  remaining: { hourly: number; daily: number };
  /** 建议的重试时间（ISO） */
  retryAfter: string | null;
}

@Injectable()
export class BeikeQuotaGuard {
  private readonly logger = new Logger(BeikeQuotaGuard.name);

  /**
   * 每小时上限。
   *
   * ============================================================================
   * 取值依据（实测，宁保守勿激进）
   * ============================================================================
   * 实测数据：
   *   · 限流恢复后，**第 2 次搜索就再次触发限流**
   *     （14:35:08 第一次成功 → 14:35:41 第二次被拒）
   *   · 一旦被限流，持续 **1 小时以上**
   *
   * 这说明贝壳的配额非常紧，且限流判定很可能是**滚动累计**的
   * （之前用掉的额度会影响之后）。因此不能按"每小时能发多少次"来估，
   * 必须留出很大余量。
   *
   * 默认 12：足够跑一次完整演示（1 次搜索 + 若干次详情查看），
   * 但不会因为"一个下午的正常使用"就打满。
   *
   * 可用环境变量覆盖：`BEIKE_HOURLY_LIMIT`
   */
  private readonly hourlyLimit = this.readLimit('BEIKE_HOURLY_LIMIT', 12);

  /**
   * 每日上限。
   *
   * 按每小时 12 次、每天实际使用 2-3 小时估算约 30 次，留余量取 40。
   *
   * 可用环境变量覆盖：`BEIKE_DAILY_LIMIT`
   */
  private readonly dailyLimit = this.readLimit('BEIKE_DAILY_LIMIT', 40);

  /** 实际被限流后的冷却时长（10 分钟） */
  private readonly throttleCooldownMs = 10 * 60_000;

  /** 调用时间戳（滚动窗口） */
  private readonly callTimestamps: number[] = [];

  /** 冷却截止时间 */
  private cooldownUntil = 0;

  /** 因预算被拒绝的次数（供诊断） */
  private rejectedCount = 0;

  /** 运行期总开关：置 false 可完全停止实时调用（仅用缓存） */
  private liveCallsEnabled = true;

  private readLimit(envKey: string, fallback: number): number {
    const raw = process.env[envKey]?.trim();
    if (!raw) return fallback;

    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * 申请一次调用许可。
   *
   * 用法：
   *   const decision = guard.check();
   *   if (!decision.allowed) → 降级到缓存
   *   else → 真正调用，然后 guard.record()
   */
  check(): BudgetDecision {
    const now = Date.now();

    // ---- 0. 总开关 ----
    if (!this.liveCallsEnabled) {
      return {
        allowed: false,
        reason: '实时调用已被手动停用，当前只使用本地缓存数据。',
        remaining: this.remaining(),
        retryAfter: null,
      };
    }

    // ---- 1. 限流冷却中 ----
    if (now < this.cooldownUntil) {
      const seconds = Math.ceil((this.cooldownUntil - now) / 1000);
      return {
        allowed: false,
        reason:
          `贝壳已限流，正在冷却（还需约 ${Math.ceil(seconds / 60)} 分钟）。` +
          '此时继续调用会延长限流，因此暂用本地缓存。',
        remaining: this.remaining(),
        retryAfter: new Date(this.cooldownUntil).toISOString(),
      };
    }

    const hourly = this.countSince(now - 3_600_000);
    const daily = this.countSince(now - 86_400_000);

    // ---- 2. 每小时上限 ----
    if (hourly >= this.hourlyLimit) {
      /**
       * 计算"最早可重试时刻"：等最早那次调用滑出 1 小时窗口。
       */
      const oldestInWindow = this.callTimestamps.find((at) => at > now - 3_600_000);
      const retryAt = oldestInWindow ? oldestInWindow + 3_600_000 : now + 60_000;

      return {
        allowed: false,
        reason:
          `本小时已调用 ${hourly} 次（上限 ${this.hourlyLimit} 次），` +
          '为避免触发贝壳限流已暂停实时查询，当前使用本地缓存数据。',
        remaining: { hourly: 0, daily: Math.max(0, this.dailyLimit - daily) },
        retryAfter: new Date(retryAt).toISOString(),
      };
    }

    // ---- 3. 每日上限 ----
    if (daily >= this.dailyLimit) {
      // 次日零点（UTC 简化处理，够用）
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);

      return {
        allowed: false,
        reason:
          `今日已调用 ${daily} 次（上限 ${this.dailyLimit} 次），` +
          '已达到自我保护上限，当前使用本地缓存数据。',
        remaining: { hourly: Math.max(0, this.hourlyLimit - hourly), daily: 0 },
        retryAfter: tomorrow.toISOString(),
      };
    }

    return {
      allowed: true,
      reason: null,
      remaining: {
        hourly: this.hourlyLimit - hourly,
        daily: this.dailyLimit - daily,
      },
      retryAfter: null,
    };
  }

  /** 记录一次已发生的调用 */
  record(): void {
    this.callTimestamps.push(Date.now());
    this.prune();
  }

  /**
   * 上报"被限流"—— 进入冷却。
   *
   * 为什么由外部上报而不是自己判断：限流的识别逻辑在客户端
   * （要区分"限流"与"参数错误""网络故障"），
   * 护栏只负责"知道后停下来"。
   */
  reportThrottled(): void {
    const now = Date.now();
    if (now < this.cooldownUntil) return;

    this.cooldownUntil = now + this.throttleCooldownMs;

    this.logger.warn(
      `检测到贝壳限流 —— 暂停实时调用 ${this.throttleCooldownMs / 60_000} 分钟。` +
        '此期间将使用本地缓存数据。',
    );
  }

  /** 手动启停实时调用（运维用） */
  setLiveCallsEnabled(enabled: boolean): void {
    this.liveCallsEnabled = enabled;
    this.logger.warn(
      enabled ? '已启用贝壳实时调用' : '已停用贝壳实时调用（仅使用本地缓存）',
    );
  }

  isLiveCallsEnabled(): boolean {
    return this.liveCallsEnabled;
  }

  /** 当前状态（供诊断端点） */
  snapshot(): {
    liveCallsEnabled: boolean;
    hourly: { used: number; limit: number; remaining: number };
    daily: { used: number; limit: number; remaining: number };
    coolingDown: boolean;
    cooldownEndsAt: string | null;
    rejectedCount: number;
  } {
    const now = Date.now();
    const hourly = this.countSince(now - 3_600_000);
    const daily = this.countSince(now - 86_400_000);

    return {
      liveCallsEnabled: this.liveCallsEnabled,
      hourly: { used: hourly, limit: this.hourlyLimit, remaining: Math.max(0, this.hourlyLimit - hourly) },
      daily: { used: daily, limit: this.dailyLimit, remaining: Math.max(0, this.dailyLimit - daily) },
      coolingDown: now < this.cooldownUntil,
      cooldownEndsAt: now < this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
      rejectedCount: this.rejectedCount,
    };
  }

  /** 记一次"因预算被拒"（供诊断；由调用方在 check 返回 false 时调用） */
  recordRejection(): void {
    this.rejectedCount += 1;
  }

  /** 清空（测试用） */
  reset(): void {
    this.callTimestamps.length = 0;
    this.cooldownUntil = 0;
    this.rejectedCount = 0;
    this.liveCallsEnabled = true;
  }

  private remaining(): { hourly: number; daily: number } {
    const now = Date.now();
    return {
      hourly: Math.max(0, this.hourlyLimit - this.countSince(now - 3_600_000)),
      daily: Math.max(0, this.dailyLimit - this.countSince(now - 86_400_000)),
    };
  }

  private countSince(since: number): number {
    let count = 0;
    for (const at of this.callTimestamps) {
      if (at >= since) count += 1;
    }
    return count;
  }

  /**
   * 清理超出 24 小时的记录。
   *
   * 为什么只保留 24 小时：每日上限是最大的统计窗口，
   * 更早的记录对判断没有用，留着只会让数组无限增长。
   */
  private prune(): void {
    const cutoff = Date.now() - 86_400_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0]! < cutoff) {
      this.callTimestamps.shift();
    }
  }
}
