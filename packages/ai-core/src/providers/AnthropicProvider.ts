import Anthropic from '@anthropic-ai/sdk';
import { isTextMimeType, isImageMimeType } from './fileTypeUtils.js';

import type {
    ILLMProvider,
    ChatCompletionMessage,
    ChatCompletionResult,
    AgentToolDefinition,
    AgentIterationResult,
    AgentToolCall,
} from './ILLMProvider.js';

/** Claude models that support vision input */
const VISION_MODELS = new Set([
    'claude-opus-4',
    'claude-sonnet-4',
    'claude-haiku-4',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'claude-3-opus',
    'claude-3-sonnet',
    'claude-3-haiku',
]);

/**
 * For binary file types (docx, xlsx, etc.), attempt to extract any
 * human-readable text by scanning the raw bytes for UTF-8 / XML runs.
 */
/**
 * For binary file types (docx, xlsx, etc.), attempt to extract any
 * human-readable text by scanning the raw bytes for UTF-8 / XML runs.
 */
function tryExtractBinaryText(base64Data: string, fileName?: string): string {
    const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
    const zipTextFormats = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
    if (zipTextFormats.has(ext)) {
        try {
            const raw = Buffer.from(base64Data, 'base64').toString('utf-8', 0, 512_000);
            const stripped = raw
                .replace(/<[^>]+>/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
            if (stripped.length > 50) {
                const truncated = stripped.length > 8_000;
                return stripped.slice(0, 8_000) + (truncated ? '\n[... truncated]' : '');
            }
        } catch { /* fall through */ }
    }
    return '[Binary file — content cannot be displayed. Filename: ' + (fileName ?? 'unknown') + ']';
}


export class AnthropicProvider implements ILLMProvider {
    public readonly name = 'anthropic';
    public readonly supportsVision: boolean;
    private readonly client: Anthropic;

    public constructor(
        apiKey: string,
        public readonly modelId: string = 'claude-sonnet-4-5'
    ) {
        this.client = new Anthropic({ apiKey });
        // Anthropic vision support: all Claude 3+ models
        this.supportsVision = [...VISION_MODELS].some((m) => modelId.includes(m));
    }

    public async checkVisionSupport(): Promise<boolean> {
        return this.supportsVision;
    }

    /**
     * Map universal ChatCompletionMessage[] to Anthropic MessageParam[].
     *
     * Anthropic requires:
     * - assistant messages with tool calls → content array with text + tool_use blocks
     * - tool results → user message with tool_result blocks (consecutive tool messages
     *   are merged into a single user message with multiple tool_result blocks)
     * - user messages with images → content array with image + text blocks
     */
    private mapMessages(messages: ChatCompletionMessage[]): Anthropic.MessageParam[] {
        const result: Anthropic.MessageParam[] = [];

        for (const msg of messages) {
            if (msg.role === 'user') {
                if (msg.images && msg.images.length > 0) {
                    // Multi-part message: images first, then text
                    const contentBlocks: Anthropic.MessageParam['content'] = [];
                    for (const img of msg.images) {
                        if (img.mimeType === 'application/pdf') {
                            // PDFs as document blocks
                            contentBlocks.push({
                                type: 'document',
                                source: {
                                    type: 'base64',
                                    media_type: 'application/pdf',
                                    data: img.data,
                                },
                                title: img.fileName,
                            } as any);
                        } else if (isImageMimeType(img.mimeType, img.fileName)) {
                            contentBlocks.push({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: img.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                                    data: img.data,
                                },
                            } as Anthropic.ImageBlockParam);
                        } else if (isTextMimeType(img.mimeType, img.fileName)) {
                            // Text/code files: decode base64 → readable content
                            let decodedContent: string;
                            try {
                                decodedContent = Buffer.from(img.data, 'base64').toString('utf-8');
                            } catch {
                                decodedContent = '[Could not decode file content]';
                            }
                            contentBlocks.push({
                                type: 'text',
                                text: `[Attached file: ${img.fileName || 'file'} (type: ${img.mimeType})]\n${decodedContent}`,
                            } as Anthropic.TextBlockParam);
                        } else {
                            // Binary files (docx, xlsx, zip, etc.): best-effort text extraction
                            const fallback = tryExtractBinaryText(img.data, img.fileName);
                            contentBlocks.push({
                                type: 'text',
                                text: `[Attached file: ${img.fileName || 'file'} (${img.mimeType})]
${fallback}`,
                            } as Anthropic.TextBlockParam);
                        }
                    }
                    if (msg.content) {
                        contentBlocks.push({ type: 'text', text: msg.content });
                    }
                    result.push({ role: 'user', content: contentBlocks });
                } else {
                    result.push({ role: 'user', content: msg.content });
                }

            } else if (msg.role === 'assistant') {
                const contentBlocks: any[] = [];
                if (msg.content) {
                    contentBlocks.push({ type: 'text', text: msg.content });
                }
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const tc of msg.toolCalls) {
                        contentBlocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.name,
                            input: tc.input,
                        } as Anthropic.ToolUseBlock);
                    }
                }
                result.push({
                    role: 'assistant',
                    content: contentBlocks.length > 0 ? contentBlocks : (msg.content ?? ''),
                });

            } else if (msg.role === 'tool') {
                // Tool results must be in a user message as tool_result blocks.
                // Merge consecutive tool messages into a single user message.
                const toolResultBlock: Anthropic.ToolResultBlockParam = {
                    type: 'tool_result',
                    tool_use_id: msg.toolCallId,
                    content: msg.content,
                };

                const last = result[result.length - 1];
                let pushed = false;
                if (
                    last?.role === 'user' &&
                    Array.isArray(last.content)
                ) {
                    const contentArray = last.content as any[];
                    if (
                        contentArray[0] &&
                        typeof contentArray[0] === 'object' &&
                        contentArray[0].type === 'tool_result'
                    ) {
                        contentArray.push(toolResultBlock);
                        pushed = true;
                    }
                }
                if (!pushed) {
                    result.push({ role: 'user', content: [toolResultBlock] });
                }
            }
        }

        return result;
    }

    public async streamChat(
        messages: ChatCompletionMessage[],
        systemPrompt: string,
        onChunk: (chunk: string) => void,
        signal?: AbortSignal
    ): Promise<ChatCompletionResult> {
        let fullContent = '';
        let totalTokens = 0;

        const stream = this.client.messages.stream(
            {
                model: this.modelId,
                max_tokens: 8192,
                system: systemPrompt,
                messages: this.mapMessages(messages),
            },
            { signal }  // ← pass signal so the SDK cancels the HTTP request immediately
        );

        for await (const event of stream) {
            if (signal?.aborted) break;
            if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta'
            ) {
                const chunk = event.delta.text;
                fullContent += chunk;
                onChunk(chunk);
            }
        }

        // Skip finalMessage() on abort — awaiting it blocks until the full stream
        // drains from the server, defeating the purpose of aborting.
        if (!signal?.aborted) {
            const finalMessage = await stream.finalMessage();
            totalTokens =
                (finalMessage.usage.input_tokens ?? 0) +
                (finalMessage.usage.output_tokens ?? 0);
        }

        return { content: fullContent, totalTokens, model: this.modelId };
    }

    public async runAgentIteration(
        messages: ChatCompletionMessage[],
        systemPrompt: string,
        tools: AgentToolDefinition[],
        signal?: AbortSignal
    ): Promise<AgentIterationResult> {
        const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        }));

        const response = await this.client.messages.create({
            model: this.modelId,
            max_tokens: 8192,
            system: systemPrompt,
            tools: anthropicTools,
            messages: this.mapMessages(messages),
        }, { signal });

        const toolCalls: AgentToolCall[] = [];
        let textContent: string | undefined;

        for (const block of response.content) {
            if (block.type === 'text') {
                textContent = block.text;
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    input: block.input as Record<string, unknown>,
                });
            }
        }

        const stopReason: AgentIterationResult['stopReason'] =
            response.stop_reason === 'tool_use'
                ? 'tool_use'
                : response.stop_reason === 'max_tokens'
                    ? 'max_tokens'
                    : 'end_turn';

        const totalTokens =
            (response.usage.input_tokens ?? 0) +
            (response.usage.output_tokens ?? 0);

        return { content: textContent, toolCalls, stopReason, totalTokens };
    }

    public async listModels(): Promise<string[]> {
        try {
            const models = await this.client.models.list();
            return models.data.map((m: any) => m.id);
        } catch {
            return [
                'claude-opus-4-5',
                'claude-sonnet-4-5',
                'claude-haiku-4-5',
            ];
        }
    }

    public async validateKey(): Promise<boolean> {
        try {
            await this.client.models.list();
            return true;
        } catch (err) {
            // Network error — don't invalidate a key just because we're offline
            if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) {
                return true;
            }
            return false;
        }
    }

    public countTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }
}
