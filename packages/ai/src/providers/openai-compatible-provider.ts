/**
 * OpenAI 兼容协议的 Provider。
 *
 * 适用于：OpenAI、DeepSeek（官方宣称 OpenAI 兼容）、以及任何兼容 /chat/completions
 * 的第三方服务。这样新增一家兼容厂商无需写新代码，只需配置 baseUrl 与 model。
 */

import {
  AiProviderKind,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type JsonSchema,
  type ModelProvider,
  type TokenUsage,
} from '@estatepilot/types';

export interface OpenAiCompatibleConfig {
  kind: AiProviderKind.OPENAI | AiProviderKind.DEEPSEEK;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  timeoutMs: number;
}

/** 厂商返回的错误，便于上层区分「该重试」与「该降级」 */
export class ProviderRequestError extends Error {
  readonly code = 'AI_PROVIDER_REQUEST_FAILED';

  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderRequestError';
  }
}

/** 把内部消息格式转成 OpenAI 格式 */
function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const base: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.role === 'tool' && message.toolCallId) base.tool_call_id = message.toolCallId;
    if (message.name) base.name = message.name;
    return base;
  });
}

/** 把内部工具定义转成 OpenAI function 格式 */
function toOpenAiTools(tools: ChatCompletionRequest['tools']): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly kind: AiProviderKind;
  readonly defaultModel: string;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.kind = config.kind;
    this.defaultModel = config.defaultModel;
  }

  isConfigured(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  /** 发起请求，带超时与一次网络级重试 */
  private async request(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // 429 与 5xx 可重试；4xx 通常是请求本身有问题，重试无意义
        const retryable = response.status === 429 || response.status >= 500;
        throw new ProviderRequestError(
          this.kind,
          response.status,
          `HTTP ${response.status}: ${text.slice(0, 500)}`,
          retryable,
        );
      }

      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // 网络错误与超时可重试
      throw new ProviderRequestError(this.kind, null, message, true);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages: toOpenAiMessages(request.messages),
      temperature: request.temperature ?? 0.3,
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;

    const tools = toOpenAiTools(request.tools);
    if (tools) body.tools = tools;

    // 结构化输出：优先使用厂商原生 json_schema
    if (request.responseSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseSchemaName ?? 'response',
          strict: false,
          schema: request.responseSchema,
        },
      };
    }

    const payload = await this.request('/chat/completions', body, request.signal);

    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const first = choices?.[0];
    const message = first?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === 'string' ? message.content : '';

    const rawToolCalls = message?.tool_calls as
      | Array<{ id: string; function: { name: string; arguments: string } }>
      | undefined;

    const usageRaw = payload.usage as Record<string, number> | undefined;
    const usage: TokenUsage = {
      promptTokens: usageRaw?.prompt_tokens ?? 0,
      completionTokens: usageRaw?.completion_tokens ?? 0,
      totalTokens: usageRaw?.total_tokens ?? 0,
    };

    return {
      content,
      parsed: this.parseStructured(content, request.responseSchema),
      toolCalls: (rawToolCalls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      model: typeof payload.model === 'string' ? payload.model : (request.model ?? this.defaultModel),
      usage,
      finishReason: this.mapFinishReason(first?.finish_reason),
      live: true,
    };
  }

  async *stream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? this.defaultModel,
          messages: toOpenAiMessages(request.messages),
          temperature: request.temperature ?? 0.3,
          max_tokens: request.maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new ProviderRequestError(
          this.kind,
          response.status,
          `流式请求失败 HTTP ${response.status}: ${text.slice(0, 300)}`,
          response.status === 429 || response.status >= 500,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              yield { delta: '', done: true };
              return;
            }
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) yield { delta, done: false };
            } catch {
              // 忽略无法解析的分片，流式场景下不应因此中断
            }
          }
        }
      }

      yield { delta: '', done: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse | null> {
    // DeepSeek 目前不提供 embeddings 接口
    if (this.kind === AiProviderKind.DEEPSEEK) return null;

    const payload = await this.request('/embeddings', {
      model: request.model ?? 'text-embedding-3-small',
      input: request.input,
    });

    const data = payload.data as Array<{ embedding: number[] }> | undefined;
    const usageRaw = payload.usage as Record<string, number> | undefined;

    return {
      embeddings: (data ?? []).map((item) => item.embedding),
      model: typeof payload.model === 'string' ? payload.model : 'text-embedding-3-small',
      usage: {
        promptTokens: usageRaw?.prompt_tokens ?? 0,
        completionTokens: 0,
        totalTokens: usageRaw?.total_tokens ?? 0,
      },
      live: true,
    };
  }

  /**
   * 解析结构化输出。
   * 即使配置了 response_format，部分厂商仍会返回带 Markdown 代码块的文本，
   * 因此这里做一次容错剥离。
   */
  private parseStructured(content: string, schema?: JsonSchema): unknown | null {
    if (!schema) return null;
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      return JSON.parse(cleaned);
    } catch {
      // 尝试提取第一个完整 JSON 对象
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private mapFinishReason(reason: unknown): ChatCompletionResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'tool_calls':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}
