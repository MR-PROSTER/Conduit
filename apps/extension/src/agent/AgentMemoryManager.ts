import crypto from "node:crypto";
import type {
  AgentDecision,
  AgentEdit,
  AgentMemory,
  AgentObservation,
  FileMemoryEntry,
} from "@codesync/shared-types";

type MemoryUpdate = Partial<AgentMemory>;

export class AgentMemoryManager {
  private currentMemory: AgentMemory | undefined;

  createMemory(taskId: string, goal: string): AgentMemory {
    const memory: AgentMemory = {
      taskId,
      goal,
      plan: "",
      decisions: [],
      filesRead: new Map(),
      searchResults: new Map(),
      observations: [],
      editsApplied: [],
      stashRef: null,
      iteration: 0,
    };

    this.currentMemory = memory;
    return memory;
  }

  updateMemory(memory: AgentMemory, updates: MemoryUpdate): AgentMemory {
    const next: AgentMemory = {
      ...memory,
      ...updates,
      filesRead: memory.filesRead,
      searchResults: memory.searchResults,
      decisions: memory.decisions,
      observations: memory.observations,
      editsApplied: memory.editsApplied,
    };

    this.currentMemory = next;
    return next;
  }

  addDecision(memory: AgentMemory, decision: Omit<AgentDecision, "iteration">): AgentMemory {
    return this.updateMemory(memory, {
      decisions: [...memory.decisions, { ...decision, iteration: memory.iteration }],
    });
  }

  addObservation(
    memory: AgentMemory,
    observation: Omit<AgentObservation, "iteration">
  ): AgentMemory {
    return this.updateMemory(memory, {
      observations: [...memory.observations, { ...observation, iteration: memory.iteration }],
    });
  }

  addEdit(memory: AgentMemory, edit: Omit<AgentEdit, "iteration">): AgentMemory {
    return this.updateMemory(memory, {
      editsApplied: [...memory.editsApplied, { ...edit, iteration: memory.iteration }],
    });
  }

  recordFileRead(memory: AgentMemory, filePath: string, content: string): AgentMemory {
    const entry: FileMemoryEntry = {
      path: filePath,
      signature: extractSignature(content),
      fullContent: content,
      hash: sha256(content),
      lastAccessed: new Date().toISOString(),
    };

    const nextFiles = new Map(memory.filesRead);
    nextFiles.set(filePath, entry);
    return this.updateMemory(memory, { filesRead: nextFiles });
  }

  compressMemory(memory: AgentMemory): AgentMemory {
    const nextFiles = new Map<string, FileMemoryEntry>();

    for (const [filePath, entry] of memory.filesRead) {
      nextFiles.set(filePath, {
        ...entry,
        fullContent: null,
      });
    }

    const compressed = this.updateMemory(memory, { filesRead: nextFiles });
    this.currentMemory = compressed;
    return compressed;
  }

  getCurrentMemory(): AgentMemory | undefined {
    return this.currentMemory;
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
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        names.push(match[1]);
      }
    }
  }

  return names.length > 0 ? names.slice(0, 20).join(", ") : content.slice(0, 120).trim();
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
