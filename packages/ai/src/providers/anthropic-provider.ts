/**
 * Anthropic Claude Provider。
 *
 * 与 OpenAI 协议的主要差异：
 * - 认证头是 x-api-key + anthropic-version，不是 Bearer
 * - system 提示是顶层字段，不放在 messages 里
 * - 结构化输出没有 response_format，需要用「工具调用」或提示词约束 + 容错解析
 * - 流式事件类型是 content_block_delta
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
import { ProviderRequestError } from './openai-compatible-provider.js';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  timeoutMs: number;
}

const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider implements ModelProvider {
  readonly kind = AiProviderKind.ANTHROPIC;
  readonly defaultModel: string;

  constructor(private readonly config: AnthropicConfig) {
    this.defaultModel = config.defaultModel;
  }

  isConfigured(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

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
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ProviderRequestError(
          this.kind,
          response.status,
          `HTTP ${response.status}: ${text.slice(0, 500)}`,
          response.status === 429 || response.status >= 500,
        );
      }

      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(
        this.kind,
        null,
        error instanceof Error ? error.message : String(error),
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Anthropic 要求 system 单独提取，且消息只能 user/assistant 交替 */
  private splitMessages(messages: ChatMessage[]): {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    const systemParts: string[] = [];
    const converted: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const message of messages) {
      if (message.role === 'system') {
        systemParts.push(message.content);
        continue;
      }
      // tool 结果作为 user 消息回灌
      if (message.role === 'tool') {
        converted.push({ role: 'user', content: `[工具返回结果]\n${message.content}` });
        continue;
      }
      converted.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
    }

    // 合并连续同角色消息，Anthropic 要求交替
    const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of converted) {
      const last = merged[merged.length - 1];
      if (last && last.role === message.role) {
        last.content += `\n\n${message.content}`;
      } else {
        merged.push({ ...message });
      }
    }

    // 首条必须是 user
    if (merged.length === 0 || merged[0]?.role !== 'user') {
      merged.unshift({ role: 'user', content: '请按系统提示的要求执行。' });
    }

    return { system: systemParts.join('\n\n'), messages: merged };
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const { system, messages } = this.splitMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      max_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.3,
      messages,
    };
    if (system) body.system = system;

    // Anthropic 没有 response_format，用工具强制结构化输出
    if (request.responseSchema) {
      body.tools = [
        {
          name: request.responseSchemaName ?? 'structured_response',
          description: '返回结构化分析结果。必须调用此工具来输出结果。',
          input_schema: request.responseSchema,
        },
      ];
      body.tool_choice = { type: 'tool', name: request.responseSchemaName ?? 'structured_response' };
    } else if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const payload = await this.request('/v1/messages', body, request.signal);

    const contentBlocks = payload.content as
      | Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>
      | undefined;

    let text = '';
    let parsed: unknown = null;
    const toolCalls: ChatCompletionResponse['toolCalls'] = [];

    for (const block of contentBlocks ?? []) {
      if (block.type === 'text' && block.text) {
        text += block.text;
      }
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `tool_${toolCalls.length}`,
          name: block.name ?? 'unknown',
          arguments: JSON.stringify(block.input ?? {}),
        });
        // 用工具调用返回的结构化结果作为 parsed
        if (request.responseSchema && block.input) {
          parsed = block.input;
        }
      }
    }

    // 没有工具调用时，退化为文本解析
    if (parsed === null && request.responseSchema && text) {
      parsed = this.parseJsonLoose(text);
    }

    const usageRaw = payload.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const usage: TokenUsage = {
      promptTokens: usageRaw?.input_tokens ?? 0,
      completionTokens: usageRaw?.output_tokens ?? 0,
      totalTokens: (usageRaw?.input_tokens ?? 0) + (usageRaw?.output_tokens ?? 0),
    };

    return {
      content: text,
      parsed,
      toolCalls,
      model: typeof payload.model === 'string' ? payload.model : (request.model ?? this.defaultModel),
      usage,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : this.mapStopReason(payload.stop_reason),
      live: true,
    };
  }

  async *stream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const { system, messages } = this.splitMessages(request.messages);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.model ?? this.defaultModel,
          max_tokens: request.maxTokens ?? 2048,
          temperature: request.temperature ?? 0.3,
          system,
          messages,
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
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            try {
              const parsed = JSON.parse(data) as {
                type?: string;
                delta?: { type?: string; text?: string };
              };
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                yield { delta: parsed.delta.text, done: false };
              }
              if (parsed.type === 'message_stop') {
                yield { delta: '', done: true };
                return;
              }
            } catch {
              // 忽略无法解析的分片
            }
          }
        }
      }

      yield { delta: '', done: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Anthropic 不提供 embeddings 接口，由上层降级到规则匹配 */
  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse | null> {
    return null;
  }

  private parseJsonLoose(text: string): unknown | null {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(cleaned);
    } catch {
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

  private mapStopReason(reason: unknown): ChatCompletionResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }
}
