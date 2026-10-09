/**
 * Prompt 渲染与版本管理。
 *
 * 核心职责：
 * 1. 把模板中的 {{variable}} 占位替换为实际数据。
 * 2. 渲染前强制校验所有声明的变量都已提供 —— 缺变量直接抛错，
 *    绝不允许把 "{{customerName}}" 原样发给模型（那会导致模型编造内容）。
 * 3. 把结构化数据序列化成模型友好的紧凑 JSON，控制 token 消耗。
 * 4. 支持运行时覆盖（超管后台可改 Prompt 而无需发版）。
 */

import type { JsonSchema, PromptKey, PromptTemplate, RenderedPrompt } from '@estatepilot/types';
import { getPromptTemplate } from './registry.js';

/** 变量缺失错误 */
export class PromptVariableMissingError extends Error {
  readonly code = 'PROMPT_VARIABLE_MISSING';

  constructor(
    readonly promptKey: PromptKey,
    readonly missing: string[],
  ) {
    super(
      `Prompt ${promptKey} 缺少必需变量: ${missing.join(', ')}。` +
        `缺失变量会导致模型看到未替换的占位符并可能编造内容，因此这里直接失败。`,
    );
    this.name = 'PromptVariableMissingError';
  }
}

/** 渲染选项 */
export interface RenderPromptOptions {
  /** 变量值。字符串直接使用，其他类型会被序列化为 JSON */
  variables: Record<string, unknown>;
  /** 运行时覆盖的模板（来自超管后台配置） */
  override?: Partial<Pick<PromptTemplate, 'system' | 'user' | 'temperature' | 'maxTokens' | 'version'>>;
}

/**
 * 把变量值转成适合放进 Prompt 的字符串。
 * - 字符串：原样（但做长度保护）
 * - 对象/数组：紧凑 JSON
 * - null/undefined：明确写「（无数据）」而不是空字符串，避免模型误解
 */
function stringifyVariable(value: unknown, maxLength = 12000): string {
  if (value === null || value === undefined) return '（无数据）';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return '（无数据）';
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…（内容已截断）` : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value, null, 0);
    if (json === undefined) return '（无数据）';
    return json.length > maxLength ? `${json.slice(0, maxLength)}…（内容已截断）` : json;
  } catch {
    return '（数据无法序列化）';
  }
}

/**
 * 替换模板中的 {{variable}} 占位符。
 * 只替换声明过的变量，未声明的占位符保留原样以便被发现（而不是静默清空）。
 */
function substitute(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name: string) => {
    if (!(name in variables)) return match;
    return stringifyVariable(variables[name]);
  });
}

/**
 * 渲染 Prompt。
 *
 * @throws PromptVariableMissingError 当必需变量缺失时
 */
export function renderPrompt(key: PromptKey, options: RenderPromptOptions): RenderedPrompt {
  const base = getPromptTemplate(key);
  const template: PromptTemplate = { ...base, ...options.override };

  // 校验必需变量
  const missing = template.variables.filter((name) => {
    const value = options.variables[name];
    return value === undefined || value === null;
  });

  if (missing.length > 0) {
    throw new PromptVariableMissingError(key, missing);
  }

  return {
    key,
    version: template.version,
    system: substitute(template.system, options.variables),
    user: substitute(template.user, options.variables),
    responseSchema: template.responseSchema,
    temperature: template.temperature,
    maxTokens: template.maxTokens,
  };
}

/** 渲染后仍残留未替换占位符的检查，用于测试与自检 */
export function findUnresolvedPlaceholders(rendered: RenderedPrompt): string[] {
  const found = new Set<string>();
  const pattern = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  for (const text of [rendered.system, rendered.user]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

/**
 * 把结构化输出 Schema 转成给模型的文字说明。
 * 部分厂商不支持原生 json_schema，此时把 Schema 附在系统提示里作为兜底。
 */
export function describeSchema(schema: JsonSchema, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];

  if (schema.type === 'object' && schema.properties) {
    lines.push(`${pad}{`);
    const required = new Set(schema.required ?? []);
    for (const [name, child] of Object.entries(schema.properties)) {
      const mark = required.has(name) ? '' : '?';
      const desc = child.description ? `  // ${child.description}` : '';
      lines.push(`${pad}  "${name}"${mark}: ${describeSchema(child, indent + 1).trim()}${desc}`);
    }
    lines.push(`${pad}}`);
    return lines.join('\n');
  }

  if (schema.type === 'array') {
    return `[${schema.items ? describeSchema(schema.items, indent).trim() : 'any'}]`;
  }

  if (schema.enum) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  }

  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : (schema.type ?? 'any');
  return type;
}

/**
 * 生成带 Schema 说明的系统提示（用于不支持原生结构化输出的厂商）。
 */
export function withSchemaInstruction(rendered: RenderedPrompt): string {
  if (!rendered.responseSchema) return rendered.system;
  return `${rendered.system}

【输出格式要求】
必须严格输出符合以下结构的 JSON，不要包含 Markdown 代码块标记，不要输出任何额外文字：

${describeSchema(rendered.responseSchema)}

字段标注 ? 的表示可选，其余为必填。`;
}
