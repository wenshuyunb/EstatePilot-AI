/**
 * @estatepilot/ai
 *
 * EstatePilot AI 的 AI 能力层：模型 Provider 适配器、Prompt 注册表、结构化输出校验。
 *
 * 使用方式：
 *
 *   const { provider, degraded, degradedReason } = createModelProvider({
 *     provider: AiProviderKind.DEEPSEEK,
 *     apiKey: process.env.DEEPSEEK_API_KEY,
 *   });
 *
 *   const prompt = renderPrompt(PromptKey.SALES_FOLLOWUP, {
 *     variables: { customerName, followUpScenario, customerProfile, ... },
 *   });
 *
 *   const response = await provider.complete({
 *     messages: [
 *       { role: 'system', content: prompt.system },
 *       { role: 'user', content: prompt.user },
 *     ],
 *     responseSchema: prompt.responseSchema,
 *     temperature: prompt.temperature,
 *   });
 */

export * from './providers/factory.js';
export * from './providers/mock-provider.js';
export * from './providers/openai-compatible-provider.js';
export * from './providers/anthropic-provider.js';
export * from './prompts/registry.js';
export * from './prompts/renderer.js';
export * from './validation/schema-validator.js';
