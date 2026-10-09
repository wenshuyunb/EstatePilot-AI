/**
 * Zod 校验管道。
 *
 * 为什么用 Zod 而不是 class-validator：
 * - Schema 可以从 @estatepilot/types 复用，前后端共享同一份定义。
 * - 类型推断是自动的，不需要手写 DTO 类 + 装饰器两份代码。
 * - 校验失败的错误结构清晰，可以直接映射成字段级提示。
 *
 * 用法：
 *   @Post()
 *   create(@Body(new ZodBody(createCustomerSchema)) dto: CreateCustomerInput) { ... }
 */

import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';

/** 把 Zod 错误整理成字段级明细 */
function formatZodIssues(error: z.ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/**
 * 通用 Zod 校验管道。
 * 泛型参数让控制器方法拿到准确的类型，无需手动断言。
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): TOutput {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: '请求参数校验失败',
        // 这里把明细放进 message 数组的替代结构，由全局过滤器转成 details
        errors: formatZodIssues(result.error),
      });
    }

    return result.data;
  }
}

/** 便捷工厂：用于 @Body(new ZodBody(schema)) */
export function ZodBody<TOutput>(schema: ZodType<TOutput>): ZodValidationPipe<TOutput> {
  return new ZodValidationPipe(schema);
}

/** 便捷工厂：用于 @Query(new ZodQuery(schema)) */
export function ZodQuery<TOutput>(schema: ZodType<TOutput>): ZodValidationPipe<TOutput> {
  return new ZodValidationPipe(schema);
}

// ---------------------------------------------------------------------------
// 常用 Schema 片段（供各模块复用，避免重复定义）
// ---------------------------------------------------------------------------

/** 分页查询参数 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** CUID 形态的 ID */
export const idSchema = z.string().min(1).max(50);

/** 中国大陆手机号 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^1[3-9]\d{9}$/, '请输入有效的中国大陆手机号');

/** 金额（元，非负整数） */
export const amountSchema = z.coerce.number().int().min(0).max(1_000_000_000);

/** 面积（㎡） */
export const areaSchema = z.coerce.number().min(1).max(10_000);

/** 主题标签数组 */
export const tagListSchema = z.array(z.string().trim().min(1).max(20)).max(30).default([]);

/** ISO 日期字符串，自动转 Date */
export const dateSchema = z.coerce.date();

/** 布尔值（支持 "true"/"1" 等字符串形式） */
export const booleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

/** 排序字段白名单校验，防止通过 sortBy 注入任意列名 */
export function createSortSchema<T extends readonly string[]>(allowed: T) {
  return z
    .string()
    .refine((value): value is T[number] => (allowed as readonly string[]).includes(value), {
      message: `排序字段必须是以下之一：${allowed.join(', ')}`,
    })
    .optional();
}
