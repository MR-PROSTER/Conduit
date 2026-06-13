import * as path from 'node:path';

import type { Awareness } from 'y-protocols/awareness';

export interface SafetyCheckResult {
  blocked: boolean;
  peerName: string | undefined;
  peerId: string | undefined;
}

/**
 * Checks Yjs awareness states before an agent edit to prevent overwriting
 * a teammate's live edits. This is an INTERNAL agent checkpoint — not a UI element.
 * Called inside AgentTools.edit_file() before every write.
 */
export class AgentSafetyLock {
  public constructor(private readonly awareness: Awareness) {}

  /**
   * Check if any peer is currently editing the given file.
   * Returns blocked=true if a conflict is detected.
   */
  public check(filePath: string): SafetyCheckResult {
    const normalizedTarget = this.normalizePath(filePath);
    const states = this.awareness.getStates();

    for (const [clientId, state] of states) {
      // Skip our own client
      if (clientId === this.awareness.clientID) continue;

      const activeFile = state['activeFile'] as string | undefined;
      if (!activeFile) continue;

      const normalizedPeer = this.normalizePath(activeFile);
      if (normalizedPeer === normalizedTarget) {
        return {
          blocked: true,
          peerName: (state['name'] as string | undefined) ?? 'A teammate',
          peerId: String(clientId),
        };
      }
    }

    return { blocked: false, peerName: undefined, peerId: undefined };
  }

  /**
   * Normalize a file path for comparison.
   * Strips leading ./ and converts to forward-slash lowercase form.
   */
  private normalizePath(filePath: string): string {
    return path.normalize(filePath)
      .replace(/\\/g, '/')
      .replace(/^\.\//u, '')
      .toLowerCase();
  }
}
