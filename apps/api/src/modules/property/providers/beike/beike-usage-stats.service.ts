/**
 * 贝壳调用统计 —— 自己量化用量，作为配额的"观测替代"。
 *
 * ============================================================================
 * 为什么需要它（配额不可查询的现实）
 * ============================================================================
 * 实测确认：贝壳**没有任何途径可以查询配额**：
 *   · MCP 的 18 个工具里没有 quota/usage 类工具
 *   · 响应头里没有 X-RateLimit-* / Retry-After
 *   · 拿 Key 的页面（building.ke.com）不显示额度
 *   · 本地 CLI 只有 `auth` 命令
 *
 * 因此只能**自己统计调用量**，并观测"多少量级会触发限流"。
 *
 * ============================================================================
 * 统计什么
 * ============================================================================
 *   · 按小时 / 按天的调用次数（总量 + 成功 + 失败）
 *   · 被限流的次数与时刻 —— 这是反推阈值的关键数据
 *   · 各工具的调用分布（知道配额花在哪了）
 *
 * ⚠️ 统计是**进程内**的。多实例部署时需要改为 Redis 汇总
 *    （与节流器面临同样的问题）。
 */

import { Injectable, Logger } from '@nestjs/common';

/** 单次调用记录 */
interface CallRecord {
  tool: string;
  at: number;
  ok: boolean;
  durationMs: number;
  /** 是否被限流（与服务端繁忙区分开） */
  throttled: boolean;
}

/** 按小时聚合的桶 */
interface HourlyBucket {
  /** 小时标识，如 `2026-10-09T15` */
  hour: string;
  total: number;
  succeeded: number;
  failed: number;
  throttled: number;
}

/** 按天聚合的桶 */
interface DailyBucket {
  day: string;
  total: number;
  succeeded: number;
  failed: number;
  throttled: number;
  /** 首次被限流的时刻（ISO），用于分析触发点 */
  firstThrottleAt: string | null;
}

@Injectable()
export class BeikeUsageStats {
  private readonly logger = new Logger(BeikeUsageStats.name);

  /** 保留最近 N 条明细（用于分析"触发限流前发了多少请求"） */
  private readonly maxRecords = 2000;
  private readonly records: CallRecord[] = [];

  /** 上次被限流的时刻（用于去重告警） */
  private lastThrottleWarnAt = 0;

  /**
   * 记录一次调用。
   *
   * @param throttled 是否为限流（由节流器/客户端判定）
   */
  record(input: {
    tool: string;
    ok: boolean;
    durationMs: number;
    throttled: boolean;
  }): void {
    const entry: CallRecord = { ...input, at: Date.now() };

    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }

