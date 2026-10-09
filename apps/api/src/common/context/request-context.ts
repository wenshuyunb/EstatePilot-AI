/**
 * 请求上下文。
 *
 * 用 AsyncLocalStorage 在整条异步调用链上传递请求级信息，
 * 这样 Service 层不必层层透传 traceId / organizationId 参数。
 *
 * 为什么不用 NestJS 的 REQUEST scope：
 * 请求作用域的 Provider 会让整个依赖树变成每请求实例化，性能代价很大。
 * AsyncLocalStorage 是零侵入的方案。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { UserRole } from '@estatepilot/types';

/** 请求上下文中携带的信息 */
export interface RequestContext {
  /** 追踪 ID，出现在所有日志与错误响应中 */
  traceId: string;
  /** 请求开始时间，用于统计耗时 */
  startedAt: number;
  /** 当前用户（已认证时） */
  userId?: string;
  /** 当前租户 —— 所有数据查询的依据 */
  organizationId?: string;
  /** 当前用户所属门店 */
  storeId?: string | null;
  /** 当前用户角色 */
  role?: UserRole;
  /** 是否平台超管 */
  isSuperAdmin?: boolean;
  /** 请求来源 IP（已脱敏前的原始值，仅用于哈希，不写日志） */
  clientIp?: string;
  /** User-Agent */
  userAgent?: string;
  /** 请求方法与路径 */
  method?: string;
  path?: string;
  /** 是否匿名请求（客户专属页面场景） */
  anonymous?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** 在指定上下文中执行函数 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** 取当前上下文，不存在时返回 undefined */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * 取当前上下文，不存在时抛错。
 * 在「必须有租户上下文」的代码路径上使用，让漏传上下文成为显式错误。
 */
export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error(
      '当前不在请求上下文中。如果这是队列任务或定时任务，请用 runWithContext 显式建立上下文。',
    );
  }
  return context;
}

/** 取当前 traceId，没有上下文时返回 '-' */
export function getTraceId(): string {
  return storage.getStore()?.traceId ?? '-';
}

/** 生成新的 traceId */
export function newTraceId(): string {
  return randomUUID();
}

/** 更新当前上下文的字段（用于认证成功后补充用户信息） */
export function patchContext(patch: Partial<RequestContext>): void {
  const context = storage.getStore();
  if (context) Object.assign(context, patch);
}

/**
 * 为后台任务建立上下文。
 * 队列任务没有 HTTP 请求，但同样需要 organizationId 才能安全访问数据库。
 */
export function runAsTask<T>(
  options: { organizationId: string; userId?: string; label: string },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithContext(
    {
      traceId: `task-${randomUUID()}`,
      startedAt: Date.now(),
      organizationId: options.organizationId,
      userId: options.userId,
      anonymous: false,
      method: 'TASK',
      path: options.label,
    },
    fn,
  );
}
