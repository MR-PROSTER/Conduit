/**
 * Common interface all LLM providers must implement.
 */

/**
 * An image attachment to include in a user message.
 */
export interface ImageAttachment {
  /** base64-encoded image data (no data URL prefix) */
  readonly data: string;
  /** MIME type, e.g. 'image/png' or 'application/pdf' */
  readonly mimeType: string;
  /** Original file name, if available */
  readonly fileName?: string;
  /** File size in bytes (used for metadata storage) */
  readonly size?: number;
}

/**
 * Universal message type that all providers understand.
 * Each provider maps these to its own native API format.
 *
 * - 'user'      → regular user turn
 * - 'assistant' → model response, optionally with tool calls it wants to make
 * - 'tool'      → result of a tool call (mapped to tool_result for Anthropic,
 *                 role:tool for OpenAI, plain user message for Ollama)
 */
export type ChatCompletionMessage =
  | { role: 'user'; content: string; images?: ImageAttachment[] }
  | { role: 'assistant'; content?: string; toolCalls?: AgentToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export interface ChatCompletionResult {
  content: string;
  totalTokens: number;
  model: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input_schema: Record<string, any>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentIterationResult {
  content: string | undefined;
  toolCalls: AgentToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  totalTokens: number;
}

export interface ILLMProvider {
  readonly name: string;
  readonly modelId: string;

  /**
   * Whether this provider+model supports image/vision input.
   * Static for cloud providers; dynamic for Ollama (requires a network call).
   */
  readonly supportsVision: boolean;

  /**
   * For providers where vision support depends on the loaded model (Ollama),
   * this does a live check. For others it just returns supportsVision.
   */
  checkVisionSupport(): Promise<boolean>;

  /**
   * Stream a chat response chunk by chunk.
   * onChunk is called with each text token as it arrives.
   */
  streamChat(
    messages: ChatCompletionMessage[],
    systemPrompt: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ChatCompletionResult>;

  /**
   * Run one agent iteration — may return tool calls or a final response.
   * Messages must include tool results from previous iterations using role:'tool'.
   */
  runAgentIteration(messages: ChatCompletionMessage[], systemPrompt: string, tools: AgentToolDefinition[], signal?: AbortSignal): Promise<AgentIterationResult>;

  /**
   * List available models for this provider.
   */
  listModels(): Promise<string[]>;

  /**
   * Validate the API key by calling the provider's models endpoint.
   */
  validateKey(): Promise<boolean>;

  /**
   * Count tokens in a text string (used for context budget calculation).
   */
  countTokens(text: string): number;
}