import * as vscode from 'vscode';

import type { LLMProviderName } from '@conduit/ai-core';

const KEY_PREFIX = 'conduit.ai.apiKey.';
const MODEL_PREFIX = 'conduit.ai.model.';
const OLLAMA_URL_KEY = 'conduit.ai.ollamaUrl';
const ACTIVE_PROVIDER_KEY = 'conduit.ai.activeProvider';

/**
 * Manages LLM provider API keys in VS Code SecretStorage.
 * Keys are encrypted by the OS keychain and never sent to the Conduit backend.
 */
export class ApiKeyStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async getKey(provider: LLMProviderName): Promise<string | undefined> {
    return this.context.secrets.get(`${KEY_PREFIX}${provider}`);
  }

  public async setKey(provider: LLMProviderName, key: string): Promise<void> {
    await this.context.secrets.store(`${KEY_PREFIX}${provider}`, key);
  }

  public async deleteKey(provider: LLMProviderName): Promise<void> {
    await this.context.secrets.delete(`${KEY_PREFIX}${provider}`);
  }

  public async hasKey(provider: LLMProviderName): Promise<boolean> {
    if (provider === 'ollama') return true; // No key needed
    const key = await this.getKey(provider);
    return key !== undefined && key.trim().length > 0;
  }

  public async getSarvamKey(): Promise<string | undefined> {
    return this.context.secrets.get(`${KEY_PREFIX}sarvam`);
  }

  public async setSarvamKey(key: string): Promise<void> {
    await this.context.secrets.store(`${KEY_PREFIX}sarvam`, key);
  }

  public async deleteSarvamKey(): Promise<void> {
    await this.context.secrets.delete(`${KEY_PREFIX}sarvam`);
  }

  public async hasSarvamKey(): Promise<boolean> {
    const key = await this.getSarvamKey();
    return key !== undefined && key.trim().length > 0;
  }

  public getOllamaUrl(): string {
    return (
      this.context.globalState.get<string>(OLLAMA_URL_KEY) ??
      'http://localhost:11434'
    );
  }

  public async setOllamaUrl(url: string): Promise<void> {
    await this.context.globalState.update(OLLAMA_URL_KEY, url);
  }

  public getActiveProvider(): LLMProviderName {
    return (
      this.context.globalState.get<LLMProviderName>(ACTIVE_PROVIDER_KEY) ??
      'anthropic'
    );
  }

  public async setActiveProvider(provider: LLMProviderName): Promise<void> {
    await this.context.globalState.update(ACTIVE_PROVIDER_KEY, provider);
  }

  public getModel(provider: LLMProviderName): string | undefined {
    return this.context.globalState.get<string>(`${MODEL_PREFIX}${provider}`);
  }

  public async setModel(
    provider: LLMProviderName,
    model: string
  ): Promise<void> {
    await this.context.globalState.update(`${MODEL_PREFIX}${provider}`, model);
  }

  /**
   * Validate an API key by calling the provider's models endpoint.
   * Uses a minimal HTTP fetch with just the key — no SDK instantiated.
   */
  public async validateKey(
    provider: LLMProviderName,
    key: string
  ): Promise<boolean> {
    try {
      switch (provider) {
        case 'anthropic': {
          const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
            },
          });
          return res.ok;
        }
        case 'openai': {
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
          });
          return res.ok;
        }
        case 'groq': {
          const res = await fetch(
            'https://api.groq.com/openai/v1/models',
            { headers: { Authorization: `Bearer ${key}` } }
          );
          return res.ok;
        }
        case 'ollama':
          return true; // No key validation needed
      }
    } catch (err) {
      if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
        return true;  // offline — assume key is valid, can't check
      }
      return false;
    }
  }
}
