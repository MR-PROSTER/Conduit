import { AnthropicProvider } from './AnthropicProvider.js';
import { GroqProvider } from './GroqProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';

import type { ILLMProvider } from './ILLMProvider.js';

export type LLMProviderName = 'anthropic' | 'openai' | 'groq' | 'ollama';

export interface ProviderConfig {
  provider: LLMProviderName;
  apiKey: string;
  modelId: string;
  ollamaUrl?: string;
  /** Context window token limit — only used by OllamaProvider to set num_ctx. */
  contextWindow?: number;
}

export class LLMRouter {
  public getProvider(config: ProviderConfig): ILLMProvider {
    switch (config.provider) {
      case 'anthropic':
        return new AnthropicProvider(config.apiKey, config.modelId);
      case 'openai':
        return new OpenAIProvider(config.apiKey, config.modelId);
      case 'groq':
        return new GroqProvider(config.apiKey, config.modelId);
      case 'ollama':
        return new OllamaProvider(
          config.ollamaUrl ?? 'http://localhost:11434',
          config.modelId,
          config.contextWindow ?? 4_096
        );
    }
  }

  public getDefaultModelForProvider(provider: LLMProviderName): string {
    switch (provider) {
      case 'anthropic':
        return 'claude-sonnet-4-5';
      case 'openai':
        return 'gpt-4o';
      case 'groq':
        return 'llama-3.3-70b-versatile';
      case 'ollama':
        return 'llama3.2';
    }
  }
}
