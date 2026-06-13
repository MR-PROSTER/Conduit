import * as path from "node:path";

import * as vscode from "vscode";
import * as Y from "yjs";

import type { Draft, FilesystemEvent } from "@conduit/shared-types";

import { FileManager } from "./FileManager.js";

const DRAFTS_DIRECTORY_SEGMENTS = [".conduit", "drafts"] as const;
const FALLBACK_DIRECTORY_SEGMENTS = [".conduit", "draft-fallbacks"] as const;

export type DraftRestoreStrategy = "merge" | "replace";

export type DraftFreshnessStatus =
  | "fresh"
  | "stale"
  | "diverged"
  | "branch-mismatch"
  | "workspace-behind-draft"
  | "unknown";

export type DraftConflictKind =
  | "stale"
  | "diverged"
  | "branch-mismatch"
  | "workspace-behind-draft"
  | "missing";

export interface DraftSaveOptions {
  readonly roomId: string;
  readonly sessionId: string;
  readonly branch: string;
  readonly baseCommitHash: string;
  readonly createdBy: string;
  readonly ydoc: Y.Doc;
  readonly filesystemOps: readonly FilesystemEvent[];
  readonly aiEvents?: readonly string[];
  readonly draftId?: string;
  readonly status?: Draft["status"];
  readonly lineage?: string;
  readonly createdAt?: string;
}

export interface DraftMetadata {
  readonly draft: Draft;
  readonly uri: vscode.Uri;
  readonly source: "draft" | "fallback" | "remote";
}

export interface DraftCompareResult {
  readonly relation:
    | "identical"
    | "same-lineage-newer"
    | "same-lineage-older"
    | "diverged"
    | "branch-mismatch";
  readonly newerDraftId: string | undefined;
  readonly olderDraftId: string | undefined;
}

export interface DraftFreshnessResult {
  readonly status: DraftFreshnessStatus;
  readonly currentBranch: string;
  readonly currentHead: string;
  readonly reason: string;
}

export interface DraftConflictResult {
  readonly outcome: "conflict";
  readonly kind: DraftConflictKind;
  readonly message: string;
  readonly fallbackUri: vscode.Uri | undefined;
}

export interface DraftRestoreSuccessResult {
  readonly outcome: "restored";
  readonly strategy: DraftRestoreStrategy;
  readonly draft: Draft;
  readonly freshness: DraftFreshnessResult;
}

export type DraftRestoreResult =
  | DraftRestoreSuccessResult
  | DraftConflictResult;

export interface DraftRestoreOptions {
  readonly sessionKey: string;
  readonly ydoc: Y.Doc;
  readonly fileManager: FileManager;
  readonly draft: Draft;
  readonly strategy: DraftRestoreStrategy;
  readonly currentBranch: string;
  readonly currentHead: string;
  readonly isAncestor?: (
    ancestor: string,
    descendant: string
  ) => Promise<boolean>;
}

interface LocalFallbackRecord {
  readonly savedAt: string;
  readonly reason: string;
  readonly draft: Draft;
}

export class DraftManager {
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();

