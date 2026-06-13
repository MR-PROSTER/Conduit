import type { Draft, Session } from '@conduit/shared-types';

export interface PromptContext {
  readonly session: Session;
  readonly draft?: Draft;
  readonly prompt: string;
}

export const normalizePrompt = (context: PromptContext): string => {
  return context.prompt.trim();
};

export type { ILLMProvider, ChatCompletionMessage, ChatCompletionResult, AgentToolDefinition, AgentIterationResult, AgentToolCall, ImageAttachment } from './providers/ILLMProvider.js';
export { AnthropicProvider } from './providers/AnthropicProvider.js';
export { OpenAIProvider } from './providers/OpenAIProvider.js';
export { GroqProvider } from './providers/GroqProvider.js';
export { OllamaProvider } from './providers/OllamaProvider.js';
export { LLMRouter } from './providers/LLMRouter.js';
export type { LLMProviderName, ProviderConfig } from './providers/LLMRouter.js';