'use client';

/**
 * 认证状态（Zustand）。
 *
 * 职责：
 * 1. 保存当前用户与令牌，并在应用启动时从 localStorage 恢复。
 * 2. 提供 login / logout / refreshUser 动作。
 * 3. 监听 API 客户端的「会话过期」事件，自动清理状态并跳登录页。
 *
 * 为什么用 Zustand 而不是 React Context：
 * Context 的值变化会导致整棵子树重渲染，而认证状态（如 user 对象）在
 * 每次令牌刷新时都会变，用 Context 会让整个工作台重渲染。Zustand 只重渲染订阅了具体字段的组件。
 */

import { create } from 'zustand';
import type { AuthUser, UserRole } from '@estatepilot/types';
import { api, tokenStore } from '@/lib/api-client';

/** 登录响应（与后端 LoginResult 对齐） */
interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
  organization: { id: string; name: string; shortName: string | null };
}

/** 当前用户信息响应（/auth/me） */
interface MeResponse {
  user: AuthUser;
  organization: {
    id: string;
    name: string;
    shortName: string | null;
    city: string | null;
    brandName: string | null;
  } | null;
  permissions: {
    canManageUsers: boolean;
    canViewAllStores: boolean;
    canConfigure: boolean;
  };
}

export interface AuthState {
  user: AuthUser | null;
  organization: MeResponse['organization'];
  permissions: MeResponse['permissions'] | null;
  /** 是否已完成初始化（从 localStorage 恢复 + 校验令牌） */
  initialized: boolean;
  /** 登录请求进行中 */
  loading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 用令牌向服务端确认身份（刷新页面时调用） */
  bootstrap: () => Promise<void>;
  /** 局部更新用户信息（如修改姓名后） */
  patchUser: (patch: Partial<AuthUser>) => void;
  /** 角色判断辅助 */
  hasRole: (...roles: UserRole[]) => boolean;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  organization: null,
  permissions: null,
  initialized: false,
  loading: false,
  error: null,

  async login(email, password) {
    set({ loading: true, error: null });
    try {
      const data = await api.post<LoginResponse>(
        '/auth/login',
        { email, password },
        { skipAuth: true, skipRefresh: true },
      );

      tokenStore.set(data.accessToken, data.refreshToken);
      tokenStore.setUser(data.user);

      set({
        user: data.user,
        organization: data.organization
          ? {
              id: data.organization.id,
              name: data.organization.name,
              shortName: data.organization.shortName,
              city: null,
              brandName: null,
            }
          : null,
        loading: false,
        initialized: true,
        error: null,
      });

      // 登录后补全权限信息（不等它完成，避免拖慢跳转）
      void get().bootstrap();
    } catch (error) {
      const message = error instanceof Error ? error.message : '登录失败，请稍后重试';
      set({ loading: false, error: message });
      throw error;
    }
  },

  async logout() {
    const refreshToken = tokenStore.getRefresh();
    try {
      // 通知服务端吊销令牌。失败也要清理本地状态，否则用户会卡在"登不出去"
      await api.post('/auth/logout', { refreshToken: refreshToken ?? undefined });
    } catch {
      // 忽略：本地登出必须成功
    } finally {
      tokenStore.clear();
      set({ user: null, organization: null, permissions: null, error: null });
    }
  },

  async bootstrap() {
    const token = tokenStore.getAccess();
    if (!token) {
      set({ initialized: true, user: null, organization: null, permissions: null });
      return;
    }

    try {
      const data = await api.get<MeResponse>('/auth/me');
      set({
        user: data.user,
        organization: data.organization,
        permissions: data.permissions,
        initialized: true,
      });
      tokenStore.setUser(data.user);
    } catch {
      // 令牌失效或用户被停用：清理并回到未登录态
      tokenStore.clear();
      set({ user: null, organization: null, permissions: null, initialized: true });
    }
  },

  patchUser(patch) {
    const current = get().user;
    if (!current) return;
    const next = { ...current, ...patch };
    tokenStore.setUser(next);
    set({ user: next });
  },

  hasRole(...roles) {
    const role = get().user?.role;
    if (!role) return false;
    return roles.includes(role);
  },

  clearError() {
    set({ error: null });
  },
}));

/** 便捷选择器：避免组件订阅整个 store 导致多余重渲染 */
export const selectUser = (state: AuthState) => state.user;
export const selectIsManager = (state: AuthState) =>
  state.user?.role === 'OWNER' || state.user?.role === 'STORE_MANAGER' || state.user?.role === 'SUPER_ADMIN';
