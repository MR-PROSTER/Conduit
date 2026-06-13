import OpenAI from 'openai';
import { isTextMimeType, isImageMimeType } from './fileTypeUtils.js';

import type {
    ILLMProvider,
    ChatCompletionMessage,
    ChatCompletionResult,
    AgentToolDefinition,
    AgentIterationResult,
    AgentToolCall,
} from './ILLMProvider.js';

/** OpenAI models that support vision input */
const VISION_MODELS = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3']);

/**
 * Best-effort text extraction from a PDF's raw bytes (base64-decoded).
 * Pulls out BT...ET text stream blocks — good enough for most PDFs.
 * Falls back gracefully if the PDF is encrypted or purely image-based.
 */
/**
 * Best-effort text extraction from a PDF's raw bytes (base64-decoded).
 * Pulls out BT...ET text stream blocks — good enough for most PDFs.
 * Falls back gracefully if the PDF is encrypted or purely image-based.
 */
function extractPdfText(base64Data: string): string {
    try {
        const bytes = Buffer.from(base64Data, 'base64').toString('binary');
        const chunks: string[] = [];
        const btEt = /BT[\s\S]*?ET/g;
        let m: RegExpExecArray | null;
        while ((m = btEt.exec(bytes)) !== null) {
            const strRe = /\(([^)]*)\)\s*Tj|\[[\s\S]*?\]\s*TJ/g;
            let sm: RegExpExecArray | null;
            while ((sm = strRe.exec(m[0])) !== null) {
                const raw = sm[1] ?? '';
                const printable = raw
                    .replace(/\\\d{3}/g, '')
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '')
                    .replace(/\\t/g, ' ');
                if (printable.trim().length > 0) chunks.push(printable);
            }
        }
        const result = chunks.join(' ').replace(/[ \t]{2,}/g, ' ').trim();
        if (result.length > 0) return result;
        return '[PDF text extraction yielded no readable content — the file may be image-based or encrypted]';
    } catch {
        return '[Could not extract PDF text]';
    }
}

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


export class OpenAIProvider implements ILLMProvider {
    public readonly name: string = 'openai';
    public readonly supportsVision: boolean;
    protected readonly client: OpenAI;

    public constructor(
        apiKey: string,
        public readonly modelId: string = 'gpt-4o',
        baseURL?: string
    ) {
        this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
        this.supportsVision = [...VISION_MODELS].some((m) => modelId.includes(m));
    }

    public async checkVisionSupport(): Promise<boolean> {
        return this.supportsVision;
    }

