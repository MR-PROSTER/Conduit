export interface FileMemoryEntry {
  path: string;
  signature: string;
  fullContent: string | null;
  hash: string;
  lastAccessed: string;
}

export interface AgentDecision {
  iteration: number;
  decision: string;
  reason: string;
  confidence: number;
}

export interface AgentObservation {
  iteration: number;
  observation: string;
  relevantFiles: readonly string[];
}

export interface AgentEdit {
  filePath: string;
  previousContent: string | null;
  newContent: string;
  approved: boolean;
  iteration: number;
}

export interface AgentMemory {
  taskId: string;
  goal: string;
  plan: string;
  decisions: readonly AgentDecision[];
  filesRead: Map<string, FileMemoryEntry>;
  searchResults: Map<string, string>;
  observations: readonly AgentObservation[];
  editsApplied: readonly AgentEdit[];
  stashRef: string | null;
  iteration: number;
}
