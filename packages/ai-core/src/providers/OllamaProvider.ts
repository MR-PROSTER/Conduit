import type {
  AgentIterationResult,
  AgentToolDefinition,
  ChatCompletionMessage,
  ILLMProvider,
  LLMRequestOptions,
  LLMStreamChunk,
} from "./ILLMProvider.js";

export class OllamaProvider implements ILLMProvider {
  readonly name = "ollama";
  readonly modelId: string;
  readonly supportsVision: boolean;

  constructor(
    private readonly baseUrl: string,
    modelId = "llama3.2",
  ) {
    this.modelId = modelId;
    this.supportsVision = false;
  }

  async checkVisionSupport(): Promise<boolean> {
    return this.detectVisionSupport();
  }

  async *streamChat(
    messages: readonly ChatCompletionMessage[],
    options: LLMRequestOptions = {},
  ): AsyncIterable<LLMStreamChunk> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: this.toMessages(messages, options.systemPrompt),
        stream: true,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
        },
      }),
      signal: options.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line);
        const delta = event?.message?.content ?? "";
        if (typeof delta === "string" && delta.length > 0) {
          content += delta;
          yield { content: delta, model: this.modelId };
        }
        if (event?.done) {
          yield {
            content,
            totalTokens: Number(event?.eval_count ?? 0),
            model: this.modelId,
            done: true,
          };
        }
      }
    }
  }

  async runAgentIteration(
    messages: readonly ChatCompletionMessage[],
    tools: readonly AgentToolDefinition[] = [],
    options: LLMRequestOptions = {},
  ): Promise<AgentIterationResult> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: this.toMessages(messages, options.systemPrompt),
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          },
        })),
        stream: false,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const toolCalls = this.extractToolCalls(payload?.message?.tool_calls);
    return {
      content: String(payload?.message?.content ?? ""),
      toolCalls,
      stopReason:
        toolCalls.length > 0
          ? "tool_use"
          : payload?.done_reason === "length"
            ? "max_tokens"
            : "end_turn",
      totalTokens: Number(payload?.eval_count ?? 0),
    };
  }

  async listModels(): Promise<readonly string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      return [this.modelId];
    }
    const payload = await response.json();
    return Array.isArray(payload?.models)
      ? payload.models.map((model: any) => String(model?.name ?? "")).filter(Boolean)
      : [this.modelId];
  }

  async validateKey(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async countTokens(input: string | readonly ChatCompletionMessage[]): Promise<number> {
    const text = typeof input === "string" ? input : this.stringifyMessages(input);
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private async detectVisionSupport(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: this.modelId }),
      });
      if (!response.ok) {
        return false;
      }
      const payload = await response.json();
      const modalities = payload?.modality ?? payload?.modalities;
      return (
        Array.isArray(modalities) &&
        modalities.some((value: unknown) => String(value).toLowerCase() === "vision")
      );
    } catch {
      return false;
    }
  }

  private toMessages(messages: readonly ChatCompletionMessage[], systemPrompt?: string): any[] {
    const mapped: any[] = [];
    if (systemPrompt) {
      mapped.push({ role: "system", content: systemPrompt });
    }
    for (const message of messages) {
      if (message.role === "tool") {
        mapped.push({
          role: "tool",
          content: message.content,
          tool_call_id: message.toolCallId,
        });
        continue;
      }
      mapped.push({ role: message.role, content: message.content });
    }
    return mapped;
  }

  private extractToolCalls(
    toolCalls: any,
  ): readonly { id: string; name: string; input: unknown }[] {
    if (!Array.isArray(toolCalls)) {
      return [];
    }
    return toolCalls.map((toolCall) => ({
      id: String(toolCall.id ?? ""),
      name: String(toolCall.function?.name ?? ""),
      input: this.safeJsonParse(toolCall.function?.arguments),
    }));
  }

  private safeJsonParse(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private stringifyMessages(messages: readonly ChatCompletionMessage[]): string {
    return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
  }
}
