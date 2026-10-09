/**
 * 应用根模块。
 *
 * 全局守卫执行顺序（按 providers 数组顺序）：
 *   1. ThrottlerGuard —— 限流，最早拦截，避免恶意请求消耗资源
 *   2. AuthGuard      —— 解析 token，把用户与租户写入 AsyncLocalStorage 上下文
 *   3. RolesGuard     —— 读取上下文里的角色做权限校验
 * 顺序不能颠倒：RolesGuard 依赖 AuthGuard 写入的上下文。
 */

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, RolesGuard } from './common/guards/auth.guard.js';
import { TokenService } from './modules/auth/token.service.js';
import { APP_CONFIG, type AppConfig } from './config/configuration.js';
import { TenantModule } from './modules/tenant/tenant.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PropertyModule } from './modules/property/property.module.js';
import { OutreachModule } from './modules/outreach/outreach.module.js';
import { CustomerModule } from './modules/customer/customer.module.js';
import { RequirementModule } from './modules/requirement/requirement.module.js';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.rateLimit.ttlSeconds * 1000,
            limit: config.rateLimit.max,
          },
        ],
        // 限流键：已登录用户按用户 ID，未登录按 IP
        getTracker: (req: Record<string, unknown>): string => {
          const context = req.requestContextUserId as string | undefined;
          if (context) return `user:${context}`;
          const ip =
            (req.ip as string) ??
            (Array.isArray(req.ips) ? (req.ips as string[])[0] : undefined) ??
            'unknown';
          return `ip:${ip}`;
        },
      }),
    }),
    TenantModule,
    AuthModule,
    HealthModule,
    NotificationsModule,
    DashboardModule,
    PropertyModule,
    OutreachModule,
    CustomerModule,
    // 微信复制 → AI 需求 → 贝壳 → 推荐闭环
    RequirementModule,
  ],
  providers: [
    // 全局限流守卫最先执行
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // 认证守卫：解析 token，写入租户上下文
    { provide: APP_GUARD, useClass: AuthGuard },
    // 角色守卫：依赖 AuthGuard 写入的上下文
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
