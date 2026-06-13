import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentIterationResult,
  AgentToolDefinition,
  ChatCompletionMessage,
  ChatCompletionResult,
  ILLMProvider,
  ImageAttachment,
  LLMRequestOptions,
  LLMStreamChunk,
} from "./ILLMProvider.js";
import { getMimeTypeFromFileName, hasVisionMimeType } from "./fileTypeUtils.js";

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export class AnthropicProvider implements ILLMProvider {
  readonly name = "anthropic";
  readonly modelId: string;
  readonly supportsVision: boolean;

  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    modelId = "claude-sonnet-4-5",
    private readonly opts: { contextWindow?: number } = {},
  ) {
    this.modelId = modelId;
    this.client = new Anthropic({ apiKey });
    this.supportsVision = true;
  }

  async checkVisionSupport(): Promise<boolean> {
    return this.supportsVision;
  }

  async *streamChat(
    messages: readonly ChatCompletionMessage[],
    options: LLMRequestOptions = {},
  ): AsyncIterable<LLMStreamChunk> {
    const response = await (this.client.messages as any).stream(
      this.buildMessagePayload(messages, options),
    );

    let content = "";
    let totalTokens = 0;
    for await (const event of response) {
      if (event.type === "content_block_delta" && event.delta?.text) {
        content += event.delta.text;
        yield { content: event.delta.text, model: this.modelId };
      }
      if (event.type === "message_delta" && typeof event.usage?.output_tokens === "number") {
        totalTokens = event.usage.output_tokens;
      }
    }
    yield { content, totalTokens, model: this.modelId, done: true };
  }

  async runAgentIteration(
    messages: readonly ChatCompletionMessage[],
    tools: readonly AgentToolDefinition[] = [],
    options: LLMRequestOptions = {},
  ): Promise<AgentIterationResult> {
    const response = await (this.client.messages as any).create({
      ...this.buildMessagePayload(messages, options),
      tools: tools.map((tool) => this.toAnthropicTool(tool)) as AnthropicTool[],
      stream: false,
    });

    const content = this.extractText(response.content);
    const toolCalls = this.extractToolCalls(response.content);
    return {
      content,
      toolCalls,
      stopReason: this.mapStopReason((response as any).stop_reason),
      totalTokens:
        Number((response as any).usage?.input_tokens ?? 0) +
        Number((response as any).usage?.output_tokens ?? 0),
    };
  }

  async listModels(): Promise<readonly string[]> {
    return [this.modelId, "claude-haiku-4", "claude-opus-4"];
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
    const count = await (this.client.messages as any).countTokens({
      model: this.modelId,
      messages: [{ role: "user", content: text }],
    } as any);
    return Number((count as any).input_tokens ?? (count as any).output_tokens ?? 0);
  }

  private buildMessagePayload(
    messages: readonly ChatCompletionMessage[],
    options: LLMRequestOptions,
  ) {
    return {
      model: this.modelId,
      max_tokens: options.maxTokens ?? 4096,
      system: options.systemPrompt,
      messages: messages.map((message) => this.toAnthropicMessage(message)),
      temperature: options.temperature,
      signal: options.signal,
    };
  }

  private toAnthropicMessage(message: ChatCompletionMessage): any {
    if (message.role === "tool") {
      return {
        role: "user",
        content: [{ type: "text", text: message.content }],
      };
    }

    const content: Array<any> = [{ type: "text", text: message.content }];
    if (message.role === "user" && message.images?.length) {
      for (const image of message.images) {
        content.push(this.toImageBlock(image));
      }
    }

    return {
      role: message.role,
      content,
    };
  }

  private toImageBlock(image: ImageAttachment): any {
    const mimeType = image.mimeType || getMimeTypeFromFileName(image.fileName ?? "");
    if (!hasVisionMimeType(mimeType)) {
      return { type: "text", text: `[Unsupported image mime type: ${mimeType}]` };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: image.data,
      },
    };
  }

  private toAnthropicTool(tool: AgentToolDefinition): AnthropicTool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    };
  }

  private extractText(content: any): string {
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
  }

  private extractToolCalls(content: any): readonly { id: string; name: string; input: unknown }[] {
    if (!Array.isArray(content)) {
      return [];
    }
    return content
      .filter((item) => item?.type === "tool_use")
      .map((item) => ({
        id: String(item.id ?? ""),
        name: String(item.name ?? ""),
        input: item.input,
      }));
  }

  private mapStopReason(stopReason: string | undefined): AgentIterationResult["stopReason"] {
    if (stopReason === "tool_use") {
      return "tool_use";
    }
    if (stopReason === "max_tokens") {
      return "max_tokens";
    }
    return "end_turn";
  }

  private stringifyMessages(messages: readonly ChatCompletionMessage[]): string {
    return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
  }
}
