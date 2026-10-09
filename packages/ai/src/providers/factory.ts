/**
 * AI Provider 适配器工厂。
 *
 * 设计目标：绝不把任何一家厂商写死。业务层只依赖 ModelProvider 接口，
 * 通过 AI_PROVIDER 环境变量切换实现。
 *
 * 降级策略：
 * - 配置的厂商未提供密钥 → 自动降级到 MockProvider，并在结果中标记 live=false。
 * - 厂商调用失败 → 由上层决定是重试还是降级（见 ResilientProvider）。
 */

import { AiProviderKind, type ChatCompletionRequest, type EmbeddingRequest, type ModelProvider } from '@estatepilot/types';
import { MockModelProvider } from './mock-provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';

/** Provider 配置 */
export interface AiProviderConfig {
  provider: AiProviderKind;
  /** Mock 以外厂商的密钥 */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
  /** 最大重试次数 */
  maxRetries?: number;
}

/** 创建结果，包含是否发生了降级 */
export interface ProviderCreationResult {
  provider: ModelProvider;
  /** 实际使用的厂商 */
  effectiveKind: AiProviderKind;
  /** 是否因为缺少凭证而降级到 mock */
  degraded: boolean;
  /** 降级原因 */
  degradedReason?: string;
}

/**
 * 根据配置创建 Provider。
 * 缺少凭证时降级到 Mock，保证开发环境与 CI 无需任何密钥即可完整跑通。
 */
export function createModelProvider(config: AiProviderConfig): ProviderCreationResult {
  const timeoutMs = config.timeoutMs ?? 60_000;

  switch (config.provider) {
    case AiProviderKind.MOCK:
      return {
        provider: new MockModelProvider(),
        effectiveKind: AiProviderKind.MOCK,
        degraded: false,
      };

    case AiProviderKind.DEEPSEEK: {
      if (!config.apiKey) {
        return degradedToMock('DeepSeek 未配置 DEEPSEEK_API_KEY');
      }
      // DeepSeek 使用 OpenAI 兼容协议
      return {
        provider: new OpenAiCompatibleProvider({
          kind: AiProviderKind.DEEPSEEK,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
          defaultModel: config.model ?? 'deepseek-chat',
          timeoutMs,
        }),
        effectiveKind: AiProviderKind.DEEPSEEK,
        degraded: false,
      };
    }

    case AiProviderKind.OPENAI: {
      if (!config.apiKey) {
        return degradedToMock('OpenAI 未配置 OPENAI_API_KEY');
      }
      return {
        provider: new OpenAiCompatibleProvider({
          kind: AiProviderKind.OPENAI,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
          defaultModel: config.model ?? 'gpt-4o-mini',
          timeoutMs,
        }),
        effectiveKind: AiProviderKind.OPENAI,
        degraded: false,
      };
    }

    case AiProviderKind.ANTHROPIC: {
      if (!config.apiKey) {
        return degradedToMock('Anthropic 未配置 ANTHROPIC_API_KEY');
      }
      return {
        provider: new AnthropicProvider({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl ?? 'https://api.anthropic.com',
          defaultModel: config.model ?? 'claude-sonnet-4-5',
          timeoutMs,
        }),
        effectiveKind: AiProviderKind.ANTHROPIC,
        degraded: false,
      };
    }

    default:
      return degradedToMock(`未知的 AI_PROVIDER: ${String(config.provider)}`);
  }
}

function degradedToMock(reason: string): ProviderCreationResult {
  return {
    provider: new MockModelProvider(),
    effectiveKind: AiProviderKind.MOCK,
    degraded: true,
    degradedReason: reason,
  };
}

export { MockModelProvider, OpenAiCompatibleProvider, AnthropicProvider };
export type { ChatCompletionRequest, EmbeddingRequest, ModelProvider };
