/**
 * Agent task memory — tracks everything the agent knows during a single task.
 * Files are compressed after first read to avoid token explosion.
 */
export interface AgentMemory {
  readonly taskId: string;
  readonly goal: string;
  readonly plan: readonly string[];
  readonly decisions: readonly AgentDecision[];
  readonly filesRead: ReadonlyMap<string, FileMemoryEntry>;
  /**
   * Maps search query → array of node IDs (not full CodeNode objects).
   * After first use, only node IDs are kept to save tokens.
   */
  readonly searchResults: ReadonlyMap<string, readonly string[]>;
  readonly observations: readonly AgentObservation[];
  readonly editsApplied: readonly AgentEdit[];
  readonly stashRef: string | null;
  readonly iteration: number;
}

export interface FileMemoryEntry {
  readonly path: string;
  /** Function names, exports, types — always retained */
  readonly signature: string;
  /** Full file content — nulled after first iteration use to save tokens */
  readonly fullContent: string | null;
  /** SHA hash of the file at time of read */
  readonly hash: string;
  readonly lastAccessed: number;
}

export interface AgentDecision {
  readonly iteration: number;
  readonly decision: string;
  readonly reason: string;
  readonly confidence: number;
}

export interface AgentObservation {
  readonly iteration: number;
  readonly observation: string;
  readonly relevantFiles: readonly string[];
}

export interface AgentEdit {
  readonly filePath: string;
  readonly previousContent: string;
  readonly newContent: string;
  readonly approved: boolean;
  readonly iteration: number;
}
