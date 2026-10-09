/**
 * Prompt 渲染器与 Schema 校验器的单元测试。
 *
 * 这两个模块是所有 AI 功能的公共基础，一旦出错会导致全线 AI 结论不可信，
 * 因此这里覆盖边界条件：缺变量、未替换占位符、非法结构、类型不匹配。
 */

import { describe, expect, it } from 'vitest';
import { PromptKey, type JsonSchema } from '@estatepilot/types';
import {
  PromptVariableMissingError,
  describeSchema,
  findUnresolvedPlaceholders,
  renderPrompt,
  withSchemaInstruction,
} from './renderer.js';
import { validate, validateAndCoerce } from '../validation/schema-validator.js';
import { PROMPT_REGISTRY, getPromptTemplate, listPromptTemplates } from './registry.js';

describe('Prompt 注册表', () => {
  it('所有 Prompt 都注册了版本号与变量声明', () => {
    const templates = listPromptTemplates();
    expect(templates.length).toBe(Object.keys(PromptKey).length);
    for (const template of templates) {
      expect(template.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(template.variables.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
    }
  });

  it('取不存在的 Prompt 会抛错而不是返回 undefined', () => {
    expect(() => getPromptTemplate('NOT_A_REAL_PROMPT' as PromptKey)).toThrow(/未注册的 Prompt/);
  });

  it('需要结构化输出的 Prompt 都定义了 responseSchema', () => {
    const structuredKeys: PromptKey[] = [
      PromptKey.CUSTOMER_PROFILE_ANALYSIS,
      PromptKey.CUSTOMER_PREFERENCE_DRIFT,
      PromptKey.PROPERTY_MATCH_EXPLANATION,
      PromptKey.SALES_FOLLOWUP,
      PromptKey.VIEWING_ANALYSIS,
      PromptKey.SALES_OPPORTUNITY,
      PromptKey.MANAGER_DIAGNOSIS,
      PromptKey.COMMUNICATION_ANALYSIS,
      PromptKey.CUSTOMER_INTENT_SCORE,
    ];
    for (const key of structuredKeys) {
      expect(PROMPT_REGISTRY[key].responseSchema, `${key} 缺少 responseSchema`).toBeDefined();
    }
  });

  it('Prompt 中包含禁止编造数据的硬性规则', () => {
    for (const template of Object.values(PROMPT_REGISTRY)) {
      const combined = `${template.system}\n${template.user}`;
      // ASSISTANT_CHAT 用的是自己的措辞，单独判断
      if (template.key === PromptKey.ASSISTANT_CHAT) {
        expect(combined).toMatch(/不能凭空|绝对不要编造/);
      } else {
        expect(combined).toMatch(/不允许编造|不能编造/);
      }
    }
  });
});

describe('Prompt 渲染', () => {
  const baseVariables = {
    customerName: '王先生',
    explicitProfile: { budgetMin: 5000000, budgetMax: 5500000 },
    behaviorStatistics: { views: 12 },
    viewedProperties: [{ id: 'prop_1', district: '浦东' }],
  };

  it('能正确替换所有占位符', () => {
    const rendered = renderPrompt(PromptKey.CUSTOMER_PROFILE_ANALYSIS, { variables: baseVariables });
    expect(rendered.key).toBe(PromptKey.CUSTOMER_PROFILE_ANALYSIS);
    expect(rendered.version).toBe('1.0.0');
    expect(rendered.user).toContain('王先生');
    expect(findUnresolvedPlaceholders(rendered)).toEqual([]);
  });

  it('缺少必需变量时抛 PromptVariableMissingError，并列出缺哪些', () => {
    let caught: PromptVariableMissingError | null = null;
    try {
      renderPrompt(PromptKey.CUSTOMER_PROFILE_ANALYSIS, {
        variables: { customerName: '王先生' },
      });
    } catch (error) {
      caught = error as PromptVariableMissingError;
    }
    expect(caught).toBeInstanceOf(PromptVariableMissingError);
    expect(caught?.missing).toContain('explicitProfile');
    expect(caught?.missing).toContain('behaviorStatistics');
  });

  it('null 与 undefined 变量视为缺失（避免模型看到空值后编造）', () => {
    expect(() =>
      renderPrompt(PromptKey.CUSTOMER_PROFILE_ANALYSIS, {
        variables: { ...baseVariables, viewedProperties: null },
      }),
    ).toThrow(PromptVariableMissingError);
  });

  it('对象变量被序列化为 JSON', () => {
    const rendered = renderPrompt(PromptKey.CUSTOMER_PROFILE_ANALYSIS, { variables: baseVariables });
    expect(rendered.user).toContain('"budgetMin":5000000');
  });

  it('超长变量会被截断并标注', () => {
    const rendered = renderPrompt(PromptKey.CUSTOMER_PROFILE_ANALYSIS, {
      variables: { ...baseVariables, behaviorStatistics: 'x'.repeat(20000) },
    });
    expect(rendered.user).toContain('内容已截断');
  });

  it('运行时覆盖可以替换 Prompt 版本与文案（供后台配置使用）', () => {
    const rendered = renderPrompt(PromptKey.CUSTOMER_PROFILE_ANALYSIS, {
      variables: baseVariables,
      override: { version: '1.2.0', temperature: 0.9, user: '自定义模板：{{customerName}}' },
    });
    expect(rendered.version).toBe('1.2.0');
    expect(rendered.temperature).toBe(0.9);
    expect(rendered.user).toBe('自定义模板：王先生');
  });

  it('Schema 说明可以被渲染成可读文本', () => {
    const rendered = renderPrompt(PromptKey.SALES_FOLLOWUP, {
      variables: {
        customerName: '李女士',
        followUpScenario: '降价提醒',
        customerProfile: {},
        triggerReason: '房源降价 30 万',
        communicationHistory: [],
        relevantProperties: [],
      },
    });
    const withSchema = withSchemaInstruction(rendered);
    expect(withSchema).toContain('wechatMessage');
    expect(withSchema).toContain('输出格式要求');
    expect(describeSchema(rendered.responseSchema as JsonSchema)).toContain('strategy');
  });
});

describe('Schema 校验器', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['name', 'score', 'level'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      score: { type: 'number', minimum: 0, maximum: 100 },
      level: { type: 'string', enum: ['HOT', 'WARM', 'COLD'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
  };

  it('合法对象通过校验', () => {
    const result = validate({ name: '王先生', score: 82, level: 'HOT', tags: ['a'] }, schema);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('缺少必填字段时报出字段路径', () => {
    const result = validate({ name: '王先生' }, schema);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('score');
    expect(result.issues.map((issue) => issue.path)).toContain('level');
  });

  it('数值越界被捕获', () => {
    const result = validate({ name: 'x', score: 150, level: 'HOT' }, schema);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/大于最大值/);
  });

  it('枚举外取值被捕获', () => {
    const result = validate({ name: 'x', score: 50, level: 'BURNING' }, schema);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/不在允许的枚举范围内/);
  });

  it('未声明字段被拒绝（additionalProperties: false）', () => {
    const result = validate({ name: 'x', score: 50, level: 'HOT', hacker: true }, schema);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('未声明'))).toBe(true);
  });

  it('数组元素逐个校验并带下标路径', () => {
    const result = validate({ name: 'x', score: 50, level: 'HOT', tags: ['ok', 123] }, schema);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('tags[1]');
  });

  it('可空字段（type 数组含 null）接受 null', () => {
    const nullable: JsonSchema = {
      type: 'object',
      required: ['value'],
      properties: { value: { type: ['integer', 'null'] } },
    };
    expect(validate({ value: null }, nullable).valid).toBe(true);
    expect(validate({ value: 123 }, nullable).valid).toBe(true);
    expect(validate({ value: 'abc' }, nullable).valid).toBe(false);
  });

  it('宽松模式能修复字符串数字与枚举大小写', () => {
    const result = validateAndCoerce({ name: 'x', score: '88', level: 'hot' }, schema);
    expect(result.valid).toBe(true);
    expect(result.coerced).toMatchObject({ score: 88, level: 'HOT' });
  });

  it('宽松模式把可选数组的 null 修复为空数组', () => {
    const result = validateAndCoerce({ name: 'x', score: 50, level: 'HOT', tags: null }, schema);
    expect(result.valid).toBe(true);
    expect((result.coerced as { tags: unknown }).tags).toEqual([]);
  });

  it('oneOf 只要有一个分支通过即算通过', () => {
    const oneOfSchema: JsonSchema = {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
    };
    expect(validate('abc', oneOfSchema).valid).toBe(true);
    expect(validate(42, oneOfSchema).valid).toBe(true);
    expect(validate(true, oneOfSchema).valid).toBe(false);
  });
});

describe('Mock Provider 产出结构合法的结果', () => {
  it('根据 Schema 特征返回客户画像分析，并用真实数据填充预算', async () => {
    const { MockModelProvider } = await import('../providers/mock-provider.js');
    const provider = new MockModelProvider();

    const rendered = renderPrompt(PromptKey.CUSTOMER_PROFILE_ANALYSIS, {
      variables: {
        customerName: '王先生',
        explicitProfile: { budgetMin: 5000000, budgetMax: 5500000 },
        behaviorStatistics: { views: 12 },
        viewedProperties: [
          { id: 'prop_aaa111', district: '浦东', totalPrice: 5600000, area: 106 },
          { id: 'prop_bbb222', district: '浦东', totalPrice: 5800000, area: 112 },
        ],
      },
    });

    const response = await provider.complete({
      messages: [
        { role: 'system', content: rendered.system },
        { role: 'user', content: rendered.user },
      ],
      responseSchema: rendered.responseSchema,
    });

    expect(response.live).toBe(false);
    expect(response.parsed).not.toBeNull();

    const parsed = response.parsed as Record<string, unknown>;
    // 预算必须来自真实输入数据，而不是硬编码
    expect(parsed.budgetMin).toBeGreaterThan(0);
    expect(parsed.budgetMax).toBeGreaterThanOrEqual(parsed.budgetMin as number);

    // 产出的结构必须能通过严格校验
    const validation = validate(response.parsed, rendered.responseSchema as JsonSchema);
    expect(validation.issues).toEqual([]);
  });

  it('带看分析能从反馈原文中抽取心理价位', async () => {
    const { MockModelProvider } = await import('../providers/mock-provider.js');
    const provider = new MockModelProvider();

    const rendered = renderPrompt(PromptKey.VIEWING_ANALYSIS, {
      variables: {
        customerName: '王总',
        viewedProperties: [
          { id: 'prop_1', title: 'A 房源' },
          { id: 'prop_2', title: 'B 房源' },
        ],
        rawFeedback: '王总最喜欢第二套，不过他老婆觉得客厅有点小。如果 535 万左右可以谈。',
      },
    });

    const response = await provider.complete({
      messages: [{ role: 'user', content: rendered.user }],
      responseSchema: rendered.responseSchema,
    });

    const parsed = response.parsed as Record<string, unknown>;
    // "535 万" 应被抽取为 5,350,000
    expect(parsed.inferredPriceAcceptance).toBe(5350000);
    expect(parsed.hasFamilyDisagreement).toBe(true);
    expect(validate(response.parsed, rendered.responseSchema as JsonSchema).valid).toBe(true);
  });

  it('无 Schema 时返回文本而不是崩溃', async () => {
    const { MockModelProvider } = await import('../providers/mock-provider.js');
    const provider = new MockModelProvider();
    const response = await provider.complete({
      messages: [{ role: 'user', content: '【客户】李女士 请分析' }],
    });
    expect(typeof response.content).toBe('string');
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.parsed).toBeNull();
  });

  it('流式输出能拼回完整内容并以 done 结束', async () => {
    const { MockModelProvider } = await import('../providers/mock-provider.js');
    const provider = new MockModelProvider();
    const chunks: string[] = [];
    let sawDone = false;
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: '你好' }] })) {
      chunks.push(chunk.delta);
      if (chunk.done) sawDone = true;
    }
    expect(sawDone).toBe(true);
    expect(chunks.join('').length).toBeGreaterThan(0);
  });

  it('Embedding 是确定性的且已归一化', async () => {
    const { MockModelProvider } = await import('../providers/mock-provider.js');
    const provider = new MockModelProvider();
    const first = await provider.embed({ input: ['浦东三房'] });
    const second = await provider.embed({ input: ['浦东三房'] });

    expect(first).not.toBeNull();
    expect(first?.embeddings[0]).toEqual(second?.embeddings[0]);
    expect(first?.embeddings[0]?.length).toBe(1536);

    const norm = Math.sqrt((first?.embeddings[0] ?? []).reduce((acc, value) => acc + value * value, 0));
    expect(norm).toBeCloseTo(1, 4);
  });
});

describe('Provider 工厂的降级行为', () => {
  it('未配置密钥时自动降级到 Mock 并给出原因', async () => {
    const { createModelProvider } = await import('../providers/factory.js');
    const { AiProviderKind } = await import('@estatepilot/types');

    const result = createModelProvider({ provider: AiProviderKind.DEEPSEEK, apiKey: '' });
    expect(result.degraded).toBe(true);
    expect(result.effectiveKind).toBe(AiProviderKind.MOCK);
    expect(result.degradedReason).toMatch(/DEEPSEEK_API_KEY/);
    expect(result.provider.isConfigured()).toBe(true);
  });

  it('配置了密钥时使用真实 Provider', async () => {
    const { createModelProvider } = await import('../providers/factory.js');
    const { AiProviderKind } = await import('@estatepilot/types');

    const result = createModelProvider({
      provider: AiProviderKind.OPENAI,
      apiKey: 'sk-test-key',
      timeoutMs: 1000,
    });
    expect(result.degraded).toBe(false);
    expect(result.effectiveKind).toBe(AiProviderKind.OPENAI);
    expect(result.provider.isConfigured()).toBe(true);
  });
});
