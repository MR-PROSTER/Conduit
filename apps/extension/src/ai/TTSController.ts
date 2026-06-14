/**
 * TTSController.ts
 *
 * Handles all Text-to-Speech synthesis for Conduit via the Sarvam AI API.
 * Extracted from ChatPanelProvider so the logic lives in exactly one place.
 *
 * Key design decisions:
 *  - Each synthesis run gets its own AbortController; calling stop() immediately
 *    cancels all in-flight fetch calls, not just the audio element.
 *  - Chunks are emitted to the frontend via onEvent() as soon as they complete
 *    (streaming), so audio starts playing after the first chunk instead of
 *    waiting for the entire message to synthesize.
 *  - Language codes are normalised here (or-IN → od-IN for Odia) so callers
 *    never need to care about Sarvam's internal naming quirks.
 *  - Each language gets a sensible default speaker from bulbul:v3's roster.
 *  - Retry logic uses exponential back-off (1 s, 2 s, 4 s) instead of a
 *    single fixed 1 500 ms wait.
 */

import fs from 'node:fs/promises';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceOption = 'english' | 'multilingual';

export type TTSEvent =
  | { type: 'ttsStart';      messageId?: string; totalChunks: number;                      voiceOption?: VoiceOption }
  | { type: 'ttsChunkReady'; messageId?: string; index: number; audioData: string;          voiceOption?: VoiceOption }
  | { type: 'ttsDone';       messageId?: string;                                             voiceOption?: VoiceOption }
  | { type: 'ttsStopped';    messageId?: string;                                             voiceOption?: VoiceOption }
  | { type: 'ttsError';      messageId?: string; error: string;                             voiceOption?: VoiceOption };

