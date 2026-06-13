import * as vscode from "vscode";

export type AIProviderName = "anthropic" | "openai" | "groq" | "ollama";

const KEY_PREFIX = "conduit.ai.apiKey.";
const MODEL_PREFIX = "conduit.ai.model.";
const ACTIVE_PROVIDER_KEY = "conduit.ai.activeProvider";
const OLLAMA_URL_KEY = "conduit.ai.ollamaUrl";

export class ApiKeyStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getKey(provider: AIProviderName): Promise<string | undefined> {
    return this.context.secrets.get(`${KEY_PREFIX}${provider}`);
  }

  async setKey(provider: AIProviderName, key: string): Promise<void> {
    await this.context.secrets.store(`${KEY_PREFIX}${provider}`, key);
  }

  async deleteKey(provider: AIProviderName): Promise<void> {
    await this.context.secrets.delete(`${KEY_PREFIX}${provider}`);
  }

  async getOllamaUrl(): Promise<string> {
    return this.context.globalState.get<string>(OLLAMA_URL_KEY) ?? "http://localhost:11434";
  }

  async setOllamaUrl(url: string): Promise<void> {
    await this.context.globalState.update(OLLAMA_URL_KEY, url.trim() || "http://localhost:11434");
  }

  async getActiveProvider(): Promise<AIProviderName> {
    return this.context.globalState.get<AIProviderName>(ACTIVE_PROVIDER_KEY) ?? "anthropic";
  }

  async setActiveProvider(provider: AIProviderName): Promise<void> {
    await this.context.globalState.update(ACTIVE_PROVIDER_KEY, provider);
  }

  async getModel(provider: AIProviderName): Promise<string | undefined> {
    return this.context.globalState.get<string>(`${MODEL_PREFIX}${provider}`);
  }

  async setModel(provider: AIProviderName, model: string): Promise<void> {
    await this.context.globalState.update(`${MODEL_PREFIX}${provider}`, model.trim() || undefined);
  }
}
