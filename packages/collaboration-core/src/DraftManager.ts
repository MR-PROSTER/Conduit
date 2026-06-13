import { Buffer } from "node:buffer";
import * as Y from "yjs";
import type { Draft, FilesystemEvent, Session } from "@codesync/shared-types";
import { FileManager } from "./FileManager.js";

export interface DraftConflictResult {
  hasConflict: boolean;
  conflictReasons: readonly string[];
  existingDraftId?: string;
  incomingDraftId?: string;
}

export interface DraftFreshnessResult {
  isFresh: boolean;
  isStale: boolean;
  draftBaseCommitHash: string;
  currentHead: string;
}

export interface DraftManagerOptions {
  backendUrl: string;
  fileManager: FileManager;
  fetcher?: typeof fetch;
}

export class DraftManager {
  private readonly fetcher: typeof fetch;
  private readonly localFallbackDrafts = new Map<string, Draft>();

  constructor(private readonly options: DraftManagerOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async saveDraft(
    doc: Y.Doc,
    session: Session,
    filesystemOps: readonly FilesystemEvent[],
    aiEvents: readonly string[],
  ): Promise<Draft> {
    const encodedState = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    const draft: Draft = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      roomId: session.roomId,
      branch: session.branch,
      baseCommitHash: session.baseCommitHash,
      yjsState: encodedState,
      filesystemOps,
      aiEvents,
      createdBy: session.participants[0] ?? "",
      createdAt: new Date().toISOString(),
      status: "active",
    };

    const response = await this.fetcher(`${this.options.backendUrl}/drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(draft),
    });

    if (response.ok) {
      const payload = (await response.json().catch(() => null)) as Partial<Draft> | null;
      const savedDraft = payload ? { ...draft, ...payload } : draft;
      this.localFallbackDrafts.set(savedDraft.id, savedDraft);
      return savedDraft;
    }

    this.localFallbackDrafts.set(draft.id, draft);
    return draft;
  }

  async restoreDraft(draft: Draft, doc: Y.Doc): Promise<void> {
    this.applyYjsState(doc, draft);
    this.replayFilesystemOps(draft.filesystemOps);
    await this.options.fileManager.flushToDisk();
    await this.updateDraftStatus(draft.id, "applied");
    this.clearLocalFallback(draft.id);
  }

  detectConflict(existing: Draft, incoming: Draft): DraftConflictResult {
    const conflictReasons: string[] = [];
    if (existing.sessionId !== incoming.sessionId) {
      conflictReasons.push("session_mismatch");
    }
    if (existing.branch !== incoming.branch) {
      conflictReasons.push("branch_mismatch");
    }
    if (existing.baseCommitHash !== incoming.baseCommitHash) {
      conflictReasons.push("base_commit_mismatch");
    }

    return {
      hasConflict: conflictReasons.length > 0,
      conflictReasons,
      existingDraftId: existing.id,
      incomingDraftId: incoming.id,
    };
  }

  checkFreshness(draft: Draft, currentHead: string): DraftFreshnessResult {
    const isFresh = draft.baseCommitHash === currentHead;
    return {
      isFresh,
      isStale: !isFresh,
      draftBaseCommitHash: draft.baseCommitHash,
      currentHead,
    };
  }

  private applyYjsState(doc: Y.Doc, draft: Draft): void {
    if (!draft.yjsState) {
      return;
    }
    const update = Buffer.from(draft.yjsState, "base64");
    Y.applyUpdate(doc, update);
  }

  private replayFilesystemOps(filesystemOps: readonly FilesystemEvent[]): void {
    for (const op of filesystemOps) {
      this.options.fileManager.applyFilesystemOp(op);
    }
  }

  private async updateDraftStatus(draftId: string, status: Draft["status"]): Promise<void> {
    await this.fetcher(`${this.options.backendUrl}/drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ status }),
    }).catch(() => undefined);
  }

  private clearLocalFallback(draftId: string): void {
    this.localFallbackDrafts.delete(draftId);
  }
}
