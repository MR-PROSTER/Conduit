import * as path from "node:path";

export interface SafetyCheckResult {
  blocked: boolean;
  peerName?: string;
}

/**
 * Tracks file-level write locks derived from peer awareness state.
 * The lock table is keyed by normalized file path and stores the peer name.
 */
export class AgentSafetyLock {
  private readonly lockTable = new Map<string, string>();

  check(filePath: string): SafetyCheckResult {
    const peerName = this.lockTable.get(this.normalizePath(filePath));
    if (!peerName) {
      return { blocked: false };
    }

    return {
      blocked: true,
      peerName,
    };
  }

  update(peerEdits: Map<string, string>): void {
    this.lockTable.clear();

    for (const [peerName, filePath] of peerEdits) {
      const normalized = this.normalizePath(filePath);
      if (!normalized) {
        continue;
      }

      this.lockTable.set(normalized, peerName);
    }
  }

  private normalizePath(filePath: string): string {
    return path
      .normalize(filePath)
      .replace(/\\/g, "/")
      .replace(/^\.\//u, "")
      .replace(/^\/+/, "")
      .toLowerCase();
  }
}
