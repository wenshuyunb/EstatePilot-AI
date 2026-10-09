/**
 * Provider 健康监控（需求 §9、§14）。
 *
 * ============================================================================
 * 设计要点
 * ============================================================================
 * 1. **内存态为主，可持久化**
 *    健康探测频率低（分钟级），内存足够。需要跨进程共享或重启保留时，
 *    由 `snapshot()` / `restore()` 与数据库的 `PropertyProviderConfig` 表同步。
 *
 * 2. **DEGRADED 不等于不调用**（关键设计决策）
 *    贝壳的真实故障形态是"连接正常、凭证有效，但所有查询返回
 *    service temporarily unavailable"。这类源如果被完全跳过，
 *    等它恢复时我们也发现不了。因此 DEGRADED 的源**仍然参与搜索，
 *    只是排在后面且并发配额更少**，直到连续失败过多才降为 OFFLINE。
 *
 * 3. **滑动窗口统计**，避免历史数据影响当前判断
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ProviderHealthStatus,
  type PropertyProviderKind,
  type PropertyProviderV2,
  type ProviderHealth,
} from '@estatepilot/types';

/** 调用统计（滑动窗口） */
interface CallRecord {
  timestamp: number;
  success: boolean;
  durationMs: number;
  itemCount: number;
}

/** Provider 运行时状态 */
interface ProviderRuntimeState {
  kind: PropertyProviderKind;
  displayName: string;
  status: ProviderHealthStatus;
  lastCheckAt: Date | null;
  lastErrorMessage: string | null;
  lastResponseTimeMs: number | null;
  /** 累计调用 */
  totalCalls: number;
  failedCalls: number;
  /** 连续失败次数（熔断依据） */
  consecutiveFailures: number;
  /** 总返回条数（用于判断"源是否还有数据"） */
  totalItems: number;
  /** 最近调用记录（滑动窗口） */
  recentCalls: CallRecord[];
  /** 管理员是否禁用 */
  disabled: boolean;
}

export interface ProviderStats {
  totalCalls: number;
  failedCalls: number;
  consecutiveFailures: number;
  /** 滑动窗口成功率 0~1 */
  successRate: number;
  /** 平均响应时间（毫秒） */
  avgResponseTimeMs: number | null;
  totalItems: number;
  /** 最近一次调用时间 */
  lastCallAt: Date | null;
}

/** 熔断参数 */
export interface CircuitBreakerConfig {
  /** 滑动窗口大小 */
  windowSize: number;
  /** 窗口内失败率高于该值 → DEGRADED */
  degradedThreshold: number;
  /** 连续失败次数高于该值 → OFFLINE */
  offlineThreshold: number;
}

const DEFAULT_BREAKER: CircuitBreakerConfig = {
  windowSize: 20,
  degradedThreshold: 0.6,
  offlineThreshold: 5,
};

@Injectable()
export class ProviderHealthMonitor {
  private readonly logger = new Logger(ProviderHealthMonitor.name);
  private readonly states = new Map<PropertyProviderKind, ProviderRuntimeState>();
  private readonly breaker: CircuitBreakerConfig = DEFAULT_BREAKER;

  /** 注册 Provider 时调用，建立初始状态 */
  trackProvider(provider: PropertyProviderV2): void {
    if (this.states.has(provider.kind)) return;

    this.states.set(provider.kind, {
      kind: provider.kind,
      displayName: provider.displayName(),
      status: provider.isConfigured()
        ? ProviderHealthStatus.ONLINE
        : ProviderHealthStatus.NOT_CONFIGURED,
      lastCheckAt: null,
      lastErrorMessage: null,
      lastResponseTimeMs: null,
      totalCalls: 0,
      failedCalls: 0,
      consecutiveFailures: 0,
      totalItems: 0,
      recentCalls: [],
      disabled: false,
    });
  }

  /** 记录一次调用 */
  recordCall(
    kind: PropertyProviderKind,
    result: { success: boolean; durationMs: number; itemCount: number; errorMessage?: string },
  ): void {
    const state = this.states.get(kind);
    if (!state) return;

    state.totalCalls += 1;
    state.totalItems += result.itemCount;

    if (!result.success) {
      state.failedCalls += 1;
      state.consecutiveFailures += 1;
      state.lastErrorMessage = result.errorMessage ?? null;
    } else {
      state.consecutiveFailures = 0;
    }

    state.lastResponseTimeMs = result.durationMs;
    state.lastCheckAt = new Date();

    state.recentCalls.push({
      timestamp: Date.now(),
      success: result.success,
      durationMs: result.durationMs,
      itemCount: result.itemCount,
    });

    // 维护滑动窗口
    if (state.recentCalls.length > this.breaker.windowSize) {
      state.recentCalls.splice(0, state.recentCalls.length - this.breaker.windowSize);
    }

    this.evaluateStatus(state);
  }

  /** 记录健康探测结果 */
  recordHealth(health: ProviderHealth): void {
    const state = this.states.get(health.provider);
    if (!state) return;

    state.lastCheckAt = health.checkedAt;
    state.lastResponseTimeMs = health.responseTimeMs;
    state.lastErrorMessage = health.lastErrorMessage;

    // 健康探测是权威结论 —— 但**不覆盖管理员禁用**
    if (!state.disabled) {
      state.status = health.status;
    }

    if (health.status === ProviderHealthStatus.ONLINE) {
      state.consecutiveFailures = 0;
    }
  }

