/**
 * 全局异常过滤器。
 *
 * 目标：
 * 1. 所有错误响应结构统一（code + message + traceId），前端只需一套处理逻辑。
 * 2. 敏感信息绝不外泄：5xx 只返回通用文案，详细堆栈只进日志。
 * 3. 跨租户访问被拒绝时，除了返回 403，还写审计日志 —— 这可能是攻击行为。
 * 4. 校验错误返回字段级明细，前端可以直接标红对应输入框。
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiErrorCode, type ApiErrorBody } from '@estatepilot/types';
import { TenantMismatchError, TenantScopeUnsupportedError } from '@estatepilot/database';
import { getContext } from '../context/request-context.js';
import { AuthError } from '../../modules/auth/auth.service.js';

/** 业务异常基类：业务代码抛这个，过滤器原样返回其 code 与 message */
export class BusinessError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly statusCode: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

/** 资源不存在 */
export class NotFoundError extends BusinessError {
  constructor(resource: string, id?: string) {
    super(
      ApiErrorCode.NOT_FOUND,
      id ? `${resource}（${id}）不存在或无权访问` : `${resource}不存在`,
      HttpStatus.NOT_FOUND,
    );
    this.name = 'NotFoundError';
  }
}

/** 配额超限 */
export class QuotaExceededError extends BusinessError {
  constructor(message: string) {
    super(ApiErrorCode.QUOTA_EXCEEDED, message, HttpStatus.FORBIDDEN);
    this.name = 'QuotaExceededError';
  }
}

/** 前置条件不满足（如 Provider 未配置） */
export class PreconditionError extends BusinessError {
  constructor(code: ApiErrorCode, message: string) {
    super(code, message, HttpStatus.PRECONDITION_FAILED);
    this.name = 'PreconditionError';
  }
}

/**
 * 外部依赖暂时不可用（如贝壳房源服务网络不可达）。
 *
 * 用 503 而不是 500，因为这是**临时性外部故障**，不是我们的程序错误：
 *   1. 前端据此显示「贝壳房源暂时无法查询」+「重新查询房源」按钮，
 *      而不是把 500 内部错误暴露给经纪人；
 *   2. 已经完成的工作（如 AI 需求解析结果）保持有效，
 *      用户重试时**不需要重新调用 AI**，避免浪费 Token 与产生不一致的需求。
 */
export class ServiceUnavailableError extends BusinessError {
  constructor(message: string, code: ApiErrorCode = ApiErrorCode.INTERNAL_ERROR) {
    super(code, message, HttpStatus.SERVICE_UNAVAILABLE);
    this.name = 'ServiceUnavailableError';
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const context = getContext();

    const { status, body, logLevel, logMessage } = this.normalize(exception, request);

    // 记录日志。5xx 记 error，4xx 记 warn，避免把正常的业务拒绝刷成错误日志。
    const logPayload = {
      traceId: context?.traceId,
      method: request.method,
      path: request.originalUrl ?? request.url,
      status,
      code: body.code,
      organizationId: context?.organizationId,
      userId: context?.userId,
    };

    if (logLevel === 'error') {
      this.logger.error(
        `${logMessage} | ${JSON.stringify(logPayload)}`,
        exception instanceof Error ? exception.stack?.split('\n').slice(0, 8).join('\n') : undefined,
      );
    } else {
      this.logger.warn(`${logMessage} | ${JSON.stringify(logPayload)}`);
    }

    // 跨租户访问尝试：这是安全事件，必须留痕
    if (exception instanceof TenantMismatchError) {
      void this.auditTenantViolation(exception, request);
    }

    response.status(status).json(body);
  }

  /** 把各种异常归一化成统一的响应体 */
  private normalize(
    exception: unknown,
    request: Request,
  ): {
    status: number;
    body: ApiErrorBody;
    logLevel: 'error' | 'warn';
    logMessage: string;
  } {
    const traceId = getContext()?.traceId;

    // ---- 业务异常 ----
    if (exception instanceof BusinessError) {
      return {
        status: exception.statusCode,
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
          traceId,
        },
        logLevel: 'warn',
        logMessage: exception.message,
      };
    }

