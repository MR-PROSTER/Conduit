/**
 * Lightweight metadata for a file attached to a user message.
 * We store only the metadata (name, MIME type, size) — not the raw
 * base64 data — so that persisted messages stay small.
 */
export interface AttachmentMeta {
  /** Original file name, e.g. "schema.ts" */
  readonly fileName: string;
  /** MIME type as reported / corrected by the client */
  readonly mimeType: string;
  /** File size in bytes */
  readonly size: number;
}

/**
 * A single message in a chat thread.
 */
export interface ChatMessage {
  readonly id: string;
  readonly threadId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** LLM model identifier, e.g. 'claude-sonnet-4' */
  readonly model: string | undefined;
  readonly tokensUsed: number | undefined;
  /** Code graph references used in context assembly */
  readonly contextRefs: readonly ContextRef[] | undefined;
  /** Agent mode step cards */
  readonly agentSteps: readonly AgentStep[] | undefined;
  /**
   * Metadata for files attached to this message (user messages only).
   * Stored so the UI can show what was attached when replaying history.
   */
  readonly attachments: readonly AttachmentMeta[] | undefined;
  readonly createdAt: string;
  readonly senderId: string;
  readonly senderName?: string | undefined;
}

/**
 * A code reference used as context for an AI response.
 */
export interface ContextRef {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nodeType: string;
}

/**
 * A single step in the agent execution loop.
 */
export interface AgentStep {
  readonly id: string;
  readonly type: 'plan' | 'read' | 'edit' | 'safety-check' | 'verify' | 'done' | 'error';
  readonly title: string;
  readonly body: string | undefined;
  readonly diff: FileDiff | undefined;
  readonly safetyBlock: SafetyBlock | undefined;
  readonly status: 'pending' | 'running' | 'done' | 'approved' | 'rejected';
}

/**
 * A file diff produced by an agent edit step.
 */
export interface FileDiff {
  readonly filePath: string;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffLine {
  readonly type: 'add' | 'del' | 'ctx';
  readonly content: string;
}

/**
 * Describes a safety block — a peer is currently editing the target file.
 */
export interface SafetyBlock {
  readonly filePath: string;
  readonly peerName: string;
}