  public constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder
  ) {}

  public async saveDraft(options: DraftSaveOptions): Promise<Draft> {
    const draft: Draft = {
      id: options.draftId ?? options.sessionId,
      sessionId: options.sessionId,
      roomId: options.roomId,
      branch: options.branch,
      baseCommitHash: options.baseCommitHash,
      yjsState: Buffer.from(Y.encodeStateAsUpdate(options.ydoc)).toString(
        "base64"
      ),
      filesystemOps: [...options.filesystemOps],
      aiEvents: [...(options.aiEvents ?? [])],
      createdBy: options.createdBy,
      createdAt: options.createdAt ?? new Date().toISOString(),
      status: options.status ?? "active",
      ...(options.lineage ? { lineage: options.lineage } : {})
    };

    const draftUri = this.getDraftUri(draft.id);

    try {
      await this.ensureDraftDirectories();
      await this.writeJsonFile(draftUri, draft);
    } catch (error) {
      await this.saveLocalFallback(
        draft,
        `Failed to persist collaborative draft: ${this.stringifyError(error)}`
      );
      throw error;
    }

    return draft;
  }

  public async generateDiff(left: Draft, right: Draft): Promise<string> {
    const leftFiles = this.readFilesFromDraft(left);
    const rightFiles = this.readFilesFromDraft(right);
    const allPaths = [
      ...new Set([...leftFiles.keys(), ...rightFiles.keys()])
    ].sort((a, b) => a.localeCompare(b));
    const chunks: string[] = [];

    for (const relativePath of allPaths) {
      const before = leftFiles.get(relativePath) ?? "";
      const after = rightFiles.get(relativePath) ?? "";
      if (before === after) {
        continue;
      }

      chunks.push(this.buildUnifiedDiff(relativePath, before, after));
    }

    return chunks.join("\n");
  }

  public async saveLocalFallback(
    draft: Draft,
    reason: string
  ): Promise<vscode.Uri> {
    const fallbackUri = this.getFallbackUri(draft.id);
    const fallbackRecord: LocalFallbackRecord = {
      savedAt: new Date().toISOString(),
      reason,
      draft
    };

    await this.ensureDraftDirectories();
    await this.writeJsonFile(fallbackUri, fallbackRecord);
    return fallbackUri;
  }

  public async discoverDrafts(): Promise<readonly DraftMetadata[]> {
    await this.ensureDraftDirectories();

    const [draftUris, fallbackUris] = await Promise.all([
      vscode.workspace.findFiles(
        this.getRelativeGlob(DRAFTS_DIRECTORY_SEGMENTS, "*.json"),
        "**/{node_modules,.git,dist,build}/**"
      ),
      vscode.workspace.findFiles(
        this.getRelativeGlob(FALLBACK_DIRECTORY_SEGMENTS, "*.json"),
        "**/{node_modules,.git,dist,build}/**"
      )
    ]);

    const discovered = await Promise.all([
      ...draftUris.map(async (uri) => {
        const draft = await this.readDraftFromUri(uri);
        return draft ? { draft, uri, source: "draft" as const } : undefined;
      }),
      ...fallbackUris.map(async (uri) => {
        const record = await this.readFallbackFromUri(uri);
        return record
          ? { draft: record.draft, uri, source: "fallback" as const }
          : undefined;
      })
    ]);

    return discovered
      .filter(
        (entry): entry is { draft: Draft; uri: vscode.Uri; source: "draft" | "fallback" } =>
          entry !== undefined
      )
      .sort((left, right) => {
        return right.draft.createdAt.localeCompare(left.draft.createdAt);
      });
  }

  public async restoreDraft(
    options: DraftRestoreOptions
  ): Promise<DraftRestoreResult> {
    const freshnessOptions: {
      readonly draft: Draft;
      readonly currentBranch: string;
      readonly currentHead: string;
      readonly isAncestor?: (
        ancestor: string,
        descendant: string
      ) => Promise<boolean>;
    } = {
      draft: options.draft,
      currentBranch: options.currentBranch,
      currentHead: options.currentHead
    };

    const freshness = await this.checkDraftFreshness({
      ...freshnessOptions,
      ...(options.isAncestor ? { isAncestor: options.isAncestor } : {})
    });

    if (freshness.status !== "fresh") {
      return this.handleDraftConflict(options.draft, freshness);
    }

    if (options.strategy === "merge") {
      await this.applyYjsState(options.ydoc, options.draft.yjsState);
    } else {
      await this.replaceYjsState(
        options.sessionKey,
        options.ydoc,
        options.fileManager,
        options.draft.yjsState
      );
    }

    await this.replayFilesystemOps(
      options.sessionKey,
      options.fileManager,
      options.draft.filesystemOps
    );
    await options.fileManager.syncSessionFilesToDisk(options.sessionKey);
    await this.updateDraftStatus(options.draft.id, "applied");
    await this.clearLocalFallback(options.draft.id);

    return {
      outcome: "restored",
      strategy: options.strategy,
      draft: {
        ...options.draft,
        status: "applied"
      },
      freshness
    };
  }

  public async applyYjsState(ydoc: Y.Doc, encodedState: string): Promise<void> {
    Y.applyUpdate(ydoc, this.decodeYjsState(encodedState), this);
  }

  public async replaceYjsState(
    sessionKey: string,
    targetDoc: Y.Doc,
    fileManager: FileManager,
    encodedState: string
  ): Promise<void> {
    const tempDoc = new Y.Doc();
    try {
      Y.applyUpdate(tempDoc, this.decodeYjsState(encodedState), this);

      const targetSession = fileManager.getOrCreate(sessionKey, targetDoc);
      const targetFiles = targetSession.files;
      const targetRegistry = targetSession.fileRegistry;
      const sourceFiles = tempDoc.getMap<Y.Text>("files");
      const sourceRegistry = tempDoc.getMap<string>("fileRegistry");

      targetDoc.transact(() => {
        for (const key of [...targetFiles.keys()]) {
          targetFiles.delete(key);
        }

        for (const key of [...targetRegistry.keys()]) {
          targetRegistry.delete(key);
        }

        for (const [relativePath, ytext] of sourceFiles.entries()) {
          const nextText = new Y.Text();
          const content = ytext.toString();
          if (content.length > 0) {
            nextText.insert(0, content);
          }

          targetFiles.set(relativePath, nextText);
        }

        for (const [entryKey, entryValue] of sourceRegistry.entries()) {
          targetRegistry.set(entryKey, entryValue);
        }
      }, this);
    } finally {
      tempDoc.destroy();
    }
  }

  public async replayFilesystemOps(
    sessionKey: string,
    fileManager: FileManager,
    filesystemOps: readonly FilesystemEvent[]
  ): Promise<void> {
    for (const operation of filesystemOps) {
      await this.replayOp(sessionKey, fileManager, operation);
    }
  }

  public async replayOp(
    sessionKey: string,
    fileManager: FileManager,
    filesystemOp: FilesystemEvent
  ): Promise<void> {
    await fileManager.onRemoteFilesystemEvent(sessionKey, filesystemOp);
  }

  public async handleDraftConflict(
    draft: Draft,
    freshness: DraftFreshnessResult
  ): Promise<DraftConflictResult> {
    const kind = this.toConflictKind(freshness.status);
    const fallbackUri = await this.saveLocalFallback(
      draft,
      `Draft restore blocked: ${freshness.reason}`
    );

    return {
      outcome: "conflict",
      kind,
      message: freshness.reason,
      fallbackUri
    };
  }

  public compareDrafts(left: Draft, right: Draft): DraftCompareResult {
    if (left.branch !== right.branch) {
      return {
        relation: "branch-mismatch",
        newerDraftId: undefined,
        olderDraftId: undefined
      };
    }

    if (
      left.baseCommitHash === right.baseCommitHash &&
      left.yjsState === right.yjsState &&
      JSON.stringify(left.filesystemOps) === JSON.stringify(right.filesystemOps)
    ) {
      return {
        relation: "identical",
        newerDraftId: undefined,
        olderDraftId: undefined
      };
    }

    const leftLineage = left.lineage ?? left.id;
    const rightLineage = right.lineage ?? right.id;
    if (leftLineage !== rightLineage) {
      return {
        relation: "diverged",
        newerDraftId: undefined,
        olderDraftId: undefined
      };
    }

    if (left.createdAt >= right.createdAt) {
      return {
        relation: "same-lineage-newer",
        newerDraftId: left.id,
        olderDraftId: right.id
      };
    }

    return {
      relation: "same-lineage-older",
      newerDraftId: right.id,
      olderDraftId: left.id
    };
  }

  public async checkDraftFreshness(options: {
    readonly draft: Draft;
    readonly currentBranch: string;
    readonly currentHead: string;
    readonly isAncestor?: (
      ancestor: string,
      descendant: string
    ) => Promise<boolean>;
  }): Promise<DraftFreshnessResult> {
    if (options.currentBranch !== options.draft.branch) {
      return {
        status: "branch-mismatch",
        currentBranch: options.currentBranch,
        currentHead: options.currentHead,
        reason: `Draft ${options.draft.id} targets branch ${options.draft.branch}, but the workspace is on ${options.currentBranch}.`
      };
    }

    if (
      options.draft.baseCommitHash.trim().length === 0 ||
      options.draft.baseCommitHash === "HEAD"
    ) {
      return {
        status: "fresh",
        currentBranch: options.currentBranch,
        currentHead: options.currentHead,
        reason:
          "Draft has no fixed base commit, so Conduit will restore it against the current workspace HEAD."
      };
    }

    if (options.currentHead === options.draft.baseCommitHash) {
      return {
        status: "fresh",
        currentBranch: options.currentBranch,
        currentHead: options.currentHead,
        reason: "Draft base commit matches the current workspace HEAD."
      };
    }

    if (!options.isAncestor) {
      return {
        status: "unknown",
        currentBranch: options.currentBranch,
        currentHead: options.currentHead,
        reason: `Draft ${options.draft.id} does not match HEAD and no ancestry checker was provided.`
      };
    }

    const draftIsAncestor = await options.isAncestor(
      options.draft.baseCommitHash,
      options.currentHead
    );
    if (draftIsAncestor) {
      return {
        status: "stale",
        currentBranch: options.currentBranch,
        currentHead: options.currentHead,
        reason: `Draft ${options.draft.id} is stale because ${options.draft.baseCommitHash} is behind ${options.currentHead}.`
      };
    }

    const workspaceIsAncestor = await options.isAncestor(
      options.currentHead,
      options.draft.baseCommitHash
    );
    if (workspaceIsAncestor) {
      return {
        status: "workspace-behind-draft",
        currentBranch: options.currentBranch,
        currentHead: options.currentHead,
        reason: `Workspace HEAD ${options.currentHead} is behind draft base ${options.draft.baseCommitHash}.`
      };
    }

    return {
      status: "diverged",
      currentBranch: options.currentBranch,
      currentHead: options.currentHead,
      reason: `Draft ${options.draft.id} diverged from workspace HEAD ${options.currentHead}.`
    };
  }

  public async discardDraft(draftId: string): Promise<void> {
    await this.updateDraftStatus(draftId, "discarded");
    await this.clearLocalFallback(draftId);
  }

  public async applyDraft(draftId: string): Promise<void> {
    await this.updateDraftStatus(draftId, "applied");
    await this.clearLocalFallback(draftId);
  }

  public async recoverLocalFallbacks(): Promise<readonly DraftMetadata[]> {
    await this.ensureDraftDirectories();

    const fallbackUris = await vscode.workspace.findFiles(
      this.getRelativeGlob(FALLBACK_DIRECTORY_SEGMENTS, "*.json"),
      "**/{node_modules,.git,dist,build}/**"
    );
    const recovered: DraftMetadata[] = [];

    for (const fallbackUri of fallbackUris) {
      const fallback = await this.readFallbackFromUri(fallbackUri);
      if (!fallback) {
        continue;
      }

      const draftUri = this.getDraftUri(fallback.draft.id);
      const draftExists = await this.pathExists(draftUri);
      if (!draftExists) {
        await this.writeJsonFile(draftUri, fallback.draft);
      }

      recovered.push({
        draft: fallback.draft,
        uri: draftUri,
        source: "draft"
      });

      await vscode.workspace.fs.delete(fallbackUri, {
        recursive: false,
        useTrash: false
      });
    }

    return recovered.sort((left, right) => {
      return right.draft.createdAt.localeCompare(left.draft.createdAt);
    });
  }

  private async updateDraftStatus(
    draftId: string,
    status: Draft["status"]
  ): Promise<void> {
    const draftUri = this.getDraftUri(draftId);
    const existingDraft = await this.readDraftFromUri(draftUri);
    if (!existingDraft) {
      return;
    }

    await this.writeJsonFile(draftUri, {
      ...existingDraft,
      status
    } satisfies Draft);
  }

  private async clearLocalFallback(draftId: string): Promise<void> {
    const fallbackUri = this.getFallbackUri(draftId);
    if (!(await this.pathExists(fallbackUri))) {
      return;
    }

    await vscode.workspace.fs.delete(fallbackUri, {
      recursive: false,
      useTrash: false
    });
  }

  public readFilesFromDraft(draft: Draft): Map<string, string> {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, this.decodeYjsState(draft.yjsState), this);
      const files = doc.getMap<Y.Text>("files");
      const nextFiles = new Map<string, string>();

      for (const [relativePath, ytext] of files.entries()) {
        nextFiles.set(relativePath, ytext.toString());
      }

      return nextFiles;
    } finally {
      doc.destroy();
    }
  }

  private buildUnifiedDiff(
    relativePath: string,
    before: string,
    after: string
  ): string {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const maxLineCount = Math.max(beforeLines.length, afterLines.length);
    const diffLines = [
      `diff --conduit a/${relativePath} b/${relativePath}`,
      `--- a/${relativePath}`,
      `+++ b/${relativePath}`
    ];

    for (let index = 0; index < maxLineCount; index += 1) {
      const previousLine = beforeLines[index];
      const nextLine = afterLines[index];

      if (previousLine === nextLine) {
        if (previousLine !== undefined) {
          diffLines.push(` ${previousLine}`);
        }
        continue;
      }

      if (previousLine !== undefined) {
        diffLines.push(`-${previousLine}`);
      }

      if (nextLine !== undefined) {
        diffLines.push(`+${nextLine}`);
      }
    }

    return diffLines.join("\n");
  }

  private async readDraftFromUri(uri: vscode.Uri): Promise<Draft | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const candidate = JSON.parse(
        this.textDecoder.decode(bytes)
      ) as Partial<Draft>;
      return this.isDraft(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  private async readFallbackFromUri(
    uri: vscode.Uri
  ): Promise<LocalFallbackRecord | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const candidate = JSON.parse(
        this.textDecoder.decode(bytes)
      ) as Partial<LocalFallbackRecord>;
      if (
        typeof candidate.savedAt !== "string" ||
        typeof candidate.reason !== "string" ||
        !candidate.draft ||
        !this.isDraft(candidate.draft)
      ) {
        return undefined;
      }

      return {
        savedAt: candidate.savedAt,
        reason: candidate.reason,
        draft: candidate.draft
      };
    } catch {
      return undefined;
    }
  }

  private isDraft(candidate: Partial<Draft>): candidate is Draft {
    return (
      typeof candidate.id === "string" &&
      typeof candidate.sessionId === "string" &&
      typeof candidate.roomId === "string" &&
      typeof candidate.branch === "string" &&
      typeof candidate.baseCommitHash === "string" &&
      typeof candidate.yjsState === "string" &&
      Array.isArray(candidate.filesystemOps) &&
      Array.isArray(candidate.aiEvents) &&
      typeof candidate.createdBy === "string" &&
      typeof candidate.createdAt === "string" &&
      (candidate.status === "active" ||
        candidate.status === "applied" ||
        candidate.status === "discarded")
    );
  }

  private async ensureDraftDirectories(): Promise<void> {
    await Promise.all([
      vscode.workspace.fs.createDirectory(this.getDraftsDirectory()),
      vscode.workspace.fs.createDirectory(this.getFallbackDirectory())
    ]);
  }

  private getDraftsDirectory(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      ...DRAFTS_DIRECTORY_SEGMENTS
    );
  }

  private getFallbackDirectory(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      ...FALLBACK_DIRECTORY_SEGMENTS
    );
  }

  private getDraftUri(draftId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getDraftsDirectory(), `${draftId}.json`);
  }

  private getFallbackUri(draftId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getFallbackDirectory(), `${draftId}.json`);
  }

  private getRelativeGlob(segments: readonly string[], suffix: string): string {
    const relativeRoot = vscode.workspace.asRelativePath(
      vscode.Uri.joinPath(this.workspaceFolder.uri, ...segments),
      false
    );
    return path.posix.join(relativeRoot.split(path.sep).join("/"), suffix);
  }

  private async writeJsonFile(uri: vscode.Uri, value: unknown): Promise<void> {
    await vscode.workspace.fs.writeFile(
      uri,
      this.textEncoder.encode(JSON.stringify(value, null, 2))
    );
  }

  private decodeYjsState(encodedState: string): Uint8Array {
    return Buffer.from(encodedState, "base64");
  }

  private async pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private toConflictKind(status: DraftFreshnessStatus): DraftConflictKind {
    switch (status) {
      case "stale":
        return "stale";
      case "diverged":
        return "diverged";
      case "branch-mismatch":
        return "branch-mismatch";
      case "workspace-behind-draft":
        return "workspace-behind-draft";
      default:
        return "missing";
    }
  }

  private stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
