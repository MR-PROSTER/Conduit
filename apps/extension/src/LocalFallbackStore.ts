import * as vscode from "vscode";

import type { Draft } from "@conduit/shared-types";
import type { DraftMetadata } from "@conduit/collaboration-core";

const LOCAL_FALLBACKS_KEY = "conduit.localDraftFallbacks";

interface StoredLocalFallbackRecord {
  readonly draft: Draft;
  readonly reason: string;
  readonly savedAt: string;
  readonly workspacePath: string;
}

export class LocalFallbackStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async saveFallback(
    draft: Draft,
    reason: string,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<void> {
    const records = this.getRecords();
    records[draft.id] = {
      draft,
      reason,
      savedAt: new Date().toISOString(),
      workspacePath: workspaceFolder.uri.fsPath
    };
    await this.context.globalState.update(LOCAL_FALLBACKS_KEY, records);
  }

  public async clearFallback(draftId: string): Promise<void> {
    const records = this.getRecords();
    if (!(draftId in records)) {
      return;
    }

    delete records[draftId];
    await this.context.globalState.update(LOCAL_FALLBACKS_KEY, records);
  }

  public async recoverFallbacksForWorkspace(
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<readonly DraftMetadata[]> {
    const records = this.getRecords();
    const recovered: DraftMetadata[] = [];
    let hasCorruption = false;
    let changed = false;

    for (const [draftId, record] of Object.entries(records)) {
      if (!this.isStoredFallbackRecord(record)) {
        delete records[draftId];
        changed = true;
        hasCorruption = true;
        continue;
      }

      if (record.workspacePath !== workspaceFolder.uri.fsPath) {
        continue;
      }

      recovered.push({
        draft: record.draft,
        uri: vscode.Uri.joinPath(
          workspaceFolder.uri,
          ".conduit",
          "draft-fallbacks",
          `${record.draft.id}.json`
        ),
        source: "fallback"
      });
    }

    if (changed) {
      await this.context.globalState.update(LOCAL_FALLBACKS_KEY, records);
    }

    if (hasCorruption) {
      void vscode.window.showWarningMessage(
        "Conduit found corrupted local draft fallback data and skipped it safely."
      );
    }

    return recovered.sort((left, right) => {
      return right.draft.createdAt.localeCompare(left.draft.createdAt);
    });
  }

  public async hasUnresolvedFallbacks(
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<boolean> {
    const fallbacks = await this.recoverFallbacksForWorkspace(workspaceFolder);
    return fallbacks.some((fallback) => fallback.draft.status === "active");
  }

  private getRecords(): Record<string, unknown> {
    return (
      this.context.globalState.get<Record<string, unknown>>(
        LOCAL_FALLBACKS_KEY
      ) ?? {}
    );
  }

  private isStoredFallbackRecord(
    candidate: unknown
  ): candidate is StoredLocalFallbackRecord {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }

    const record = candidate as Partial<StoredLocalFallbackRecord>;
    return (
      typeof record.reason === "string" &&
      typeof record.savedAt === "string" &&
      typeof record.workspacePath === "string" &&
      this.isDraft(record.draft)
    );
  }

  private isDraft(candidate: unknown): candidate is Draft {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }

    const draft = candidate as Partial<Draft>;
    return (
      typeof draft.id === "string" &&
      typeof draft.sessionId === "string" &&
      typeof draft.roomId === "string" &&
      typeof draft.branch === "string" &&
      typeof draft.baseCommitHash === "string" &&
      typeof draft.yjsState === "string" &&
      Array.isArray(draft.filesystemOps) &&
      Array.isArray(draft.aiEvents) &&
      typeof draft.createdBy === "string" &&
      typeof draft.createdAt === "string" &&
      (draft.status === "active" ||
        draft.status === "applied" ||
        draft.status === "discarded")
    );
  }
}
