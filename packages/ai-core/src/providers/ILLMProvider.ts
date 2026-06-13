export interface ImageAttachment {
  data: string;
  mimeType: string;
  fileName?: string;
  size?: number;
}

export interface UserChatCompletionMessage {
  role: "user";
  content: string;
  name?: string;
  images?: readonly ImageAttachment[];
}

export interface AssistantChatCompletionMessage {
  role: "assistant";
  content: string;
  name?: string;
  toolCalls?: readonly AgentToolCall[];
}

export interface ToolChatCompletionMessage {
  role: "tool";
  content: string;
  toolCallId: string;
  name?: string;
}

export type ChatCompletionMessage =
  | UserChatCompletionMessage
  | AssistantChatCompletionMessage
  | ToolChatCompletionMessage;

export interface ChatCompletionResult {
  content: string;
  totalTokens: number;
  model: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentIterationResult {
  content: string;
  toolCalls: readonly AgentToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  totalTokens: number;
}

export interface LLMStreamChunk {
  content?: string;
  totalTokens?: number;
  model?: string;
  done?: boolean;
}

export interface ILLMProvider {
  readonly name: string;
  readonly modelId: string;
  readonly supportsVision: boolean;
  checkVisionSupport(): Promise<boolean>;
  streamChat(
    messages: readonly ChatCompletionMessage[],
    options?: LLMRequestOptions
  ): AsyncIterable<LLMStreamChunk>;
  runAgentIteration(
    messages: readonly ChatCompletionMessage[],
    tools?: readonly AgentToolDefinition[],
    options?: LLMRequestOptions
  ): Promise<AgentIterationResult>;
  listModels(): Promise<readonly string[]>;
  validateKey(): Promise<boolean>;
  countTokens(input: string | readonly ChatCompletionMessage[]): Promise<number>;
}

export interface LLMRequestOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}
