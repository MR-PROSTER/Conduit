import Groq from "groq-sdk";
import type {
  AgentIterationResult,
  AgentToolDefinition,
  ChatCompletionMessage,
  ILLMProvider,
  LLMRequestOptions,
  LLMStreamChunk,
} from "./ILLMProvider.js";

export class GroqProvider implements ILLMProvider {
  readonly name = "groq";
  readonly modelId: string;
  readonly supportsVision: boolean;

  private readonly client: Groq;

  constructor(apiKey: string, modelId = "llama-3.3-70b-versatile") {
    this.client = new Groq({ apiKey });
    this.modelId = modelId;
    this.supportsVision = false;
  }

  async checkVisionSupport(): Promise<boolean> {
    return this.supportsVision;
  }

  async *streamChat(
    messages: readonly ChatCompletionMessage[],
    options: LLMRequestOptions = {},
  ): AsyncIterable<LLMStreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.modelId,
      messages: this.toMessages(messages, options.systemPrompt),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
    } as any);

    let content = "";
    let totalTokens = 0;
    for await (const chunk of stream as any) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
        yield { content: delta, model: this.modelId };
      }
      totalTokens = Number(chunk.usage?.total_tokens ?? totalTokens);
    }
    yield { content, totalTokens, model: this.modelId, done: true };
  }

  async runAgentIteration(
    messages: readonly ChatCompletionMessage[],
    tools: readonly AgentToolDefinition[] = [],
    options: LLMRequestOptions = {},
  ): Promise<AgentIterationResult> {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: this.toMessages(messages, options.systemPrompt),
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })) as any,
      tool_choice: tools.length > 0 ? "auto" : undefined,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
    } as any);

    const choice = response.choices?.[0];
    const message = choice?.message as any;
    return {
      content: String(message?.content ?? ""),
      toolCalls: this.extractToolCalls(message?.tool_calls),
      stopReason: this.mapStopReason(choice?.finish_reason),
      totalTokens: Number(response.usage?.total_tokens ?? 0),
    };
  }

  async listModels(): Promise<readonly string[]> {
    return [this.modelId, "llama-3.1-8b-instant", "llama-3.3-70b-versatile"];
  }

  async validateKey(): Promise<boolean> {
    try {
      await (this.client as any).models.list();
      return true;
    } catch {
      return false;
    }
  }

  async countTokens(input: string | readonly ChatCompletionMessage[]): Promise<number> {
    const text = typeof input === "string" ? input : this.stringifyMessages(input);
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private toMessages(messages: readonly ChatCompletionMessage[], systemPrompt?: string): any[] {
    const mapped: any[] = [];
    if (systemPrompt) {
      mapped.push({ role: "system", content: systemPrompt });
    }
    for (const message of messages) {
      if (message.role === "tool") {
        mapped.push({ role: "tool", content: message.content, tool_call_id: message.toolCallId });
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

  private mapStopReason(finishReason: string | undefined): AgentIterationResult["stopReason"] {
    if (finishReason === "tool_calls") {
      return "tool_use";
    }
    if (finishReason === "length") {
      return "max_tokens";
    }
    return "end_turn";
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
