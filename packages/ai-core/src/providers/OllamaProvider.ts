import { isTextMimeType, isImageMimeType } from './fileTypeUtils.js';
import type {
  ILLMProvider,
  ChatCompletionMessage,
  ChatCompletionResult,
  AgentToolDefinition,
  AgentIterationResult,
  AgentToolCall,
} from './ILLMProvider.js';

interface OllamaModel {
  name: string;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
}

/** Ollama /api/show response — we only need the fields relevant to vision detection */
interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  projector_info?: Record<string, unknown>;
}

function extractPdfTextOllama(base64Data: string): string {
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
    return result.length > 0 ? result : '[PDF text extraction yielded no readable content]';
  } catch {
    return '[Could not extract PDF text]';
  }
}

function tryExtractBinaryTextOllama(base64Data: string, fileName?: string): string {
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


export class OllamaProvider implements ILLMProvider {
  public readonly name = 'ollama';

  /**
   * Static vision flag — set to true if the model name matches known vision models.
   * Can be overridden by checkVisionSupport() which does a live /api/show call.
   */
  public readonly supportsVision: boolean;

  /** Cache the live vision check result so we don't hit /api/show every message */
  private visionChecked = false;
  private visionSupported = false;

  public constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
    public readonly modelId: string = 'llama3.2',
    /**
     * Context window size to tell Ollama to use.
     * Defaults to 4096 — enough for most small local models.
     * Keeping this small is the single biggest factor in Ollama response speed.
     */
    private readonly contextWindow: number = 4_096
  ) {
    // Known vision-capable Ollama models (static heuristic)
    const visionModels = [
      'llava', 'llava-llama3', 'llava-phi3', 'moondream',
      'bakllava', 'minicpm-v', 'qwen2-vl', 'qwen2.5-vl',
      'llama3.2-vision', 'llama3.2-vision:11b', 'llama3.2-vision:90b',
      'granite3.2-vision', 'gemma3',
    ];
    this.supportsVision = visionModels.some(
      (m) => modelId === m || modelId.startsWith(m + ':') || modelId.startsWith(m + '-')
    );
    this.visionSupported = this.supportsVision;
  }

  /**
   * Live vision check via Ollama /api/show.
   * Ollama reports vision capability via:
   *   - capabilities array containing "vision"
   *   - presence of projector_info (multimodal projector loaded)
   * Falls back to the static heuristic if the request fails.
   */
  public async checkVisionSupport(): Promise<boolean> {
    if (this.visionChecked) return this.visionSupported;
    this.visionChecked = true;
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.modelId }),
      });
      if (!response.ok) {
        this.visionSupported = this.supportsVision;
        return this.visionSupported;
      }
      const data = (await response.json()) as OllamaShowResponse;
      // Prefer the explicit capabilities list
      if (Array.isArray(data.capabilities)) {
        this.visionSupported = data.capabilities.includes('vision');
        return this.visionSupported;
      }
      // Fall back: projector_info present → multimodal model
      if (data.projector_info && Object.keys(data.projector_info).length > 0) {
        this.visionSupported = true;
        return true;
      }
      // Nothing definitive — use static heuristic
      this.visionSupported = this.supportsVision;
    } catch {
      this.visionSupported = this.supportsVision;
    }
    return this.visionSupported;
  }

  /**
   * Map universal ChatCompletionMessage[] to Ollama chat format.
   * Ollama uses the OpenAI-compatible chat format with role/content pairs.
   * For vision messages, images are sent as a separate 'images' array
   * of base64 strings alongside the message content.
   */
  private mapMessages(messages: ChatCompletionMessage[]): any[] {
    return messages.map((msg) => {
      if (msg.role === 'user') {
        const m: any = { role: 'user', content: msg.content };
        if (msg.images && msg.images.length > 0) {
          const imageOnlyAttachments = msg.images.filter(img => isImageMimeType(img.mimeType, img.fileName));
          const nonImageAttachments = msg.images.filter(img => !isImageMimeType(img.mimeType, img.fileName));
          // Ollama expects base64 strings in an 'images' array — only actual images
          if (imageOnlyAttachments.length > 0) {
            m.images = imageOnlyAttachments.map((img) => img.data);
          }
          // Non-image files: decode and append as text content
          if (nonImageAttachments.length > 0) {
            const textParts = nonImageAttachments.map((img) => {
              if (img.mimeType === 'application/pdf') {
                const extracted = extractPdfTextOllama(img.data);
                return `[Attached PDF: ${img.fileName || 'file.pdf'}]\n${extracted}`;
              }
              if (isTextMimeType(img.mimeType, img.fileName)) {
                let decoded: string;
                try { decoded = Buffer.from(img.data, 'base64').toString('utf-8'); }
                catch { decoded = '[Could not decode file content]'; }
                return `[Attached file: ${img.fileName || 'file'} (${img.mimeType})]\n${decoded}`;
              }
              // Binary (docx, xlsx, etc.): best-effort XML text extraction
              const fallback = tryExtractBinaryTextOllama(img.data, img.fileName);
              return `[Attached file: ${img.fileName || 'file'} (${img.mimeType})]\n${fallback}`;
            });
            m.content = (m.content ? m.content + '\n\n' : '') + textParts.join('\n\n');
          }
        }
        return m;
      }
      if (msg.role === 'assistant') {
        const m: any = { role: 'assistant', content: msg.content ?? '' };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          m.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.input,
            },
          }));
        }
        return m;
      }
      // role === 'tool'
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
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
    const payload = {
      model: this.modelId,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...this.mapMessages(messages),
      ],
      /**
       * Performance-critical Ollama options:
       * - num_ctx:     Must match (or be larger than) the tokens we actually send.
       *               Keep this tight — every extra slot costs VRAM and inference time.
       * - num_predict: Cap generation so the model doesn't produce runaway long responses.
       * - keep_alive:  Keep the model loaded for 5 min so repeated messages don't pay
       *               the model-load penalty each time.
       */
      options: {
        num_ctx: this.contextWindow,
        num_predict: 2048,
        keep_alive: '5m',
      },
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal as any,
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}`
      );
    }

    let fullContent = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as OllamaChatChunk;
          const chunk = parsed.message?.content ?? '';
          if (chunk) {
            fullContent += chunk;
            onChunk(chunk);
          }
        } catch {
          // Ignore malformed NDJSON lines
        }
      }
    }

    return {
      content: fullContent,
      totalTokens: this.countTokens(fullContent),
      model: this.modelId,
    };
  }

  /**
   * Ollama supports native tool calling in versions 0.3.0 and above.
   * Send the request with the tools payload to /api/chat.
   */
  public async runAgentIteration(
    messages: ChatCompletionMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    signal?: AbortSignal
  ): Promise<AgentIterationResult> {
    const ollamaTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const payload = {
      model: this.modelId,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        ...this.mapMessages(messages),
      ],
      tools: ollamaTools,
      options: {
        num_ctx: this.contextWindow,
        num_predict: 2048,
        keep_alive: '5m',
      },
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal ?? null,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(
        `Ollama agent iteration failed: ${response.status} ${response.statusText}${errBody ? ` - ${errBody}` : ''}`
      );
    }

    const data = (await response.json()) as {
      message: {
        role: string;
        content?: string;
        tool_calls?: Array<{
          id?: string;
          function: {
            name: string;
            arguments: Record<string, unknown> | string;
          };
        }>;
      };
    };

    const toolCalls: AgentToolCall[] = [];
    const choiceMsg = data.message;
    const textContent = choiceMsg.content || undefined;

    for (const tc of choiceMsg.tool_calls ?? []) {
      const input =
        typeof tc.function.arguments === 'string'
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : tc.function.arguments;
      toolCalls.push({
        id: tc.id || `call_${Math.random().toString(36).substring(2, 11)}`,
        name: tc.function.name,
        input,
      });
    }

    const stopReason: AgentIterationResult['stopReason'] =
      toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    const totalTokens =
      this.countTokens(textContent || '') +
      this.countTokens(JSON.stringify(toolCalls));

    return { content: textContent, toolCalls, stopReason, totalTokens };
  }

  public async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];
      const data = (await response.json()) as OllamaTagsResponse;
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  public async validateKey(): Promise<boolean> {
    // Ollama has no API key — just check if the server is reachable
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  public countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}