    /**
     * Map universal ChatCompletionMessage[] to OpenAI ChatCompletionMessageParam[].
     *
     * OpenAI requires:
     * - assistant messages with tool calls → include tool_calls array
     * - tool results → role:'tool' with tool_call_id
     * - user messages with images → content array with image_url + text parts
     */
    protected mapMessages(
        messages: ChatCompletionMessage[]
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        return messages.map((msg) => {
            if (msg.role === 'user') {
                if (msg.images && msg.images.length > 0) {
                    const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
                    for (const img of msg.images) {
                        if (isImageMimeType(img.mimeType, img.fileName)) {
                            parts.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${img.mimeType};base64,${img.data}`,
                                },
                            });
                        } else if (img.mimeType === 'application/pdf') {
                            // PDFs: extract text via BT/ET stream parsing (OpenAI doesn't support document blocks)
                            const extracted = extractPdfText(img.data);
                            parts.push({
                                type: 'text',
                                text: `[Attached PDF: ${img.fileName || 'file.pdf'}]\n${extracted}`,
                            });
                        } else if (isTextMimeType(img.mimeType, img.fileName)) {
                            // Text/code files: decode base64 → readable content
                            let decodedContent: string;
                            try {
                                decodedContent = Buffer.from(img.data, 'base64').toString('utf-8');
                            } catch {
                                decodedContent = '[Could not decode file content]';
                            }
                            parts.push({
                                type: 'text',
                                text: `[Attached file: ${img.fileName || 'file'} (${img.mimeType})]\n${decodedContent}`,
                            });
                        } else {
                            // Binary files (docx, xlsx, zip, etc.): best-effort text extraction
                            const fallback = tryExtractBinaryText(img.data, img.fileName);
                            parts.push({
                                type: 'text',
                                text: `[Attached file: ${img.fileName || 'file'} (${img.mimeType})]\n${fallback}`,
                            });
                        }
                    }
                    if (msg.content) {
                        parts.push({ type: 'text', text: msg.content });
                    }
                    return { role: 'user', content: parts };
                }
                return { role: 'user', content: msg.content };
            }

            if (msg.role === 'assistant') {
                const m: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
                    role: 'assistant',
                    content: msg.content ?? null,
                };
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    m.tool_calls = msg.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.input),
                        },
                    }));
                }
                return m;
            }

            // role === 'tool'
            return {
                role: 'tool' as const,
                tool_call_id: msg.toolCallId,
                content: msg.content,
            };
        });
    }

    public async streamChat(
        messages: ChatCompletionMessage[],
        systemPrompt: string,
        onChunk: (chunk: string) => void,
        signal?: AbortSignal
    ): Promise<ChatCompletionResult> {
        let fullContent = '';
        let totalTokens = 0;

        const stream = await this.client.chat.completions.create(
            {
                model: this.modelId,
                stream: true,
                stream_options: { include_usage: true },
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...this.mapMessages(messages),
                ],
            },
            { signal }  // ← cancel the HTTP request immediately on abort
        );

        for await (const chunk of stream) {
            if (signal?.aborted) break;
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
                fullContent += delta;
                onChunk(delta);
            }
            if (chunk.usage) {
                totalTokens =
                    (chunk.usage.prompt_tokens ?? 0) +
                    (chunk.usage.completion_tokens ?? 0);
            }
        }

        return { content: fullContent, totalTokens, model: this.modelId };
    }

    public async runAgentIteration(
        messages: ChatCompletionMessage[],
        systemPrompt: string,
        tools: AgentToolDefinition[],
        signal?: AbortSignal
    ): Promise<AgentIterationResult> {
        const oaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
            },
        }));

        const response = await this.client.chat.completions.create({
            model: this.modelId,
            messages: [
                { role: 'system', content: systemPrompt },
                ...this.mapMessages(messages),
            ],
            tools: oaiTools,
            tool_choice: 'auto',
        }, { signal });

        const choice = response.choices[0];
        const toolCalls: AgentToolCall[] = [];
        let textContent: string | undefined;

        if (choice?.message.content) {
            textContent = choice.message.content;
        }

        for (const tc of choice?.message.tool_calls ?? []) {
            const toolCall = tc as any;
            if (toolCall.function) {
                toolCalls.push({
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
                });
            }
        }

        const stopReason: AgentIterationResult['stopReason'] =
            choice?.finish_reason === 'tool_calls'
                ? 'tool_use'
                : choice?.finish_reason === 'length'
                    ? 'max_tokens'
                    : 'end_turn';

        const totalTokens =
            (response.usage?.prompt_tokens ?? 0) +
            (response.usage?.completion_tokens ?? 0);

        return { content: textContent, toolCalls, stopReason, totalTokens };
    }

    public async listModels(): Promise<string[]> {
        try {
            const models = await this.client.models.list();
            return models.data
                .filter((m: any) => m.id.startsWith('gpt') || m.id.startsWith('o'))
                .map((m: any) => m.id)
                .sort();
        } catch {
            return ['gpt-4o', 'gpt-4o-mini', 'o3-mini'];
        }
    }

    public async validateKey(): Promise<boolean> {
        try {
            await this.client.models.list();
            return true;
        } catch (err) {
            if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) {
                return true; // offline — assume key is valid
            }
            return false;
        }
    }

    public countTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }
}
