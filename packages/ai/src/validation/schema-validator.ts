/**
 * 极简 JSON Schema 校验器。
 *
 * 为什么不引入 ajv：本项目的输出 Schema 是固定的内部契约（见 prompts/registry.ts），
 * 只需要 object/array/string/number/integer/boolean/enum/required 这几种子集。
 * 自己实现可以避免一整棵依赖树，且错误信息更贴合业务。
 *
 * 用途：AI 返回的结构化结果在写入数据库前必须过这一关，
 * 防止模型偶发返回不合规 JSON 导致脏数据。
 */

import type { JsonSchema } from '@estatepilot/types';

export interface ValidationIssue {
  /** 字段路径，如 "preferredDistricts[0].score" */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** 校验值是否符合 Schema */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const currentPath = path || '(root)';

  // oneOf / anyOf：任一分支通过即可
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives && alternatives.length > 0) {
    const anyPassed = alternatives.some(
      (candidate) => validateAgainstSchema(value, candidate, path).length === 0,
    );
    if (!anyPassed) {
      issues.push({ path: currentPath, message: `值不符合任何一个允许的结构（oneOf/anyOf）` });
    }
    return issues;
  }

  // const
  if (schema.const !== undefined && value !== schema.const) {
    issues.push({ path: currentPath, message: `期望固定值 ${JSON.stringify(schema.const)}` });
    return issues;
  }

  // enum
  if (schema.enum && schema.enum.length > 0) {
    if (!schema.enum.includes(value as string | number | boolean)) {
      issues.push({
        path: currentPath,
        message: `值 ${JSON.stringify(value)} 不在允许的枚举范围内：${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      });
      return issues;
    }
    return issues;
  }

  // 类型归一化：type 可能是数组（表示可空）
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];

  if (types.length > 0) {
    const matchesType = types.some((type) => matchesJsonType(value, type));
    if (!matchesType) {
      issues.push({
        path: currentPath,
        message: `类型不匹配：期望 ${types.join(' | ')}，实际 ${describeValueType(value)}`,
      });
      return issues;
    }
    // null 是合法值（当 type 包含 null），无需继续校验子结构
    if (value === null) return issues;
  }

  // 数值范围
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path: currentPath, message: `数值 ${value} 小于最小值 ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path: currentPath, message: `数值 ${value} 大于最大值 ${schema.maximum}` });
    }
  }

  // 对象
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    for (const requiredField of schema.required ?? []) {
      if (!(requiredField in record) || record[requiredField] === undefined) {
        issues.push({ path: path ? `${path}.${requiredField}` : requiredField, message: '缺少必填字段' });
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in record && record[key] !== undefined) {
        issues.push(
          ...validateAgainstSchema(record[key], childSchema, path ? `${path}.${key}` : key),
        );
      }
    }

    // additionalProperties: false 时拒绝未声明字段，防止模型自由发挥
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          issues.push({
            path: path ? `${path}.${key}` : key,
            message: '出现了 Schema 未声明的字段',
          });
        }
      }
    }
  }

  // 数组
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path: currentPath, message: `数组长度 ${value.length} 小于最小长度 ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path: currentPath, message: `数组长度 ${value.length} 大于最大长度 ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
      });
    }
  }

  return issues;
}

/** 校验并返回结果对象 */
export function validate(value: unknown, schema: JsonSchema): ValidationResult {
  const issues = validateAgainstSchema(value, schema);
  return { valid: issues.length === 0, issues };
}

function matchesJsonType(value: unknown, type: NonNullable<JsonSchema['type']>): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 宽容校验：先严格校验，失败时尝试常见修复后再校验。
 *
 * 常见可修复问题（真实模型输出中很普遍）：
 * - 数值型字段返回了字符串（"5000000"）
 * - 枚举值大小写不一致（"urgent" vs "URGENT"）
 * - 可选数组返回 null 而非 []
 */
export function validateAndCoerce(
  value: unknown,
  schema: JsonSchema,
): ValidationResult & { coerced: unknown } {
  const firstPass = validate(value, schema);
  if (firstPass.valid) return { ...firstPass, coerced: value };

  const coerced = coerceValue(value, schema);
  const secondPass = validate(coerced, schema);
  return { ...secondPass, coerced };
}

function coerceValue(value: unknown, schema: JsonSchema): unknown {
  if (value === null || value === undefined) {
    // 可选字段为 null 时，数组给 []，其他保持 null
    if (schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))) return [];
    return value;
  }

  if (schema.enum && typeof value === 'string') {
    const upper = value.toUpperCase();
    const hit = schema.enum.find((candidate) => String(candidate).toUpperCase() === upper);
    if (hit !== undefined) return hit;
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];

  if ((types.includes('number') || types.includes('integer')) && typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed)) return types.includes('integer') ? Math.round(parsed) : parsed;
  }

  if (types.includes('string') && typeof value === 'number') return String(value);

  if (types.includes('boolean') && typeof value === 'string') {
    if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...record };
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in out) out[key] = coerceValue(out[key], childSchema);
    }
    return out;
  }

  if (Array.isArray(value) && schema.items) {
    return value.map((item) => coerceValue(item, schema.items as JsonSchema));
  }

  return value;
}
