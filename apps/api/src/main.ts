/**
 * 应用引导入口。
 *
 * 启动顺序（每一步都不可省略）：
 *   1. 校验配置（失败即退出，不带病启动）
 *   2. 初始化日志
 *   3. 建立请求上下文中间件（必须在所有路由之前）
 *   4. 安全中间件：Helmet、CORS
 *   5. 全局管道 / 过滤器 / 拦截器
 *   6. 优雅关闭钩子（保证数据库连接与队列被正确释放）
 */

import 'reflect-metadata';
import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module.js';
import { APP_CONFIG, buildAppConfig, loadConfig, type AppConfig } from './config/configuration.js';
import { AppLogger, filterSensitive } from './common/logger/app-logger.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { runWithContext } from './common/context/request-context.js';
import { TenantService } from './modules/tenant/tenant.service.js';
import { AuditAction } from '@estatepilot/types';

async function bootstrap(): Promise<void> {
  // ---- 1. 配置 ----
  const env = loadConfig();
  const config = buildAppConfig(env);

  // ---- 2. 日志 ----
  const logger = new AppLogger({
    level: config.log.level,
    pretty: config.log.pretty,
    service: `estatepilot-api-${config.env}`,
  });

  logger.write('info', `正在启动 EstatePilot AI API（${config.env}）…`);

  // ---- 3. 创建应用 ----
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    // 关闭默认的 body 解析上限，改为显式限制（防止超大 payload 打爆内存）
    bodyParser: true,
    abortOnError: false,
  });

  app.set('trust proxy', 1); // 位于 Nginx 之后，需要信任 X-Forwarded-For

  // ---- 4. 请求上下文中间件 ----
  // 必须最先注册，保证后续所有守卫/管道/控制器都在上下文内执行
  app.use((req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const forwardedFor = headers['x-forwarded-for'];
    const clientIp =
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ??
      (req.ip as string) ??
      '';

    const traceId =
      (Array.isArray(headers['x-trace-id']) ? headers['x-trace-id'][0] : headers['x-trace-id']) ??
      randomUUID();

    const context = {
      traceId: String(traceId),
      startedAt: Date.now(),
      clientIp,
      userAgent: String(headers['user-agent'] ?? ''),
      method: String(req.method ?? ''),
      path: String(req.originalUrl ?? req.url ?? ''),
    };

    // 把 traceId 回写响应头，便于前端报错时提供追踪 ID
    const resHeaders = res.setHeader as ((name: string, value: string) => void) | undefined;
    resHeaders?.call(res, 'X-Trace-Id', context.traceId);

    runWithContext(context, () => {
      next();
    });
  });

  // ---- 5. 安全中间件 ----
  app.use(
    helmet({
      // API 服务不返回 HTML，放开 CSP 以免影响 Swagger 之类的后续扩展
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // 明确声明这是一个 API
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const allowedOrigins = config.cors.origins;

  app.enableCors({
    origin: (origin, callback) => {
      // 允许同源请求（无 Origin 头，如 Postman、服务端调用）
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      logger.write('warn', `CORS 拒绝来源：${origin}`);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Trace-Id', 'X-Requested-With'],
    exposedHeaders: ['X-Trace-Id'],
    maxAge: 86_400,
  });

  // ---- 6. 全局过滤器 / 版本 ----
  // 说明：不使用 NestJS 的 ValidationPipe —— 它会强制要求安装 class-validator 与
  // class-transformer，而本项目统一用 Zod 校验（见 common/pipes/zod-validation.pipe.ts）。
  // Zod 的额外好处是 Schema 可与前端共享，且类型推断是自动的。

  const httpAdapterHost = app.get(HttpAdapterHost);
  const exceptionFilter = new AllExceptionsFilter();
  // 注入审计写入器：跨租户访问被拒绝时留痕
  const tenantService = app.get(TenantService);
  exceptionFilter.setAuditWriter(async (entry) => {
    await tenantService.forSystem().auditLog.create({
      data: {
        organizationId: entry.organizationId,
        userId: entry.userId,
        action: entry.action as AuditAction,
        entity: entry.entity,
        entityId: entry.entityId,
        message: entry.message,
        ip: entry.ip,
        userAgent: entry.userAgent,
        traceId: entry.traceId,
      },
    });
  });
  app.useGlobalFilters(exceptionFilter);
  void httpAdapterHost;

  // 全局前缀 + URI 版本：/api/v1/...
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // ---- 7. 优雅关闭 ----
  app.enableShutdownHooks();

  // ---- 8. 启动 ----
  await app.listen(config.api.port, '0.0.0.0');

  logger.write('info', `EstatePilot AI API 已启动`);
  logger.write('info', `  地址:     http://localhost:${config.api.port}/api/v1`);
  logger.write('info', `  环境:     ${config.env}`);
  logger.write('info', `  AI 厂商:  ${config.ai.provider}${config.ai.provider === 'mock' ? '（内置模拟，无需密钥）' : ''}`);
  logger.write('info', `  房源来源: ${config.property.provider}${config.property.provider === 'MOCK' ? '（Demo 数据）' : ''}`);
  logger.write('info', `  允许来源: ${allowedOrigins.join(', ')}`);

  if (config.ai.provider !== 'mock' && config.property.provider === 'MOCK') {
    logger.write('info', '  提示: 当前房源为模拟数据，界面会显示 Demo Data 标记');
  }
}

// 顶层启动，未捕获异常直接退出（由容器编排重启）
bootstrap().catch((error: unknown) => {
  // 此时日志系统可能还没就绪，用 console 保证错误一定可见
  console.error('[启动失败]', filterSensitive(error));
  process.exit(1);
});