    if (input.throttled) {
      /**
       * 限流告警：最多每 5 分钟提醒一次。
       *
       * 为什么要限流告警降噪：一旦被限流，后续调用会**连续失败**，
       * 每次都打日志会淹没真正有用的信息。
       */
      if (Date.now() - this.lastThrottleWarnAt > 5 * 60_000) {
        this.lastThrottleWarnAt = Date.now();

        const recent = this.records.filter((r) => r.at > Date.now() - 60 * 60_000);
        this.logger.warn(
          `贝壳限流中 —— 最近 1 小时已调用 ${recent.length} 次` +
            `（成功 ${recent.filter((r) => r.ok).length}）` +
            `。限流按账号计，恢复可能需要较长时间，建议稍后再试。`,
        );
      }
    }
  }

  /**
   * 用量报告。
   *
   * @param hours 回看多少小时（默认 24）
   */
  report(hours = 24): {
    windowHours: number;
    totals: { total: number; succeeded: number; failed: number; throttled: number };
    successRate: string;
    hourly: HourlyBucket[];
    daily: DailyBucket[];
    byTool: Array<{ tool: string; count: number; failed: number }>;
    /** 当前是否处于限流状态 */
    throttledNow: boolean;
    /** 首次被限流的时刻（用于分析触发阈值） */
    firstThrottleAt: string | null;
    /** 被限流前 10 分钟内的调用量 —— 反推阈值的关键 */
    callsBeforeThrottle: number | null;
    notes: string[];
  } {
    const since = Date.now() - hours * 3_600_000;
    const window = this.records.filter((record) => record.at >= since);

    // ---- 按小时聚合 ----
    const hourlyMap = new Map<string, HourlyBucket>();
    for (const record of window) {
      const hour = new Date(record.at).toISOString().slice(0, 13);
      const bucket = hourlyMap.get(hour) ?? {
        hour,
        total: 0,
        succeeded: 0,
        failed: 0,
        throttled: 0,
      };
      bucket.total += 1;
      if (record.ok) bucket.succeeded += 1;
      else bucket.failed += 1;
      if (record.throttled) bucket.throttled += 1;
      hourlyMap.set(hour, bucket);
    }

    // ---- 按天聚合 ----
    const dailyMap = new Map<string, DailyBucket>();
    for (const record of window) {
      const day = new Date(record.at).toISOString().slice(0, 10);
      const bucket = dailyMap.get(day) ?? {
        day,
        total: 0,
        succeeded: 0,
        failed: 0,
        throttled: 0,
        firstThrottleAt: null,
      };
      bucket.total += 1;
      if (record.ok) bucket.succeeded += 1;
      else bucket.failed += 1;
      if (record.throttled) {
        bucket.throttled += 1;
        if (!bucket.firstThrottleAt) bucket.firstThrottleAt = new Date(record.at).toISOString();
      }
      dailyMap.set(day, bucket);
    }

    // ---- 按工具聚合 ----
    const toolMap = new Map<string, { count: number; failed: number }>();
    for (const record of window) {
      const entry = toolMap.get(record.tool) ?? { count: 0, failed: 0 };
      entry.count += 1;
      if (!record.ok) entry.failed += 1;
      toolMap.set(record.tool, entry);
    }

    // ---- 限流分析 ----
    const throttledRecords = window.filter((record) => record.throttled);
    const firstThrottle = throttledRecords[0] ?? null;

    /**
     * 反推阈值：看首次限流**之前 10 分钟**发了多少请求。
     *
     * 这是在没有官方配额数据情况下的最佳估计 ——
     * 如果多次观测都落在相近的量级，那个量级就是实际阈值附近。
     */
    let callsBeforeThrottle: number | null = null;
    if (firstThrottle) {
      const windowStart = firstThrottle.at - 10 * 60_000;
      callsBeforeThrottle = this.records.filter(
        (record) => record.at >= windowStart && record.at < firstThrottle.at,
      ).length;
    }

    const throttledNow = throttledRecords.some((record) => record.at > Date.now() - 5 * 60_000);

    const notes: string[] = [];
    if (this.records.length === 0) {
      notes.push('本次进程启动后还没有贝壳调用记录。');
    }
    if (throttledNow) {
      notes.push(
        '当前处于限流状态。贝壳不支持查询配额，恢复时间未知 —— ' +
          '实测曾持续 40 分钟以上。建议在此期间使用本地缓存数据。',
      );
    }
    if (callsBeforeThrottle !== null) {
      notes.push(
        `首次限流前 10 分钟内的调用量为 ${callsBeforeThrottle} 次 —— ` +
          '这是反推配额的参考值（多次观测取交集更准）。',
      );
    }
    notes.push(
      '注意：统计是**进程内**的，重启后清零。要长期观测需要持久化（可扩展为写入数据库）。',
    );

    const succeeded = window.filter((record) => record.ok).length;

    return {
      windowHours: hours,
      totals: {
        total: window.length,
        succeeded,
        failed: window.length - succeeded,
        throttled: throttledRecords.length,
      },
      successRate: window.length > 0 ? `${Math.round((succeeded / window.length) * 100)}%` : '—',
      hourly: [...hourlyMap.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
      daily: [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
      byTool: [...toolMap.entries()]
        .map(([tool, value]) => ({ tool, ...value }))
        .sort((a, b) => b.count - a.count),
      throttledNow,
      firstThrottleAt: firstThrottle ? new Date(firstThrottle.at).toISOString() : null,
      callsBeforeThrottle,
      notes,
    };
  }

  /** 估算"安全余量"：当前小时用量相对于观测到的阈值 */
  estimateHeadroom(): {
    currentHourCalls: number;
    observedThreshold: number | null;
    headroomPercent: number | null;
    advice: string;
  } {
    const hourAgo = Date.now() - 3_600_000;
    const currentHourCalls = this.records.filter((record) => record.at > hourAgo).length;

    const throttled = this.records.filter((record) => record.throttled);
    const observedThreshold = throttled.length > 0 ? throttled.length : null;

    let headroomPercent: number | null = null;
    let advice = '尚无足够数据判断余量 —— 需要观测到一次限流才能反推阈值。';

    if (observedThreshold !== null && observedThreshold > 0) {
      headroomPercent = Math.max(
        0,
        Math.round(((observedThreshold - currentHourCalls) / observedThreshold) * 100),
      );
      advice =
        headroomPercent > 50
          ? '余量充足。'
          : headroomPercent > 20
            ? '余量偏低，建议减少非必要调用。'
            : '余量很小，建议暂停实时查询，改用缓存。';
    }

    return { currentHourCalls, observedThreshold, headroomPercent, advice };
  }

  /** 清空（测试用） */
  reset(): void {
    this.records.length = 0;
    this.lastThrottleWarnAt = 0;
  }
}
