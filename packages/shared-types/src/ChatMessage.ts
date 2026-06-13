export interface AttachmentMeta {
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ContextRef {
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType: string;
}

export interface SafetyBlock {
  filePath: string;
  peerName: string;
}

export interface DiffLine {
  type: "add" | "del" | "ctx";
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: readonly DiffLine[];
}

export interface FileDiff {
  filePath: string;
  hunks: readonly DiffHunk[];
}

export interface AgentStep {
  id: string;
  type: string;
  title: string;
  body?: string;
  diff?: string;
  safetyBlock?: SafetyBlock;
  status: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  createdBy: string;
  createdAt: string;
  role: "user" | "assistant" | "system" | "agent";
  content: string;
  attachments?: readonly AttachmentMeta[];
  contextRefs?: readonly ContextRef[];
  agentSteps?: readonly AgentStep[];
  fileDiffs?: readonly FileDiff[];
  safetyBlock?: SafetyBlock;
}
