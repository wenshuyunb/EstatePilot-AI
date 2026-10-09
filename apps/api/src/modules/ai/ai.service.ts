/**
 * AI 服务包装层。
 *
 * 职责：把 @estatepilot/ai 包的能力接进 NestJS，并统一处理：
 *   1. Prompt 渲染（变量校验在渲染器里完成，缺变量直接报错）
 *   2. 模型调用与结构化输出校验
 *   3. **AI 不可用时的优雅降级** —— 这是本层最重要的设计
 *   4. Mock 领域钩子注册（见下）
 *
 * 关于 Mock 钩子：
 *   本项目 AI_PROVIDER 默认为 mock（无需任何密钥即可开发）。
 *   Mock 默认会按 Schema 生成空洞的占位值，对业务毫无价值。
 *   因此这里给 Mock 注册**真实规则实现**：
 *     微信需求抽取 → 中文房产表达规则解析器
 *     微信文案生成 → 规则模板生成器
 *   这样在没有任何 AI 密钥的环境里，「粘贴 → 识别 → 搜索 → 生成」依然是
 *   一条能产出真实可用结果的链路，而不是演示用的假流程。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createModelProvider,
  renderPrompt,
  validateAndCoerce,
  MockModelProvider,
  type ModelProvider,
} from '@estatepilot/ai';
import {
  AiProviderKind,
  PromptKey,
  type ChatCompletionResponse,
  type JsonSchema,
  type PromptTemplate,
} from '@estatepilot/types';
import { APP_CONFIG, type AppConfig } from '../../config/configuration.js';

/** 一次 AI 调用的结果 */
export interface AiCallResult<T> {
  /** 校验后的结构化结果（无 Schema 时为 null） */
  data: T | null;
  /** 文本内容（生成文案时使用） */
  text: string;
  /** 实际使用的模型 */
  model: string;
  /** 是否为真实厂商输出（false = mock 或降级） */
  live: boolean;
  /** 使用的 Prompt 版本 */
  promptVersion: string;
  /** 耗时 */
  durationMs: number;
  /** 是否走了降级路径 */
  degraded: boolean;
  /** 降级原因 */
  degradedReason: string | null;
  /** token 用量 */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** AI 调用失败（凭证/网络/校验错误） */
export class AiCallError extends Error {
  /** 注意：不用 `code` 命名 —— Error 基类上已有同名字段，会产生类型冲突 */
  readonly errorCode = 'AI_CALL_FAILED';

  constructor(
    message: string,
    readonly promptKey: PromptKey,
    // Error 基类已声明 cause，必须显式 override
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AiCallError';
  }
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly provider: ModelProvider;
  private readonly effectiveKind: AiProviderKind;
  private readonly degraded: boolean;
  private readonly degradedReason: string | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    // 从配置创建 Provider。缺凭证时工厂会自动降级到 mock。
    // apiKey / baseUrl / model 已在 buildAppConfig 里按厂商解析好，这里直接用。
    const result = createModelProvider({
      provider: this.config.ai.provider,
      apiKey: this.config.ai.apiKey,
      baseUrl: this.config.ai.baseUrl,
      model: this.config.ai.model,
      timeoutMs: this.config.ai.timeoutMs,
    });

    this.provider = result.provider;
    this.effectiveKind = result.effectiveKind;
    this.degraded = result.degraded;
    this.degradedReason = result.degradedReason ?? null;

    if (this.degraded) {
      this.logger.warn(
        `AI 未配置凭证，已降级到 Mock（原因：${this.degradedReason}）。` +
          `业务仍可运行，但语言理解能力来自内置规则而非模型。`,
      );
    } else {
      this.logger.log(
        `AI Provider 就绪：${this.effectiveKind}（模型 ${this.provider.defaultModel}）`,
      );
    }
  }

  /** 当前是否使用真实模型 */
  isLive(): boolean {
    return this.effectiveKind !== AiProviderKind.MOCK;
  }

  /** 是否降级到 Mock */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** 当前 Provider 类型 */
  getProviderKind(): AiProviderKind {
    return this.effectiveKind;
  }

  /** 状态描述，供后台展示 */
  describeStatus(): {
    provider: string;
    model: string;
    live: boolean;
    degraded: boolean;
    degradedReason: string | null;
    hooks: { structured: string[]; text: string[] };
  } {
    return {
      provider: this.effectiveKind,
      model: this.provider.defaultModel,
      live: this.isLive(),
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      hooks:
        this.provider instanceof MockModelProvider
          ? this.provider.describeHooks()
          : { structured: [], text: [] },
    };
  }

