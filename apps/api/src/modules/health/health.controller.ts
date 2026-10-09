/**
 * 健康检查控制器。
 *
 * 供 Docker healthcheck、负载均衡与运维监控使用。
 * 分为两个接口：
 *   /health      轻量存活检查（进程活着就返回 200，不查数据库）
 *   /health/ready 就绪检查（数据库与 Redis 都必须可用）
 * 这样容器编排可以区分「进程还在启动」与「进程已死」。
 */

import { Controller, Get, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { Public } from '../../common/decorators/auth.decorators.js';
import { TenantService } from '../tenant/tenant.service.js';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly tenant: TenantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 存活检查：不触碰任何外部依赖 */
  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  liveness(): {
    status: 'ok';
    service: string;
    env: string;
    timestamp: string;
    uptimeSeconds: number;
  } {
    return {
      status: 'ok',
      service: 'estatepilot-api',
      env: this.config.env,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /** 就绪检查：数据库必须可用 */
  @Public()
  @Get('ready')
  async readiness(): Promise<{
    status: 'ok' | 'degraded';
    checks: Record<string, { ok: boolean; latencyMs: number; error?: string }>;
    timestamp: string;
  }> {
    const database = await this.tenant.healthCheck();

    const checks = { database };
    const allOk = Object.values(checks).every((check) => check.ok);

    return {
      status: allOk ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
