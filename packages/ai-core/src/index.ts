import type { Draft, Session } from "../../shared-types/src/index.js";
export type {
  AgentIterationResult,
  AgentToolCall,
  AgentToolDefinition,
  ChatCompletionMessage,
  ChatCompletionResult,
  ILLMProvider,
  ImageAttachment,
  LLMRequestOptions,
  LLMStreamChunk
} from "./providers/ILLMProvider.js";
export { AnthropicProvider } from "./providers/AnthropicProvider.js";
export { GroqProvider } from "./providers/GroqProvider.js";
export { LLMRouter } from "./providers/LLMRouter.js";
export type { LLMProviderName, ProviderConfig } from "./providers/LLMRouter.js";
export { OllamaProvider } from "./providers/OllamaProvider.js";
export { OpenAIProvider } from "./providers/OpenAIProvider.js";

export interface PromptContext {
  session: Session;
  draft?: Draft;
  prompt: string;
}

export function normalizePrompt(context: PromptContext): string {
  const parts = [
    `Session: ${context.session.id}`,
    `Room: ${context.session.roomId}`,
    `Branch: ${context.session.branch}`,
    `Base commit: ${context.session.baseCommitHash}`,
    `Prompt: ${context.prompt}`
  ];

  if (context.draft) {
    parts.splice(4, 0, `Draft: ${context.draft.id}`, `Draft status: ${context.draft.status}`);
  }

  return parts.join("\n");
}
