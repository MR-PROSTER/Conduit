import type {
  AgentMemory,
  AgentDecision,
  AgentObservation,
  AgentEdit,
  FileMemoryEntry,
} from '@conduit/shared-types';

/**
 * Manages AgentMemory state during a task.
 * Key rule: after first file read, fullContent is nulled to prevent token explosion.
 */
export class AgentMemoryManager {
  private memory: AgentMemory;

  public constructor(taskId: string, goal: string) {
    this.memory = {
      taskId,
      goal,
      plan: [],
      decisions: [],
      filesRead: new Map(),
      searchResults: new Map(),
      observations: [],
      editsApplied: [],
      stashRef: null,
      iteration: 0,
    };
  }

  public getMemory(): AgentMemory {
    return this.memory;
  }

  public incrementIteration(): void {
    this.memory = { ...this.memory, iteration: this.memory.iteration + 1 };
  }

  public setPlan(plan: string[]): void {
    this.memory = { ...this.memory, plan };
  }

  public setStashRef(ref: string | null): void {
    this.memory = { ...this.memory, stashRef: ref };
  }

  public addDecision(decision: Omit<AgentDecision, 'iteration'>): void {
    this.memory = {
      ...this.memory,
      decisions: [
        ...this.memory.decisions,
        { ...decision, iteration: this.memory.iteration },
      ],
    };
  }

  public addObservation(observation: Omit<AgentObservation, 'iteration'>): void {
    this.memory = {
      ...this.memory,
      observations: [
        ...this.memory.observations,
        { ...observation, iteration: this.memory.iteration },
      ],
    };
  }

  public addEdit(edit: Omit<AgentEdit, 'iteration'>): void {
    this.memory = {
      ...this.memory,
      editsApplied: [
        ...this.memory.editsApplied,
        { ...edit, iteration: this.memory.iteration },
      ],
    };
  }

  /**
   * Record a file read. If file was already read before, compress immediately.
   */
  public recordFileRead(filePath: string, content: string): void {
    const alreadySeen = this.memory.filesRead.has(filePath);
    const entry: FileMemoryEntry = {
      path: filePath,
      signature: extractSignature(content),
      fullContent: alreadySeen ? null : content,
      hash: simpleHash(content),
      lastAccessed: Date.now(),
    };
    const newMap = new Map(this.memory.filesRead);
    newMap.set(filePath, entry);
    this.memory = { ...this.memory, filesRead: newMap };
  }

  /**
   * Compress a file entry — null out fullContent, keep signature only.
   * Called after the agent has used the content in an LLM call.
   */
  public compressAfterRead(filePath: string): void {
    const entry = this.memory.filesRead.get(filePath);
    if (!entry || entry.fullContent === null) return;
    const newMap = new Map(this.memory.filesRead);
    newMap.set(filePath, { ...entry, fullContent: null });
    this.memory = { ...this.memory, filesRead: newMap };
  }

  /**
   * Store search results as node IDs only (not full CodeNode objects).
   */
  public recordSearchResults(query: string, nodeIds: string[]): void {
    const newMap = new Map(this.memory.searchResults);
    newMap.set(query, nodeIds);
    this.memory = { ...this.memory, searchResults: newMap };
  }

  /**
   * Returns a token-efficient string summary for LLM context injection.
   */
  public getCompressedContext(): string {
    const { goal, plan, decisions, filesRead, observations, iteration } = this.memory;
    const parts: string[] = [
      `[Agent Memory — Iteration ${iteration}]`,
      `Goal: ${goal}`,
    ];

    if (plan.length > 0) {
      parts.push(`Plan:\n${plan.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
    }
    if (decisions.length > 0) {
      const recent = decisions.slice(-3);
      parts.push(
        `Recent decisions:\n${recent.map((d) => `  [i${d.iteration}] ${d.decision} (conf=${d.confidence.toFixed(2)})`).join('\n')}`
      );
    }
    if (observations.length > 0) {
      const recent = observations.slice(-3);
      parts.push(
        `Observations:\n${recent.map((o) => `  [i${o.iteration}] ${o.observation}`).join('\n')}`
      );
    }
    const fileEntries = [...filesRead.entries()].slice(0, 8);
    if (fileEntries.length > 0) {
      parts.push(
        `Files in memory:\n${fileEntries.map(([p, e]) => `  ${p}: ${e.signature}`).join('\n')}`
      );
    }
    return parts.join('\n');
  }
}

function extractSignature(content: string): string {
  const patterns = [
    /^[ \t]*export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^[ \t]*export\s+class\s+(\w+)/gm,
    /^[ \t]*export\s+interface\s+(\w+)/gm,
    /^[ \t]*export\s+const\s+(\w+)/gm,
    /^[ \t]*export\s+type\s+(\w+)/gm,
  ];
  const names: string[] = [];
  for (const p of patterns) {
    for (const m of content.matchAll(p)) {
      if (m[1]) names.push(m[1]);
    }
  }
  return names.slice(0, 20).join(', ');
}

function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
