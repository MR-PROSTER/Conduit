import { AnthropicProvider } from "./AnthropicProvider.js";
import { GroqProvider } from "./GroqProvider.js";
import { OllamaProvider } from "./OllamaProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
import type { ILLMProvider } from "./ILLMProvider.js";

export type LLMProviderName = "anthropic" | "openai" | "groq" | "ollama";

export interface ProviderConfig {
  provider: LLMProviderName;
  apiKey?: string;
  modelId?: string;
  ollamaUrl?: string;
  contextWindow?: number;
}

export class LLMRouter {
  getProvider(config: ProviderConfig): ILLMProvider {
    const modelId = config.modelId ?? this.getDefaultModelForProvider(config.provider);

    switch (config.provider) {
      case "anthropic":
        return new AnthropicProvider(config.apiKey ?? "", modelId, {
          contextWindow: config.contextWindow
        });
      case "openai":
        return new OpenAIProvider(config.apiKey ?? "", modelId, {
          contextWindow: config.contextWindow
        });
      case "groq":
        return new GroqProvider(config.apiKey ?? "", modelId);
      case "ollama":
        return new OllamaProvider(config.ollamaUrl ?? "http://127.0.0.1:11434", modelId);
      default:
        return new OpenAIProvider(config.apiKey ?? "", modelId);
    }
  }

  getDefaultModelForProvider(provider: LLMProviderName): string {
    switch (provider) {
      case "anthropic":
        return "claude-sonnet-4-5";
      case "openai":
        return "gpt-4o";
      case "groq":
        return "llama-3.3-70b-versatile";
      case "ollama":
        return "llama3.2";
    }
  }
}
