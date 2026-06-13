import { OpenAIProvider } from './OpenAIProvider.js';

import type {
    AgentIterationResult,
    AgentToolDefinition,
    ChatCompletionMessage,
    ChatCompletionResult,
} from './ILLMProvider.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqProvider extends OpenAIProvider {
    public override readonly name = 'groq';
    // Groq text models don't support vision
    public override readonly supportsVision = false;

    public constructor(
        apiKey: string,
        public override readonly modelId: string = 'llama-3.3-70b-versatile'
    ) {
        super(apiKey, modelId, GROQ_BASE_URL);
    }

    public override async checkVisionSupport(): Promise<boolean> {
        return false;
    }

    public override async listModels(): Promise<string[]> {
        try {
            const models = await this.client.models.list();
            return models.data.map((m: any) => m.id).sort();
        } catch {
            return ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'];
        }
    }

    public override async runAgentIteration(
        messages: ChatCompletionMessage[],
        systemPrompt: string,
        tools: AgentToolDefinition[],
        signal?: AbortSignal
    ): Promise<AgentIterationResult> {
        return super.runAgentIteration(messages, systemPrompt, tools, signal);
    }

    public override async streamChat(
        messages: ChatCompletionMessage[],
        systemPrompt: string,
        onChunk: (chunk: string) => void,
        signal?: AbortSignal
    ): Promise<ChatCompletionResult> {
        return super.streamChat(messages, systemPrompt, onChunk, signal);
    }
}
