/**
 * API 客户端。
 *
 * 设计要点：
 * 1. **统一错误处理**：后端返回 { code, message, details, traceId }，
 *    这里转成带类型的 ApiError，调用方可以按 code 分支处理（而不是解析字符串）。
 * 2. **自动刷新令牌**：access token 过期时自动用 refresh token 换新的并重放请求，
 *    且并发请求只会触发一次刷新（避免 refresh token 因多次使用被判为重放攻击）。
 * 3. **浏览器端与 SSR 通用**：服务端渲染时通过内部代理访问，浏览器端直连后端。
 * 4. traceId 会附加到错误对象上，方便用户报错时提供给客服定位日志。
 */

import type { ApiErrorCode } from '@estatepilot/types';

/** 后端地址。浏览器端直连；SSR 时走 Next 的 rewrite 代理（见 next.config.ts） */
const API_BASE_URL =
  typeof window === 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001') + '/api/v1'
    : (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001') + '/api/v1';

/** 令牌存储键。放在 localStorage 是因为客户端页面与后端不同源，
 *  生产环境若前后端同域部署，建议改为 httpOnly Cookie（更防 XSS）。 */
const ACCESS_TOKEN_KEY = 'estatepilot:access_token';
const REFRESH_TOKEN_KEY = 'estatepilot:refresh_token';
const USER_KEY = 'estatepilot:user';

/** 结构化 API 错误 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | string,
    message: string,
    readonly status: number,
    readonly details?: Array<{ field: string; message: string }>,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 是否为认证类错误（调用方据此跳登录页） */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'UNAUTHORIZED' || this.code === 'TOKEN_EXPIRED';
  }

  /** 字段级错误，便于表单标红 */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      out[detail.field] = detail.message;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 令牌管理
// ---------------------------------------------------------------------------

export const tokenStore = {
  getAccess(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  getRefresh(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  set(accessToken: string, refreshToken: string): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  setAccess(accessToken: string): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  },
  setUser(user: unknown): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  getUser<T>(): T | null {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  clear(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  },
};

// ---------------------------------------------------------------------------
// 请求核心
// ---------------------------------------------------------------------------

interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** JSON 请求体 */
  body?: unknown;
  /** 查询参数，值为 undefined 的会被忽略 */
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  /** 跳过自动附加 Authorization 头 */
  skipAuth?: boolean;
  /** 该请求不触发自动刷新（刷新接口本身用） */
  skipRefresh?: boolean;
  /**
   * 请求超时（毫秒）。默认 30 秒。
   *
   * 需要单独配置的场景：微信助手闭环要串行调用贝壳搜索与详情补全，
   * 正常耗时 10～30 秒，因此必须放宽到 180 秒，否则前端会先超时断开，
   * 而后端其实还在正常工作（用户会看到"失败"但数据已经生成）。
   */
  timeoutMs?: number;
}

/** 把查询参数拼成 URLSearchParams */
function buildQueryString(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      // 数组用逗号分隔，后端按 parseStringArray/parseNumberArray 解析
      params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * 刷新令牌的并发去重。
 *
 * 为什么重要：如果页面同时发起 5 个请求且都发现 token 过期，
 * 并发调用刷新接口会让后端收到 5 次同一个 refresh token —— 而我们的
 * 重放检测会判定这是攻击并吊销整个会话！因此必须保证同一时刻只有一次刷新。
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = tokenStore.getRefresh();
    if (!refreshToken) return false;

    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        tokenStore.clear();
        return false;
      }

      const data = (await response.json()) as { accessToken: string; refreshToken: string };
      tokenStore.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      // 无论成功失败都要释放，否则后续刷新会被永久卡住
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/** 解析错误响应体为 ApiError */
async function toApiError(response: Response): Promise<ApiError> {
  let code: string = 'INTERNAL_ERROR';
  let message = `请求失败（HTTP ${response.status}）`;
  let details: Array<{ field: string; message: string }> | undefined;
  let traceId: string | undefined;

  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      details?: Array<{ field: string; message: string }>;
      traceId?: string;
    };
    if (body.code) code = body.code;
    if (body.message) message = body.message;
    if (Array.isArray(body.details)) details = body.details;
    if (body.traceId) traceId = body.traceId;
  } catch {
    // 响应体不是 JSON（如 Nginx 返回的 502 页面），保留默认文案
  }

  return new ApiError(code as ApiErrorCode, message, response.status, details, traceId);
}

/** 发起一次请求（内部使用，含自动刷新逻辑） */
async function requestOnce<T>(path: string, options: RequestOptions): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (!options.skipAuth) {
    const token = tokenStore.getAccess();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  // 超时控制：合并调用方传入的 signal 与超时 signal
  // （AbortSignal.any 在 Node 20+ / 现代浏览器均可用，这里做兼容处理）
  // 注意：body / query / skipAuth / skipRefresh / timeoutMs 都是本层的私有选项，
  // 必须从传给 fetch 的参数里剔除，否则会因类型不符报错（也会把无效字段传给 fetch）。
  const {
    timeoutMs,
    body,
    query: _query,
    skipAuth: _skipAuth,
    skipRefresh: _skipRefresh,
    ...fetchOptions
  } = options;
  const effectiveTimeout = timeoutMs ?? 30_000;
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), effectiveTimeout);

  let signal: AbortSignal = timeoutController.signal;
  if (options.signal) {
    signal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}${buildQueryString(options.query)}`, {
      ...fetchOptions,
      headers,
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    // 区分"超时"与"网络错误"：超时需要给用户不同的提示
    // （超时说明后端可能还在工作，用户不该重复点击）
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(
        'TIMEOUT' as ApiErrorCode,
        `请求超时（${Math.round(effectiveTimeout / 1000)} 秒）。` +
          `如果正在执行 AI 匹配，后端可能仍在处理，请稍后刷新查看结果。`,
        408,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  // 204 无内容
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return (await response.text()) as unknown as T;
  }

  return (await response.json()) as T;
}

/** 公开的请求方法：失败时按需自动刷新令牌并重放一次 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await requestOnce<T>(path, options);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.isAuthError &&
      !options.skipAuth &&
      !options.skipRefresh &&
      typeof window !== 'undefined'
    ) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        // 重放原请求，但要避免再次触发刷新（skipRefresh）
        return requestOnce<T>(path, { ...options, skipRefresh: true });
      }

      // 刷新失败：清理令牌并通知应用跳登录页
      tokenStore.clear();
      window.dispatchEvent(new CustomEvent('estatepilot:session-expired'));
    }
    throw error;
  }
}

/** API 客户端 */
export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),

  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

export { API_BASE_URL };