    // ---- 认证异常 ----
    if (exception instanceof AuthError) {
      return {
        status: exception.statusCode,
        body: {
          code: this.mapAuthCode(exception.code),
          message: exception.message,
          traceId,
        },
        logLevel: 'warn',
        logMessage: exception.message,
      };
    }

    // ---- 跨租户访问 ----
    if (exception instanceof TenantMismatchError) {
      return {
        status: HttpStatus.FORBIDDEN,
        body: {
          code: ApiErrorCode.TENANT_MISMATCH,
          message: '无权访问该数据',
          traceId,
        },
        logLevel: 'error',
        // 详细原因只进日志，不返回给客户端（避免泄露其他租户信息）
        logMessage: exception.message,
      };
    }

    if (exception instanceof TenantScopeUnsupportedError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: {
          code: ApiErrorCode.INTERNAL_ERROR,
          message: '服务器内部错误',
          traceId,
        },
        logLevel: 'error',
        logMessage: `租户作用域配置错误：${exception.message}`,
      };
    }

    // ---- NestJS 内置 HttpException ----
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // ValidationPipe 抛出的结构：{ message: string[], error: string }
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;

        // 已经带 code 的（守卫里抛的）
        if (typeof resp.code === 'string') {
          // Zod 校验管道会把字段级明细放在 errors 里，这里转成统一的 details
          const details = Array.isArray(resp.errors)
            ? (resp.errors as Array<{ field: string; message: string }>)
            : undefined;

          return {
            status,
            body: {
              code: resp.code as ApiErrorCode,
              message: typeof resp.message === 'string' ? resp.message : '请求失败',
              ...(details ? { details } : {}),
              traceId,
            },
            logLevel: 'warn',
            logMessage: details
              ? `参数校验失败：${details.map((d) => `${d.field}(${d.message})`).join(', ')}`
              : String(resp.message),
          };
        }

        // 字段校验错误
        if (Array.isArray(resp.message)) {
          const details = this.extractValidationDetails(resp.message);
          return {
            status,
            body: {
              code: ApiErrorCode.VALIDATION_FAILED,
              message: '请求参数校验失败',
              details,
              traceId,
            },
            logLevel: 'warn',
            logMessage: `参数校验失败：${details.map((d) => d.field).join(', ')}`,
          };
        }

        return {
          status,
          body: {
            code: this.mapStatusToCode(status),
            message: typeof resp.message === 'string' ? resp.message : exception.message,
            traceId,
          },
          logLevel: 'warn',
          logMessage: exception.message,
        };
      }

      return {
        status,
        body: {
          code: this.mapStatusToCode(status),
          message: exception.message,
          traceId,
        },
        logLevel: 'warn',
        logMessage: exception.message,
      };
    }

    // ---- 数据库已知错误 ----
    if (this.isPrismaKnownError(exception)) {
      const prismaError = exception as { code: string; meta?: Record<string, unknown> };
      if (prismaError.code === 'P2002') {
        const target = Array.isArray(prismaError.meta?.target)
          ? (prismaError.meta.target as string[]).join(', ')
          : '唯一字段';
        return {
          status: HttpStatus.CONFLICT,
          body: {
            code: ApiErrorCode.CONFLICT,
            message: `数据已存在，冲突字段：${target}`,
            traceId,
          },
          logLevel: 'warn',
          logMessage: `唯一约束冲突：${target}`,
        };
      }
      if (prismaError.code === 'P2025') {
        return {
          status: HttpStatus.NOT_FOUND,
          body: { code: ApiErrorCode.NOT_FOUND, message: '记录不存在', traceId },
          logLevel: 'warn',
          logMessage: '记录不存在（P2025）',
        };
      }
      if (prismaError.code === 'P2003') {
        return {
          status: HttpStatus.CONFLICT,
          body: {
            code: ApiErrorCode.CONFLICT,
            message: '该记录被其他数据引用，无法执行此操作',
            traceId,
          },
          logLevel: 'warn',
          logMessage: '外键约束失败（P2003）',
        };
      }
    }

    // ---- 未知异常：绝不把内部细节返回给客户端 ----
    const message = exception instanceof Error ? exception.message : String(exception);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ApiErrorCode.INTERNAL_ERROR,
        message: '服务器内部错误，请稍后重试或联系技术支持',
        traceId,
      },
      logLevel: 'error',
      logMessage: `未处理异常（${request.method} ${request.originalUrl ?? request.url}）：${message}`,
    };
  }

  /** 把 ValidationPipe 的消息数组解析成字段级明细 */
  private extractValidationDetails(messages: unknown[]): Array<{ field: string; message: string }> {
    return messages.map((item, index) => {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      // class-validator 的消息通常是 "field should be ..." 或中文自定义消息
      const match = /^([a-zA-Z0-9_.]+)\s+(.*)$/.exec(text);
      return match?.[1] && match[2]
        ? { field: match[1], message: match[2] }
        : { field: `field_${index}`, message: text };
    });
  }

  /** HTTP 状态码 → 业务错误码 */
  private mapStatusToCode(status: number): ApiErrorCode {
    switch (status) {
      case 400:
        return ApiErrorCode.VALIDATION_FAILED;
      case 401:
        return ApiErrorCode.UNAUTHORIZED;
      case 403:
        return ApiErrorCode.FORBIDDEN;
      case 404:
        return ApiErrorCode.NOT_FOUND;
      case 409:
        return ApiErrorCode.CONFLICT;
      case 429:
        return ApiErrorCode.RATE_LIMITED;
      default:
        return ApiErrorCode.INTERNAL_ERROR;
    }
  }

  /** 认证内部错误码 → 对外错误码 */
  private mapAuthCode(code: string): ApiErrorCode {
    switch (code) {
      case 'TOKEN_EXPIRED':
        return ApiErrorCode.TOKEN_EXPIRED;
      case 'REFRESH_TOKEN_REUSED':
        return ApiErrorCode.REFRESH_TOKEN_REUSED;
      case 'ACCOUNT_LOCKED':
      case 'ACCOUNT_DISABLED':
      case 'INVALID_CREDENTIALS':
        return ApiErrorCode.UNAUTHORIZED;
      default:
        return ApiErrorCode.UNAUTHORIZED;
    }
  }

  /** 判断是否为 Prisma 已知错误 */
  private isPrismaKnownError(exception: unknown): boolean {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      typeof (exception as { code: unknown }).code === 'string' &&
      /^P\d{4}$/.test((exception as { code: string }).code)
    );
  }

  /**
   * 写入跨租户访问审计日志。
   * 用 void + catch 保证审计失败不影响响应。
   *
   * 依赖通过 setAuditWriter 注入（而不是构造函数注入），
   * 因为过滤器需要在 main.ts 里用 app.useGlobalFilters 注册，
   * 那时 Nest 容器已就绪，可以安全地取到服务实例。
   */
  private async auditTenantViolation(exception: TenantMismatchError, request: Request): Promise<void> {
    try {
      if (!this.auditWriter) return;

      const context = getContext();
      if (!context?.organizationId) return;

      await this.auditWriter({
        organizationId: context.organizationId,
        userId: context.userId ?? null,
        action: 'VIEW_SENSITIVE',
        entity: exception.model,
        entityId: null,
        message: `跨租户访问被拒绝：${exception.message}`,
        ip: context.clientIp ?? null,
        userAgent: context.userAgent ?? null,
        traceId: context.traceId,
        path: request.originalUrl ?? request.url,
        method: request.method,
      });
    } catch {
      // 审计失败不阻断响应
    }
  }

  /** 审计写入器，由 main.ts 在容器就绪后注入 */
  private auditWriter: AuditWriter | null = null;

  /** 注入审计写入器 */
  setAuditWriter(writer: AuditWriter): void {
    this.auditWriter = writer;
  }
}

/** 审计写入器签名 */
export type AuditWriter = (entry: {
  organizationId: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  message: string;
  ip: string | null;
  userAgent: string | null;
  traceId: string;
  path: string;
  method: string;
}) => Promise<void>;