  /**
   * 根据滑动窗口重新评估状态。
   *
   * 状态机：
   *   ONLINE   ──失败率 > 60%──→ DEGRADED
   *   DEGRADED ──连续失败 ≥ 5──→ OFFLINE
   *   任意状态 ──成功一次──→ 连续失败清零（但不立刻回 ONLINE，
   *                          避免抖动；回 ONLINE 由健康探测确认）
   */
  private evaluateStatus(state: ProviderRuntimeState): void {
    if (state.disabled) return;

    // 最近一次成功 → 至少回到 DEGRADED（说明服务还活着）
    if (state.recentCalls.at(-1)?.success && state.status === ProviderHealthStatus.OFFLINE) {
      state.status = ProviderHealthStatus.DEGRADED;
      this.logger.log(`${state.kind} 恢复响应，状态 OFFLINE → DEGRADED`);
    }

    if (state.consecutiveFailures >= this.breaker.offlineThreshold) {
      if (state.status !== ProviderHealthStatus.OFFLINE) {
        this.logger.warn(
          `${state.kind} 连续失败 ${state.consecutiveFailures} 次，状态 → OFFLINE`,
        );
        state.status = ProviderHealthStatus.OFFLINE;
      }
      return;
    }

    if (state.recentCalls.length < 3) return;

    const failures = state.recentCalls.filter((call) => !call.success).length;
    const failureRate = failures / state.recentCalls.length;

    if (failureRate > this.breaker.degradedThreshold) {
      if (state.status === ProviderHealthStatus.ONLINE) {
        this.logger.warn(
          `${state.kind} 滑动窗口失败率 ${(failureRate * 100).toFixed(0)}%，状态 → DEGRADED`,
        );
        state.status = ProviderHealthStatus.DEGRADED;
      }
    }
  }

  /** 取健康状态 */
  getHealth(kind: PropertyProviderKind): ProviderHealth {
    const state = this.states.get(kind);
    const fallback: ProviderHealth = {
      provider: kind,
      sourceType: 'OFFICIAL_API' as ProviderHealth['sourceType'],
      status: ProviderHealthStatus.NOT_CONFIGURED,
      responseTimeMs: null,
      lastErrorMessage: '未注册',
      checkedAt: new Date(),
    };

    if (!state) return fallback;

    return {
      provider: kind,
      sourceType: 'OFFICIAL_API' as ProviderHealth['sourceType'],
      status: state.status,
      responseTimeMs: state.lastResponseTimeMs,
      lastErrorMessage: state.lastErrorMessage,
      checkedAt: state.lastCheckAt ?? new Date(),
    };
  }

  /** 取统计数据 */
  getStats(kind: PropertyProviderKind): ProviderStats {
    const state = this.states.get(kind);

    if (!state) {
      return {
        totalCalls: 0,
        failedCalls: 0,
        consecutiveFailures: 0,
        successRate: 1,
        avgResponseTimeMs: null,
        totalItems: 0,
        lastCallAt: null,
      };
    }

    const window = state.recentCalls;
    const successes = window.filter((call) => call.success).length;
    const successRate = window.length > 0 ? successes / window.length : 1;

    const avgResponseTimeMs =
      window.length > 0
        ? Math.round(window.reduce((sum, call) => sum + call.durationMs, 0) / window.length)
        : null;

    return {
      totalCalls: state.totalCalls,
      failedCalls: state.failedCalls,
      consecutiveFailures: state.consecutiveFailures,
      successRate,
      avgResponseTimeMs,
      totalItems: state.totalItems,
      lastCallAt: state.lastCheckAt,
    };
  }

  /** 是否被管理员禁用 */
  isDisabled(kind: PropertyProviderKind): boolean {
    return this.states.get(kind)?.disabled ?? false;
  }

  /** 管理员启用/禁用（需求 §12） */
  setEnabled(kind: PropertyProviderKind, enabled: boolean): void {
    const state = this.states.get(kind);
    if (!state) return;

    state.disabled = !enabled;
    state.status = enabled ? ProviderHealthStatus.ONLINE : ProviderHealthStatus.DISABLED;

    this.logger.log(`${kind} 已被管理员${enabled ? '启用' : '禁用'}`);
  }

  /**
   * 排序权重 —— 越大越优先。
   *
   * 用于 `getSearchableProviders()` 的同层排序：
   *   ONLINE(100) > DEGRADED(50) > OFFLINE(10)
   *
   * 注意 OFFLINE 仍有权重（不是 0）—— 因为"离线"的判断可能滞后，
   * 而对方随时可能恢复。完全排除会让恢复后依然搜不到。
   */
  sortWeight(kind: PropertyProviderKind): number {
    const state = this.states.get(kind);
    if (!state) return 0;

    switch (state.status) {
      case ProviderHealthStatus.ONLINE:
        return 100;
      case ProviderHealthStatus.DEGRADED:
        return 50;
      case ProviderHealthStatus.OFFLINE:
        return 10;
      default:
        return 0;
    }
  }

  /** 导出快照（供持久化到 PropertyProviderConfig 表） */
  snapshot(): Array<{
    provider: PropertyProviderKind;
    status: ProviderHealthStatus;
    responseTimeMs: number | null;
    successRate: number;
    totalCalls: number;
    failedCalls: number;
    consecutiveFailures: number;
    lastCheckAt: string | null;
    lastErrorMessage: string | null;
    disabled: boolean;
  }> {
    return [...this.states.values()].map((state) => ({
      provider: state.kind,
      status: state.status,
      responseTimeMs: state.lastResponseTimeMs,
      successRate: this.getStats(state.kind).successRate,
      totalCalls: state.totalCalls,
      failedCalls: state.failedCalls,
      consecutiveFailures: state.consecutiveFailures,
      lastCheckAt: state.lastCheckAt?.toISOString() ?? null,
      lastErrorMessage: state.lastErrorMessage,
      disabled: state.disabled,
    }));
  }

  /** 全部状态（供后台界面） */
  listAll(): ReturnType<ProviderHealthMonitor['snapshot']> {
    return this.snapshot();
  }
}