export type TTSEventCallback = (event: TTSEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Language / speaker maps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps UI-facing language codes to the code Sarvam's REST API actually accepts.
 * Odia is the main gotcha: the BCP-47 tag is or-IN but Sarvam uses od-IN.
 */
const SARVAM_LANG_NORMALISE: Record<string, string> = {
  'en-IN': 'en-IN',
  'hi-IN': 'hi-IN',
  'bn-IN': 'bn-IN',
  'ta-IN': 'ta-IN',
  'te-IN': 'te-IN',
  'kn-IN': 'kn-IN',
  'ml-IN': 'ml-IN',
  'mr-IN': 'mr-IN',
  'gu-IN': 'gu-IN',
  'pa-IN': 'pa-IN',
  'or-IN': 'od-IN', // ← critical fix: Sarvam uses od-IN, not or-IN
};

/**
 * Default speaker per language for bulbul:v3.
 * These are subjectively the best quality matches from Sarvam's speaker roster.
 * You can expose this as a user preference in Settings later.
 */
const DEFAULT_SPEAKER: Record<string, string> = {
  'en-IN': 'shubh',
  'hi-IN': 'ashutosh',
  'bn-IN': 'shubh',
  'ta-IN': 'kavya',
  'te-IN': 'shubh',
  'kn-IN': 'shubh',
  'ml-IN': 'shubh',
  'mr-IN': 'shubh',
  'gu-IN': 'shubh',
  'pa-IN': 'shubh',
  'or-IN': 'shubh',
  'od-IN': 'shubh',
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported so they can be unit-tested independently)
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum characters per TTS request. Sarvam's limit is 2,500 characters, but keeping it around 800 ensures a good balance of low initial latency and fewer API requests. */
const MAX_CHUNK_CHARS = 800;

/** Max retries for a single TTS chunk request (exponential back-off). */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential back-off (doubles on each retry). */
const RETRY_BASE_MS = 1_000;

/**
 * Strip Markdown formatting from AI-generated text so the TTS engine
 * receives clean prose rather than asterisks, hashes and bracket syntax.
 */
export function cleanMarkdownForSpeech(text: string): string {
  return text
    // Remove fenced code blocks entirely (code is unreadable aloud)
    .replace(/```[\s\S]*?```/g, '')
    // Inline code → plain text
    .replace(/`([^`]+)`/g, '$1')
    // ATX headings — strip the # characters
    .replace(/^#{1,6}\s+/gm, '')
    // **bold** and __bold__
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // *italic* and _italic_
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Unordered list bullets
    .replace(/^\s*[-*+]\s+/gm, '')
    // Ordered list numbers
    .replace(/^\s*\d+\.\s+/gm, '')
    // [label](url) → label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // ![alt](url) → silence
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Blockquotes
    .replace(/^\s*>\s+/gm, '')
    // Table rows
    .replace(/\|[^\n]*\|/g, '')
    // Inline HTML tags
    .replace(/<[^>]+>/g, '')
    // Common HTML entities
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    // Collapse excess whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Split text into sentence-aware chunks that fit within maxLen characters.
 * Sentences are kept whole when possible; oversized sentences are split by
 * word, and oversized single words are hard-split.
 */
export function chunkText(text: string, maxLen: number = MAX_CHUNK_CHARS): string[] {
  // 1. Tokenise into sentences across all newline-separated lines
  const sentences: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    // Split on sentence-ending punctuation (lookbehind keeps punctuation attached)
    for (const part of trimmed.split(/(?<=[.!?।])\s+/)) {
      const s = part.trim();
      if (s) { sentences.push(s); }
    }
  }

  // 2. Accumulate sentences into chunks
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (!sentence) { continue; }

    if (sentence.length > maxLen) {
      // Flush current buffer first
      if (current) { chunks.push(current); current = ''; }
      // Word-split the oversized sentence
      let sub = '';
      for (const word of sentence.split(/\s+/)) {
        if (!word) { continue; }
        if (word.length > maxLen) {
          if (sub) { chunks.push(sub); sub = ''; }
          // Hard-split oversized single word
          for (let i = 0; i < word.length; i += maxLen) {
            chunks.push(word.slice(i, i + maxLen));
          }
        } else if (sub && (sub + ' ' + word).length > maxLen) {
          chunks.push(sub);
          sub = word;
        } else {
          sub = sub ? sub + ' ' + word : word;
        }
      }
      if (sub) { chunks.push(sub); }
    } else {
      const joined = current ? current + ' ' + sentence : sentence;
      if (joined.length > maxLen) {
        if (current) { chunks.push(current); }
        current = sentence;
      } else {
        current = joined;
      }
    }
  }

  if (current) { chunks.push(current); }
  return chunks.map(c => c.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// TTSController
// ─────────────────────────────────────────────────────────────────────────────

export class TTSController {
  private activeAbort: AbortController | null = null;

  /**
   * @param getSarvamKey  Async getter for the Sarvam API key (same as ApiKeyStore.getSarvamKey)
   * @param onEvent       Callback used to push events to the webview (same as ChatPanelProvider.post)
   */
  constructor(
    private readonly getSarvamKey: () => Promise<string | undefined>,
    private readonly onEvent: TTSEventCallback,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Cancel any in-flight synthesis immediately.
   * AbortError propagation ensures all pending fetch() calls are cancelled;
   * the caller doesn't need to do anything else to silence audio — just call
   * the webview's stopActiveAudio() on the ttsStopped event.
   */
  stop(): void {
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
  }

  /**
   * Synthesize `text` in `languageCode` and stream audio chunks to the webview.
   *
   * Emits events in this order:
   *   ttsStart → (ttsChunkReady × N) → ttsDone
   *            ↘ ttsStopped   (if stop() was called)
   *            ↘ ttsError     (on API failure)
   *
   * The frontend should begin audio playback as soon as it receives the first
   * ttsChunkReady, not wait for ttsDone — this cuts perceived latency from
   * "full message synthesis time" to "first chunk synthesis time".
   */
  async synthesize(
    text: string,
    languageCode: string = 'en-IN',
    messageId?: string,
    voiceOption?: VoiceOption,
  ): Promise<void> {
    const logPath = '/home/ruthveek/live/Conduit/tts_debug_general.log';
    try {
      await fs.writeFile(logPath, `[TTSController] synthesize called: LANG=${languageCode}, MSGID=${messageId}, OPTION=${voiceOption}, LEN=${text.length}\n`);
    } catch {}

    // Cancel any previous run before starting a new one
    this.stop();

    const abort = new AbortController();
    this.activeAbort = abort;
    const { signal } = abort;

    try {
      // ── Preflight ──────────────────────────────────────────────────────────
      const apiKey = await this.getSarvamKey();
      if (!apiKey) {
        try { await fs.appendFile(logPath, `[TTSController] PREFLIGHT FAILED: API Key missing\n`); } catch {}
        this.onEvent({
          type: 'ttsError',
          error: 'Sarvam AI API key is missing. Add it in Settings (⚙).',
          messageId,
          voiceOption,
        });
        return;
      }

      const cleanText = cleanMarkdownForSpeech(text);
      if (!cleanText) {
        try { await fs.appendFile(logPath, `[TTSController] PREFLIGHT FAILED: Clean text is empty\n`); } catch {}
        this.onEvent({ type: 'ttsStopped', messageId, voiceOption });
        return;
      }

      const chunks = chunkText(cleanText);
      try { await fs.appendFile(logPath, `[TTSController] Text chunked into ${chunks.length} chunks\n`); } catch {}
      if (chunks.length === 0) {
        this.onEvent({ type: 'ttsStopped', messageId, voiceOption });
        return;
      }

      // Normalise language code once — fixes the or-IN / od-IN Odia bug
      const normLang  = SARVAM_LANG_NORMALISE[languageCode] ?? languageCode;
      const speaker   = DEFAULT_SPEAKER[languageCode] ?? 'shubh';

      // ── Signal start ───────────────────────────────────────────────────────
      this.onEvent({ type: 'ttsStart', messageId, totalChunks: chunks.length, voiceOption });

      // ── Process chunks in a concurrent sliding window (parallel synthesis) ─────
      let nextProcessingIndex = 0;
      let nextEmitIndex = 0;
      const completedChunks = new Map<number, string>();
      let synthesisError: any = null;

      const worker = async () => {
        while (nextProcessingIndex < chunks.length && !signal.aborted && !synthesisError) {
          const currentIndex = nextProcessingIndex++;
          try {
            await fs.appendFile(logPath, `[TTSController] [Worker] Processing chunk ${currentIndex}: length ${chunks[currentIndex].length}\n`).catch(() => {});
            
            // Translate if the target language is not English
            const translated = await this.translate(chunks[currentIndex], languageCode, normLang, apiKey, signal);
            if (signal.aborted) {
              const err = new Error('Synthesis aborted');
              err.name = 'AbortError';
              throw err;
            }
            
            await fs.appendFile(logPath, `[TTSController] [Worker] Translated chunk ${currentIndex}: length ${translated.length}\n`).catch(() => {});
            
            // Synthesize audio for this chunk
            const audioData = await this.synthesizeChunk(translated, currentIndex, normLang, speaker, apiKey, signal);
            if (signal.aborted) {
              const err = new Error('Synthesis aborted');
              err.name = 'AbortError';
              throw err;
            }
            
            await fs.appendFile(logPath, `[TTSController] [Worker] Synthesized chunk ${currentIndex}: audio data size ${audioData.length}\n`).catch(() => {});
            
            completedChunks.set(currentIndex, audioData);
            
            // Emit completed chunks in order
            while (completedChunks.has(nextEmitIndex)) {
              const data = completedChunks.get(nextEmitIndex)!;
              this.onEvent({ type: 'ttsChunkReady', index: nextEmitIndex, audioData: data, messageId, voiceOption });
              completedChunks.delete(nextEmitIndex); // Free memory
              nextEmitIndex++;
            }
          } catch (err) {
            synthesisError = err;
            abort.abort(); // Cancel all in-flight requests in other workers
            throw err;
          }
        }
      };

      // Run up to CONCURRENCY workers in parallel to optimize throughput without triggering excessive 429s
      const CONCURRENCY = 2;
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, chunks.length) },
        () => worker()
      );

      await Promise.all(workers);

      if (synthesisError) {
        throw synthesisError;
      }

      if (!signal.aborted) {
        try { await fs.appendFile(logPath, `[TTSController] Synthesis finished successfully!\n`); } catch {}
        this.onEvent({ type: 'ttsDone', messageId, voiceOption });
      }

    } catch (err: any) {
      try { await fs.appendFile(logPath, `[TTSController] Synthesis exception: ${err.message}\nSTACK: ${err.stack}\n`); } catch {}
      // AbortError means stop() was called — emit ttsStopped, not ttsError
      if (err?.name === 'AbortError' || signal.aborted) {
        this.onEvent({ type: 'ttsStopped', messageId, voiceOption });
        return;
      }
      console.error('[TTSController] synthesis failed:', err);
      this.onEvent({
        type: 'ttsError',
        error: err instanceof Error ? err.message : String(err),
        messageId,
        voiceOption,
      });
    } finally {
      // Clear reference only if it's still ours (a new call may have replaced it)
      if (this.activeAbort === abort) {
        this.activeAbort = null;
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Translate one chunk from English to the target language (no-op for en-IN). */
  private async translate(
    chunk: string,
    originalLang: string,
    normalisedLang: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (originalLang === 'en-IN') { return chunk; }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal.aborted) {
        const err = new Error('Synthesis aborted');
        err.name = 'AbortError';
        throw err;
      }

      // Exponential back-off: wait before retries
      if (attempt > 0) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await this.sleep(delay, signal);
      }

      try {
        const res = await fetch('https://api.sarvam.ai/translate', {
          method: 'POST',
          headers: {
            'api-subscription-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: chunk,
            source_language_code: 'en-IN',
            target_language_code: normalisedLang,
            model: 'sarvam-translate:v1',
          }),
          signal,
        });

        if (res.status === 429) {
          lastError = new Error(`Translate rate-limited (attempt ${attempt + 1})`);
          console.warn(`[TTSController] ${lastError.message}`);
          continue;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          lastError = new Error(`Translate HTTP ${res.status}: ${body}`);
          continue; // Retry on other non-OK status as well
        }

        const data = (await res.json()) as { translated_text?: string };
        return data.translated_text?.trim() || chunk;
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal.aborted) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error(`Translate failed after ${MAX_RETRIES} retries`);
  }

  /**
   * Synthesize one chunk with exponential back-off retry.
   * Retries on HTTP 429 (rate-limited) or other errors up to MAX_RETRIES times.
   */
  private async synthesizeChunk(
    text: string,
    index: number,
    languageCode: string,
    speaker: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal.aborted) {
        const err = new Error('Synthesis aborted');
        err.name = 'AbortError';
        throw err;
      }

      // Exponential back-off: wait before retries
      if (attempt > 0) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1); // 1 s, 2 s, 4 s
        await this.sleep(delay, signal);
      }

      try {
        const res = await fetch('https://api.sarvam.ai/text-to-speech', {
          method: 'POST',
          headers: {
            'api-subscription-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model: 'bulbul:v3',
            target_language_code: languageCode, // ← already normalised by caller
            speaker,                             // ← language-appropriate speaker
            output_audio_codec: 'mp3',
          }),
          signal,
        });

        if (res.status === 429) {
          // Rate-limited — back off and retry
          lastError = new Error(`TTS rate-limited on chunk ${index} (attempt ${attempt + 1})`);
          console.warn(`[TTSController] ${lastError.message}`);
          continue;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          lastError = new Error(`TTS HTTP ${res.status} on chunk ${index}: ${body}`);
          continue; // Retry on other non-OK status as well
        }

        const data = (await res.json()) as { audios?: string[] };
        if (data.audios && data.audios.length > 0) {
          return data.audios[0]; // base64-encoded MP3
        }

        lastError = new Error(`TTS chunk ${index}: response contained no audio data`);
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal.aborted) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error(`TTS chunk ${index}: failed after ${MAX_RETRIES} retries`);
  }

  /** Promise that resolves after `ms` milliseconds or rejects on abort. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        const err = new Error('Synthesis aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('Synthesis aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
  }
}