  /**
   * 给 Mock Provider 注册结构化输出钩子。
   * 只在当前生效的是 Mock 时有意义（真实厂商不会走钩子）。
   */
  registerMockStructuredHook(
    key: PromptKey,
    handler: (promptText: string) => Record<string, unknown> | null,
  ): void {
    if (this.provider instanceof MockModelProvider) {
      this.provider.registerStructuredHook(key, handler);
      this.logger.debug(`已注册 Mock 结构化钩子：${key}`);
    }
  }

  /** 给 Mock Provider 注册文本输出钩子 */
  registerMockTextHook(key: PromptKey, handler: (promptText: string) => string | null): void {
    if (this.provider instanceof MockModelProvider) {
      this.provider.registerTextHook(key, handler);
      this.logger.debug(`已注册 Mock 文本钩子：${key}`);
    }
  }

  /**
   * 执行一次 Prompt。
   *
   * @param template Prompt 模板
   * @param variables 模板变量
   * @param options.schema 覆盖模板里的 responseSchema
   * @param options.validator 额外的业务校验（如需求必须含城市）
   */
  async run<T>(
    template: PromptTemplate,
    variables: Record<string, unknown>,
    options: {
      schema?: JsonSchema;
      /** 业务级校验：返回错误信息字符串表示校验失败 */
      validate?: (data: unknown) => string | null;
      temperature?: number;
      maxTokens?: number;
    } = {},
  ): Promise<AiCallResult<T>> {
    const startedAt = Date.now();

    // ---- 1. 渲染 Prompt（缺变量会在这里抛错）----
    const rendered = renderPrompt(template.key, { variables });

    const schema = options.schema ?? rendered.responseSchema;

    // ---- 2. 调用模型 ----
    let response: ChatCompletionResponse;
    try {
      response = await this.provider.complete({
        messages: [
          { role: 'system', content: rendered.system },
          { role: 'user', content: rendered.user },
        ],
        responseSchema: schema,
        // 把 PromptKey 作为 Schema 名称传下去，Mock 据此选择领域钩子
        responseSchemaName: schema ? template.key : undefined,
        temperature: options.temperature ?? rendered.temperature,
        maxTokens: options.maxTokens ?? rendered.maxTokens,
      });
    } catch (error) {
      throw new AiCallError(
        `调用 AI 失败（${template.key}）：${error instanceof Error ? error.message : String(error)}`,
        template.key,
        error,
      );
    }

    // ---- 3. 结构化输出校验 ----
    let data: T | null = null;
    let degraded = this.degraded;
    let degradedReason = this.degradedReason;

    if (schema) {
      const raw = response.parsed ?? this.tryParseJson(response.content);

      if (raw === null || raw === undefined) {
        throw new AiCallError(
          `AI 返回内容无法解析为 JSON（${template.key}）。` +
            `原始内容开头：${response.content.slice(0, 200)}`,
          template.key,
        );
      }

      const validated = validateAndCoerce(raw, schema);

      if (!validated.valid) {
        throw new AiCallError(
          `AI 输出不符合 Schema（${template.key}）：${validated.issues
            .slice(0, 5)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join('; ')}`,
          template.key,
        );
      }

      // ---- 4. 业务级校验 ----
      if (options.validate) {
        const problem = options.validate(validated.coerced);
        if (problem) {
          throw new AiCallError(
            `AI 输出未通过业务校验（${template.key}）：${problem}`,
            template.key,
          );
        }
      }

      data = validated.coerced as T;
    }

    return {
      data,
      text: response.content,
      model: response.model,
      live: response.live,
      promptVersion: rendered.version,
      durationMs: Date.now() - startedAt,
      degraded,
      degradedReason,
      usage: response.usage,
    };
  }

  /** 容错 JSON 解析（模型有时会包一层 ```json 代码块） */
  private tryParseJson(text: string): unknown {
    if (!text) return null;

    const trimmed = text.trim();

    // 去掉 Markdown 代码块包裹
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
    const candidate = fenceMatch?.[1]?.trim() ?? trimmed;

    try {
      return JSON.parse(candidate);
    } catch {
      // 尝试截取第一个完整的 JSON 对象
      const start = candidate.indexOf('{');
      if (start < 0) return null;

      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let i = start; i < candidate.length; i += 1) {
        const char = candidate[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;

        if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(candidate.slice(start, i + 1));
            } catch {
              return null;
            }
          }
        }
      }

      return null;
    }
  }
}
