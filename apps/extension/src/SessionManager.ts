import * as vscode from "vscode";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";

import {
  DraftManager,
  type DraftCompareResult,
  type DraftFreshnessResult,
  type DraftMetadata,
  type DraftRestoreResult,
  type DraftRestoreStrategy
} from "@conduit/collaboration-core";
import {
  CursorManager,
  type RemoteCursorState
} from "@conduit/collaboration-core/CursorManager";
import { FileManager } from "@conduit/collaboration-core/FileManager";
import {
  GitService,
  GitServiceError,
  type GitCommitResult,
  type GitStashResult
} from "@conduit/git-core";

import {
  BroadcastHub,
  type CollaborationSnapshot,
  type CollaboratorPresence,
  type ConnectionState
} from "./broadcast.js";
import {
  type BranchSessionRecord,
  type BranchSessionRegistry
} from "./BranchSessionRegistry.js";
import { AuthService } from "./AuthService.js";
import { LocalFallbackStore } from "./LocalFallbackStore.js";
import { buildRoomKey, createSessionId } from "./sessionKeys.js";

import type {
  Draft,
  FilesystemEvent,
  Room,
  Session
} from "@conduit/shared-types";

export interface RealtimeSessionTarget {
  readonly room: Room;
  readonly session: Session;
  readonly websocketUrl: string;
  readonly localUserId: string;
  readonly localUserName: string;
  readonly accessToken?: string;
}

export interface WsClientState {
  readonly room: Room | undefined;
  readonly session: Session | undefined;
  readonly websocketUrl: string | undefined;
  readonly connectionState: ConnectionState;
  readonly participantCount: number;
  readonly collaborators: readonly CollaboratorPresence[];
  readonly lastError: string | undefined;
}

interface ActiveRealtimeSession {
  readonly room: Room;
  readonly session: Session;
  readonly roomKey: string;
  readonly websocketUrl: string;
  readonly localUserId: string;
  readonly localUserName: string;
  readonly accessToken?: string;
  readonly repoPath: string;
  readonly gitService: GitService;
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;
  readonly awareness: Awareness;
  readonly fileManager: FileManager;
  readonly filesystemOpLog: Y.Array<string>;
  readonly seenFilesystemOpIds: Set<string>;
  readonly suppressedFilesystemPaths: Map<string, number>;
  readonly cursorManager: CursorManager;
  readonly disposables: vscode.Disposable[];
  readonly autoStashRefs: string[];
  readonly lifecycleToken: number;
  filesystemEventQueue: Promise<void>;
  nextFilesystemOpSequence: number;
}

interface AwarenessUserState {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly role?: string;
}

interface AwarenessEnvelope {
  readonly user?: AwarenessUserState;
  readonly cursor?: RemoteCursorState;
}

interface FilesystemOperationRecord {
  readonly id: string;
  readonly clientId: number;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: FilesystemEvent;
}

interface ValidatedSessionTarget {
  readonly room: Room;
  readonly session: Session;
  readonly websocketUrl: string;
  readonly localUserId: string;
  readonly localUserName: string;
  readonly accessToken?: string;
  readonly repoPath: string;
  readonly gitService: GitService;
  readonly stashedRefs: readonly string[];
}

export type RemoteDraftSaver = (
  draft: Draft,
  accessToken: string
) => Promise<Draft>;

export type RemoteDraftStatusUpdater = (
  draftId: string,
  status: Draft["status"],
  accessToken: string
) => Promise<Draft>;

export type RemoteDraftLister = (
  options: {
    readonly roomId: string;
    readonly branch?: string;
    readonly status?: Draft["status"];
  },
  accessToken: string
) => Promise<readonly Draft[]>;

export class SessionManager implements vscode.Disposable {
  // The SessionManager is responsible for managing the lifecycle of collaborative sessions, including Git state validation, Yjs provider connections, and broadcasting session state to the rest of the extension. It maintains a single active session at a time and provides methods for creating, joining, leaving, and switching sessions.
  private readonly disposables: vscode.Disposable[] = [];
  private activeSession: ActiveRealtimeSession | undefined;
  private lifecycleToken = 0;
  private isDisposed = false;
  private lastRealtimeIdentity:
    | {
      readonly websocketUrl: string;
      readonly localUserId: string;
      readonly localUserName: string;
      readonly accessToken?: string;
    }
    | undefined;
  private state: WsClientState = {
    room: undefined,
    session: undefined,
    websocketUrl: undefined,
    connectionState: "disconnected",
    participantCount: 0,
    collaborators: [],
    lastError: undefined
  };

  private authService: AuthService | undefined;

  public setAuthService(authService: AuthService): void {
    this.authService = authService;
  }

  public constructor(
    private readonly broadcastHub: BroadcastHub,
    private readonly branchSessionRegistry: BranchSessionRegistry,
    private readonly localFallbackStore: LocalFallbackStore,
    private readonly remoteDraftSaver?: RemoteDraftSaver,
    private readonly remoteDraftStatusUpdater?: RemoteDraftStatusUpdater,
    private readonly remoteDraftLister?: RemoteDraftLister
  ) { }

  public getState(): WsClientState {
    return this.state;
  }

  public getActiveDoc(): Y.Doc | undefined {
    return this.activeSession?.doc;
  }

  public getActiveAwareness(): Awareness | undefined {
    return this.activeSession?.awareness;
  }

  public async createSession(target: RealtimeSessionTarget): Promise<void> {
    this.ensureNotDisposed();
    this.lastRealtimeIdentity = {
      websocketUrl: target.websocketUrl,
      localUserId: target.localUserId,
      localUserName: target.localUserName,
      ...(target.accessToken ? { accessToken: target.accessToken } : {})
    };
    this.validateBranchName(target.session.branch);
    await this.branchSessionRegistry.discoverSessions(
      target.websocketUrl,
      target.room,
      target.accessToken
    );
    const sessionTarget = this.resolveSessionTarget(target, true);
    const validatedTarget = await this.validateGitState(sessionTarget);
    await this.connectYjs(validatedTarget);
  }

  public async joinSession(target: RealtimeSessionTarget): Promise<void> {
    this.ensureNotDisposed();
    this.lastRealtimeIdentity = {
      websocketUrl: target.websocketUrl,
      localUserId: target.localUserId,
      localUserName: target.localUserName,
      ...(target.accessToken ? { accessToken: target.accessToken } : {})
    };
    this.validateBranchName(target.session.branch);
    const validatedTarget = await this.validateGitState(target);
    await this.connectYjs(validatedTarget);
  }

  public async leaveGraceful(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    await this.teardownSession(this.activeSession, {
      ...(this.activeSession
        ? { logMessage: `Disconnected from ${this.activeSession.roomKey}` }
        : {})
    });
  }

  public async leaveUnexpected(reason?: string): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    if (this.activeSession) {
      try {
        const draft = await this.saveDraftFromSession();
        const workspaceFolder = this.getWorkspaceFolderForRepo(
          this.activeSession.repoPath
        );
        await this.localFallbackStore.saveFallback(
          draft,
          reason ?? "Unexpected shutdown",
          workspaceFolder
        );
      } catch (error) {
        this.broadcastHub.log(
          "error",
          `Failed to save unexpected-leave draft: ${this.stringifyError(error)}`
        );
      }
    }

    await this.teardownSession(this.activeSession, {
      nextConnectionState: "error",
      lastError: reason ?? "Session ended unexpectedly.",
      logLevel: "warn",
      ...(reason ? { logMessage: reason } : {})
    });
  }

  public async switchBranch(branch: string): Promise<void> {
    this.ensureNotDisposed();
    const session = this.activeSession;
    if (!session) {
      throw new Error("No active session exists.");
    }

    this.validateBranchName(branch);
    const token = await this.getFreshToken() || session.accessToken;
    await this.branchSessionRegistry.discoverSessions(
      session.websocketUrl,
      session.room,
      token
    );

    const branchSession = this.branchSessionRegistry.getPreferredSession(
      session.room.id,
      branch
    );
    const nextTarget: RealtimeSessionTarget = {
      room: {
        ...session.room,
        defaultBranch: branch
      },
      session: branchSession?.session ?? {
        ...session.session,
        id: createSessionId(),
        branch,
        participants: [session.localUserId],
        status: "active"
      },
      websocketUrl: session.websocketUrl,
      localUserId: session.localUserId,
      localUserName: session.localUserName,
      ...(token ? { accessToken: token } : {})
    };
    const validatedTarget = await this.validateGitState(nextTarget);
    await this.connectYjs(validatedTarget);
  }

  public async listBranches(): Promise<readonly string[]> {
    const gitService = new GitService({
      repoPath: this.getRepoPath()
    });
    const branches = await gitService.listBranches(false);
    return branches
      .map((branch) => branch.name)
      .sort((left, right) => {
        return left.localeCompare(right);
      });
  }

  public async getCurrentBranch(): Promise<string | undefined> {
    const gitService = new GitService({
      repoPath: this.getRepoPath()
    });
    const currentBranch = await gitService.getCurrentBranch();
    return currentBranch.branch;
  }

  public async restoreSession(options: {
    readonly websocketUrl: string;
    readonly localUserId: string;
    readonly localUserName: string;
    readonly accessToken?: string;
  }): Promise<boolean> {
    this.ensureNotDisposed();
    const currentBranch = await this.getCurrentBranch();
    if (!currentBranch) {
      return false;
    }

    const sessions = this.branchSessionRegistry.listSessions().filter((entry) => {
      return (
        entry.session.branch === currentBranch &&
        entry.session.status !== "discarded"
      );
    });

    let restorableSession: BranchSessionRecord | undefined;
    for (const entry of sessions) {
      if (await this.matchesCurrentWorkspace(entry.room)) {
        restorableSession = entry;
        break;
      }
    }

    if (!restorableSession) {
      return false;
    }

    try {
      await this.joinSession({
        room: restorableSession.room,
        session: restorableSession.session,
        websocketUrl: restorableSession.websocketUrl || options.websocketUrl,
        localUserId: options.localUserId,
        localUserName: options.localUserName,
        ...(options.accessToken ? { accessToken: options.accessToken } : {})
      });
      return true;
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to auto-restore session ${restorableSession.roomKey}: ${this.stringifyError(error)}`
      );
      if (this.state.connectionState === "error") {
        this.updateState({
          ...this.state,
          connectionState: "disconnected",
          lastError: undefined
        });
      }
      return false;
    }
  }

  public async discoverSessions(
    websocketUrl: string,
    accessToken?: string
  ): Promise<readonly BranchSessionRecord[]> {
    if (this.isDisposed) {
      return [];
    }

    return this.branchSessionRegistry.discoverSessions(
      websocketUrl,
      this.activeSession?.room,
      accessToken
    );
  }

  public async discoverDrafts(): Promise<readonly DraftMetadata[]> {
    if (this.isDisposed) {
      return [];
    }

    const draftManager = this.getDraftManager();
    await draftManager.recoverLocalFallbacks();

    // Pull remote drafts from backend (for all room members) if we have an active session
    if (this.activeSession) {
      await this.fetchDraftsFromBackend(this.activeSession, draftManager);
    }

    const workspaceFolder = this.getWorkspaceFolderForRepo(this.getRepoPath());
    const [filesystemDrafts, localFallbackDrafts, remoteDrafts] =
      await Promise.all([
        draftManager.discoverDrafts(),
        this.localFallbackStore.recoverFallbacksForWorkspace(workspaceFolder),
        this.discoverRemoteDrafts()
      ]);
    const drafts = this.mergeDraftMetadata(
      [...filesystemDrafts, ...remoteDrafts],
      localFallbackDrafts
    );
    this.syncDiscoveredDrafts(drafts);
    return drafts;
  }

  public async recoverLocalFallbacks(): Promise<readonly DraftMetadata[]> {
    if (this.isDisposed) {
      return [];
    }

    const workspaceFolder = this.getWorkspaceFolderForRepo(this.getRepoPath());
    const localFallbacks =
      await this.localFallbackStore.recoverFallbacksForWorkspace(
        workspaceFolder
      );
    this.syncDiscoveredDrafts(localFallbacks);
    return localFallbacks;
  }

  public async checkDraftFreshness(
    draftId: string
  ): Promise<DraftFreshnessResult> {
    const draft = await this.requireDraftById(draftId);
    const gitService =
      this.activeSession?.gitService ??
      new GitService({
        repoPath: this.getRepoPath()
      });
    const currentBranch = await this.getCurrentBranch();
    const currentHead = await gitService.getHead();

    return this.getDraftManager().checkDraftFreshness({
      draft: draft.draft,
      currentBranch: currentBranch ?? "",
      currentHead,
      isAncestor: async (ancestor: string, descendant: string) => {
        return gitService.isAncestor(ancestor, descendant);
      }
    });
  }

  public async compareDrafts(
    leftDraftId: string,
    rightDraftId: string
  ): Promise<{
    readonly comparison: DraftCompareResult;
    readonly diff: string;
  }> {
    const drafts = await this.discoverDrafts();
    const leftDraftMetadata = drafts.find((entry) => entry.draft.id === leftDraftId);
    const rightDraftMetadata = drafts.find((entry) => entry.draft.id === rightDraftId);
    if (!leftDraftMetadata || !rightDraftMetadata) {
      throw new Error("One or more selected drafts could not be found.");
    }

    let leftDraft = leftDraftMetadata.draft;
    let rightDraft = rightDraftMetadata.draft;

    const token = await this.getFreshToken() || this.activeSession?.accessToken;

    if (leftDraftMetadata.source === "remote" && this.authService && token) {
      leftDraft = await this.authService.getDraft(leftDraftId, token);
    }
    if (rightDraftMetadata.source === "remote" && this.authService && token) {
      rightDraft = await this.authService.getDraft(rightDraftId, token);
    }

    const draftManager = this.getDraftManager();
    return {
      comparison: draftManager.compareDrafts(leftDraft, rightDraft),
      diff: await draftManager.generateDiff(leftDraft, rightDraft)
    };
  }

  public async discardDraft(draftId: string): Promise<void> {
    const draftManager = this.getDraftManager();
    await draftManager.discardDraft(draftId);
    await this.localFallbackStore.clearFallback(draftId);
    await this.updateRemoteDraftStatus(draftId, "discarded");
    this.syncDiscoveredDrafts(await draftManager.discoverDrafts());
  }

  public async applyDraft(draftId: string): Promise<void> {
    const draftManager = this.getDraftManager();
    await draftManager.applyDraft(draftId);
    await this.localFallbackStore.clearFallback(draftId);
    await this.updateRemoteDraftStatus(draftId, "applied");
    this.syncDiscoveredDrafts(await draftManager.discoverDrafts());
  }

  public async restoreDraft(
    draftId: string,
    strategy: DraftRestoreStrategy
  ): Promise<DraftRestoreResult> {
    const draftMetadata = await this.requireDraftById(draftId);
    await this.ensureActiveSessionForDraft(draftMetadata.draft);

    const session = this.requireActiveSession();
    if (strategy === "replace" && !this.isLastParticipant(session)) {
      throw new Error(
        "Replace restore is only available when you are the sole participant in the collaborative session."
      );
    }

    let draftToRestore = draftMetadata.draft;
    if (draftMetadata.source === "remote") {
      if (!this.authService) {
        throw new Error("AuthService is not initialized. Cannot retrieve remote draft.");
      }
      const token = await this.getFreshToken() || session.accessToken;
      if (!token) {
        throw new Error("No active session access token available.");
      }
      const fullDraft = await this.authService.getDraft(draftId, token);
      draftToRestore = fullDraft;
    }

    const restoreResult = await this.getDraftManager().restoreDraft({
      sessionKey: session.roomKey,
      ydoc: session.doc,
      fileManager: session.fileManager,
      draft: draftToRestore,
      strategy,
      currentBranch: (await this.getCurrentBranch()) ?? "",
      currentHead: await session.gitService.getHead(),
      isAncestor: async (ancestor: string, descendant: string) => {
        return session.gitService.isAncestor(ancestor, descendant);
      }
    });

    await this.bindEditors(session);
    await this.localFallbackStore.clearFallback(draftMetadata.draft.id);
    if (restoreResult.outcome === "restored") {
      await this.updateRemoteDraftStatus(draftMetadata.draft.id, "applied");
    }
    this.syncDiscoveredDrafts(await this.getDraftManager().discoverDrafts());
    return restoreResult;
  }

  public canReplaceDraftState(): boolean {
    return this.activeSession
      ? this.isLastParticipant(this.activeSession)
      : false;
  }

  public async validateGitState(
    target: RealtimeSessionTarget
  ): Promise<ValidatedSessionTarget> {
    const repoPath = this.getRepoPath();
    const gitService = new GitService({
      repoPath
    });
    const stashedRefs: string[] = [];

    await gitService.getHead();
    const roomRepoUrl = target.room.repoUrl.trim();
    const remoteUrl = await gitService.getRepoRemoteUrl();

    if (roomRepoUrl.length > 0) {
      if (this.isLocalWorkspaceUrl(roomRepoUrl)) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const localWorkspaceUrl = workspaceFolder?.uri.toString();
        if (localWorkspaceUrl) {
          try {
            const uri1 = vscode.Uri.parse(roomRepoUrl).fsPath.toLowerCase();
            const uri2 = vscode.Uri.parse(localWorkspaceUrl).fsPath.toLowerCase();
            if (uri1 !== uri2) {
              this.broadcastHub.log(
                "warn",
                `Repository path mismatch: room is configured for ${roomRepoUrl} but local workspace is ${localWorkspaceUrl}. Proceeding anyway.`
              );
            }
          } catch {
            // Ignore parsing error
          }
        }
      } else {
        if (!remoteUrl) {
          throw new Error(
            `Repository validation failed: expected remote ${roomRepoUrl} but no Git remote was found.`
          );
        }

        if (this.normalizeGitUrl(remoteUrl) !== this.normalizeGitUrl(roomRepoUrl)) {
          throw new Error(
            `Repository validation failed: expected ${roomRepoUrl} but found ${remoteUrl}.`
          );
        }
      }
    }

    const currentBranch = await gitService.getCurrentBranch();
    if (currentBranch.branch !== target.session.branch) {
      const stashResult = await this.handleDirtyWorkingTree(
        gitService,
        `before switching to branch ${target.session.branch}`
      );
      if (stashResult?.stashRef) {
        stashedRefs.push(stashResult.stashRef);
      }

      await this.checkoutBranchForSession(gitService, target.session.branch);
    }

    const branchHead = await gitService.getHead();
    const expectedAncestorSha =
      target.session.baseCommitHash === "HEAD"
        ? branchHead
        : target.session.baseCommitHash;
    const isAncestor = await gitService.isAncestor(expectedAncestorSha, "HEAD");
    if (!isAncestor) {
      throw new Error(
        `Commit ancestry validation failed: ${expectedAncestorSha} is not an ancestor of HEAD on ${target.session.branch}.`
      );
    }

    const postCheckoutStatus = await gitService.getStatus();
    if (!postCheckoutStatus.clean) {
      const stashResult = await this.handleDirtyWorkingTree(
        gitService,
        `before connecting to session ${target.session.id}`
      );
      if (stashResult?.stashRef) {
        stashedRefs.push(stashResult.stashRef);
      }
    }

    const finalStatus = await gitService.getStatus();
    if (!finalStatus.clean) {
      throw new Error(
        `Working tree validation failed: session ${target.session.id} requires a clean workspace.`
      );
    }

    const normalizedHead = await gitService.getHead();
    const normalizedSession: Session = {
      ...target.session,
      baseCommitHash: normalizedHead
    };

    return {
      room: target.room,
      session: normalizedSession,
      websocketUrl: target.websocketUrl,
      localUserId: target.localUserId,
      localUserName: target.localUserName,
      ...(target.accessToken ? { accessToken: target.accessToken } : {}),
      repoPath,
      gitService,
      stashedRefs
    };
  }

  public async handleDirtyWorkingTree(
    gitService: GitService,
    reason: string
  ): Promise<GitStashResult | undefined> {
    const status = await gitService.getStatus();
    if (status.clean) {
      return undefined;
    }

    const stashResult = await gitService.stash(`[conduit] ${reason}`);
    if (stashResult.created) {
      this.broadcastHub.log(
        "warn",
        `Stashed local changes ${reason}${stashResult.stashRef ? ` (${stashResult.stashRef})` : ""}`
      );
    }

    return stashResult;
  }

  public async commitSession(message: string): Promise<GitCommitResult> {
    const session = this.requireActiveSession();
    await session.fileManager.syncSessionFilesToDisk(session.roomKey);
    const commitResult = await session.gitService.commit(message, {
      all: true
    });
    const nextSession: Session = {
      ...session.session,
      baseCommitHash: commitResult.sha
    };
    this.setActiveSession({
      ...session,
      session: nextSession
    });

    this.broadcastHub.log(
      "info",
      `Committed session ${nextSession.id} at ${commitResult.sha}`
    );
    return commitResult;
  }

  public async saveDraftFromSession(options?: { readonly onlyRemote?: boolean }): Promise<Draft> {
    this.ensureNotDisposed();
    const session = this.requireActiveSession();
    const draftManager = this.getDraftManager(session.repoPath);
    const existingDraft = (await draftManager.discoverDrafts()).find(
      (draft) => {
        return (
          draft.draft.sessionId === session.session.id &&
          draft.draft.status === "active"
        );
      }
    );

    const draftData = {
      draftId: session.session.id,
      sessionId: session.session.id,
      roomId: session.room.id,
      branch: session.session.branch,
      baseCommitHash: session.session.baseCommitHash,
      createdBy: session.localUserId,
      ydoc: session.doc,
      filesystemOps: this.getFilesystemOperationsFromSession(session),
      aiEvents: [] as string[],
      ...(existingDraft
        ? {
          lineage: existingDraft.draft.lineage ?? existingDraft.draft.id
        }
        : {})
    };

    let draft: Draft;
    if (options?.onlyRemote) {
      draft = {
        id: draftData.draftId,
        sessionId: draftData.sessionId,
        roomId: draftData.roomId,
        branch: draftData.branch,
        baseCommitHash: draftData.baseCommitHash,
        yjsState: Buffer.from(Y.encodeStateAsUpdate(draftData.ydoc)).toString("base64"),
        filesystemOps: [...draftData.filesystemOps],
        aiEvents: [...draftData.aiEvents],
        createdBy: draftData.createdBy,
        createdAt: new Date().toISOString(),
        status: "active",
        ...(draftData.lineage ? { lineage: draftData.lineage } : {})
      };
    } else {
      draft = await draftManager.saveDraft(draftData);
    }

    const token = await this.getFreshToken() || session.accessToken;
    const persistedDraft =
      token && this.remoteDraftSaver
        ? await this.remoteDraftSaver(draft, token)
        : draft;

    if (!options?.onlyRemote) {
      this.branchSessionRegistry.upsertDraft({
        id: persistedDraft.id,
        branch: persistedDraft.branch,
        status: persistedDraft.status,
        sessionId: persistedDraft.sessionId,
        createdBy: persistedDraft.createdBy,
        createdAt: persistedDraft.createdAt,
        workspacePath: this.getDraftWorkspacePath(
          session.repoPath,
          persistedDraft.id
        )
      });
    }

    this.broadcastHub.log(
      "info",
      `Saved draft for session ${session.session.id}${token && this.remoteDraftSaver
        ? " to Supabase"
        : " locally"
      }`
    );
    // Persist the draft to Supabase (fire-and-forget)
    void this.persistDraftToBackend(session, draft);

    return persistedDraft;
  }


  public async discardSession(): Promise<void> {
    this.ensureNotDisposed();
    const session = this.requireActiveSession();
    const workspaceFolder = this.getWorkspaceFolderForRepo(session.repoPath);
    const draftUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      ".conduit",
      "drafts",
      `${session.session.id}.json`
    );

    try {
      await vscode.workspace.fs.delete(draftUri, {
        recursive: false,
        useTrash: false
      });
    } catch {
      // Ignore missing drafts during discard.
    }

    try {
      await this.updateRemoteDraftStatus(session.session.id, "discarded");
      await this.localFallbackStore.clearFallback(session.session.id);
    } catch {
      // Ignore remote/fallback cleanup failures during discard
    }

    await this.teardownSession(session, {
      logMessage: `Discarded session ${session.session.id}`
    });
  }

  public async waitForYjsSync(session = this.activeSession): Promise<void> {
    if (!session) {
      throw new Error("No active realtime session is available for sync.");
    }

    if (session.provider.synced) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Timed out waiting for Yjs sync for ${session.roomKey}`)
        );
      }, 60_000);

      const handleSync = (isSynced: boolean): void => {
        if (!isSynced) {
          return;
        }

        cleanup();
        resolve();
      };

      const handleStatus = (event: {
        readonly status: "connecting" | "connected" | "disconnected";
      }): void => {
        if (event.status === "disconnected") {
          cleanup();
          reject(
            new Error(`Disconnected before initial sync for ${session.roomKey}`)
          );
        }
      };

      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        session.provider.off("sync", handleSync);
        session.provider.off("status", handleStatus);
      };

      session.provider.on("sync", handleSync);
      session.provider.on("status", handleStatus);
    });
  }

  public isLastParticipant(session = this.activeSession): boolean {
    if (!session) {
      return true;
    }

    const remoteParticipantCount = [...session.awareness.getStates().keys()]
      .length;
    return remoteParticipantCount <= 1;
  }

  public async connectYjs(target: ValidatedSessionTarget): Promise<void> {
    this.ensureNotDisposed();
    await this.teardownSession(this.activeSession);
    const lifecycleToken = ++this.lifecycleToken;

    const roomKey = buildRoomKey(
      target.room.id,
      target.session.branch,
      target.session.id
    );
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const provider = new WebsocketProvider(target.websocketUrl, roomKey, doc, {
      connect: false,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      awareness,
      params: {
        roomId: target.room.id,
        branch: target.session.branch,
        sessionId: target.session.id,
        ...(target.accessToken ? { token: target.accessToken } : {})
      }
    });

    const originalConnect = provider.connect.bind(provider);
    provider.connect = () => {
      this.getFreshToken().then((token) => {
        if (token) {
          try {
            const urlObj = new URL(provider.url);
            urlObj.searchParams.set("token", token);
            Object.defineProperty(provider, "url", {
              value: urlObj.toString(),
              configurable: true,
              writable: true,
              enumerable: true
            });
          } catch (error) {
            this.broadcastHub.log("error", `[WS-CLIENT-DEBUG] Failed to update websocket token URL: ${error}`);
          }
        }
        originalConnect();
      }).catch((err) => {
        this.broadcastHub.log("error", `[WS-CLIENT-DEBUG] Error getting fresh token before connect: ${err}`);
        originalConnect();
      });
    };

    provider.on("status", (event: { status: string }) => {
      this.broadcastHub.log("info", `[WS-CLIENT-DEBUG] Provider status: ${event.status}`);
    });

    provider.on("sync", (isSynced: boolean) => {
      this.broadcastHub.log("info", `[WS-CLIENT-DEBUG] Provider sync: ${isSynced}`);
    });

    provider.on("connection-error", (event: any) => {
      this.broadcastHub.log("error", `[WS-CLIENT-DEBUG] Provider connection-error: ${event ? event.message || String(event) : "unknown"}`);
    });

    provider.on("status", async (event: { status: string }) => {
      if (event.status === "connecting") {
        if (this.authService) {
          const auth = await this.authService.getState();
          if (!auth.accessToken) {
            provider.disconnect();
            void this.teardownSession(activeSession);
            void vscode.window.showErrorMessage(
              "Conduit session disconnected: Authentication token has expired. Please sign in again."
            );
          }
        }
      }
    });
    const fileManager = new FileManager();
    const cursorManager = new CursorManager(awareness);
    const activeSession: ActiveRealtimeSession = {
      room: target.room,
      session: target.session,
      roomKey,
      websocketUrl: target.websocketUrl,
      localUserId: target.localUserId,
      localUserName: target.localUserName,
      ...(target.accessToken ? { accessToken: target.accessToken } : {}),
      repoPath: target.repoPath,
      gitService: target.gitService,
      doc,
      provider,
      awareness,
      fileManager,
      filesystemOpLog: doc.getArray<string>("filesystemOps"),
      seenFilesystemOpIds: new Set<string>(),
      suppressedFilesystemPaths: new Map<string, number>(),
      cursorManager,
      disposables: [],
      autoStashRefs: [...target.stashedRefs],
      lifecycleToken,
      filesystemEventQueue: Promise.resolve(),
      nextFilesystemOpSequence: 0
    };

    fileManager.getOrCreate(roomKey, doc);
    this.setActiveSession(activeSession);

    this.updateState({
      room: target.room,
      session: target.session,
      websocketUrl: target.websocketUrl,
      connectionState: "connecting",
      participantCount: 1,
      collaborators: [
        {
          userId: target.localUserId,
          name: target.localUserName,
          color: cursorManager.assignColor(target.localUserId),
          status: "online"
        }
      ],
      lastError: undefined
    });

    try {
      this.registerSessionLifecycle(activeSession);
      this.broadcastHub.log("info", `[WS-CLIENT-DEBUG] Calling provider.connect() for roomKey: ${roomKey}`);
      activeSession.provider.connect();
      this.broadcastHub.log("info", `[WS-CLIENT-DEBUG] Waiting for Yjs sync...`);
      await this.waitForYjsSync(activeSession);
      this.broadcastHub.log("info", `[WS-CLIENT-DEBUG] Yjs sync completed successfully!`);
      this.ensureSessionIsCurrent(activeSession);

      if (fileManager.isEmpty(roomKey)) {
        await fileManager.initFromWorkspace(roomKey);
        this.broadcastHub.log(
          "info",
          `Seeded session ${roomKey} from workspace`
        );
      } else {
        await fileManager.syncSessionFilesToDisk(roomKey);
        this.broadcastHub.log(
          "info",
          `Hydrated workspace from session ${roomKey}`
        );
      }

      this.ensureSessionIsCurrent(activeSession);
      this.registerFilesystemEventBroadcasting(activeSession);
      await fileManager.syncSessionFilesToDisk(roomKey);
      await this.bindEditors(activeSession);
      this.publishLocalPresence(activeSession);
      this.renderPresence(activeSession);

      // Persist the session to Supabase (fire-and-forget)
      void this.persistSessionToBackend(activeSession);
    } catch (error) {
      this.broadcastHub.log(
        "error",
        `Failed to connect collaboration session ${roomKey}: ${this.stringifyError(error)}`
      );
      await this.teardownSession(activeSession, {
        nextConnectionState: "error",
        lastError: this.stringifyError(error)
      });
      throw error;
    }
  }

  public async teardownSession(
    session = this.activeSession,
    options: {
      readonly nextConnectionState?: ConnectionState;
      readonly lastError?: string;
      readonly logLevel?: "info" | "warn" | "error";
      readonly logMessage?: string;
    } = {}
  ): Promise<void> {
    if (!session) {
      return;
    }

    if (
      session.lifecycleToken < this.lifecycleToken &&
      this.activeSession?.roomKey !== session.roomKey
    ) {
      // The session has already been superseded by a newer transition.
    }

    if (this.activeSession?.roomKey === session.roomKey) {
      this.activeSession = undefined;
    }
    this.branchSessionRegistry.markSessionInactive(session.roomKey);

    session.awareness.setLocalState(null);
    session.cursorManager.disposeAll();
    session.fileManager.unbindAll(session.roomKey);

    for (const disposable of session.disposables) {
      disposable.dispose();
    }

    try {
      session.provider.disconnect();
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to disconnect provider for ${session.roomKey}: ${this.stringifyError(error)}`
      );
    }

    try {
      session.provider.destroy();
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to destroy provider for ${session.roomKey}: ${this.stringifyError(error)}`
      );
    }

    session.cursorManager.dispose();
    session.fileManager.dispose();
    session.doc.destroy();
    await this.restoreAutoStashes(session);

    this.updateState({
      room: undefined,
      session: undefined,
      websocketUrl: undefined,
      connectionState: options.nextConnectionState ?? "disconnected",
      participantCount: 0,
      collaborators: [],
      lastError: options.lastError
    });

    if (options.logMessage) {
      this.broadcastHub.log(options.logLevel ?? "info", options.logMessage);
    }
  }

  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    void this.teardownSession(this.activeSession);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async checkoutBranchForSession(
    gitService: GitService,
    branch: string
  ): Promise<void> {
    const branches = await gitService.listBranches(true);
    const hasLocalBranch = branches.some(
      (entry) => !entry.remote && entry.name === branch
    );
    if (hasLocalBranch) {
      await gitService.checkout(branch, {
        allowDirty: true
      });
      return;
    }

    const remoteBranch = branches.find(
      (entry) => entry.remote && entry.name.endsWith(`/${branch}`)
    );
    if (remoteBranch) {
      await gitService.createBranch(branch, {
        checkout: true,
        startPoint: remoteBranch.name
      });
      return;
    }

    await gitService.createBranch(branch, {
      checkout: true
    });
  }

  private isLocalWorkspaceUrl(value: string): boolean {
    return value.startsWith("file://");
  }

  public async filterSessionsForCurrentWorkspace(
    sessions: readonly BranchSessionRecord[]
  ): Promise<BranchSessionRecord[]> {
    const result: BranchSessionRecord[] = [];
    for (const session of sessions) {
      if (await this.matchesCurrentWorkspace(session.room)) {
        result.push(session);
      }
    }
    return result;
  }

  private normalizeGitUrl(url: string): string {
    let normalized = url.trim().toLowerCase();
    normalized = normalized.replace(/^(https?:\/\/|git:\/\/|ssh:\/\/)?(git@)?([^:\/]+)[:\/]/, "");
    normalized = normalized.replace(/\.git\/?$/, "").replace(/\/+$/, "");
    return normalized;
  }

  private async matchesCurrentWorkspace(room: Room): Promise<boolean> {
    const roomRepoUrl = room.repoUrl.trim();
    if (!roomRepoUrl) {
      return false;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return false;
    }
    const localWorkspaceUrl = workspaceFolder.uri.toString();
    if (this.isLocalWorkspaceUrl(roomRepoUrl)) {
      try {
        const uri1 = vscode.Uri.parse(roomRepoUrl).fsPath;
        const uri2 = vscode.Uri.parse(localWorkspaceUrl).fsPath;
        let p1 = uri1;
        let p2 = uri2;
        try {
          p1 = require("fs").realpathSync(uri1);
        } catch { }
        try {
          p2 = require("fs").realpathSync(uri2);
        } catch { }
        return (
          p1.toLowerCase().replace(/[\/\\]+$/, "") ===
          p2.toLowerCase().replace(/[\/\\]+$/, "")
        );
      } catch {
        return (
          roomRepoUrl.toLowerCase().replace(/[\/\\]+$/, "") ===
          localWorkspaceUrl.toLowerCase().replace(/[\/\\]+$/, "")
        );
      }
    }
    try {
      const gitService = new GitService({ repoPath: this.getRepoPath() });
      const remoteUrl = await gitService.getRepoRemoteUrl();
      if (!remoteUrl) {
        return false;
      }
      return (
        this.normalizeGitUrl(remoteUrl) === this.normalizeGitUrl(roomRepoUrl)
      );
    } catch {
      return false;
    }
  }

  public getRepoPath(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("Conduit requires an open VS Code workspace folder.");
    }

    return workspaceFolder.uri.fsPath;
  }

  public async getRepoRemoteUrl(): Promise<string | undefined> {
    try {
      const gitService = new GitService({ repoPath: this.getRepoPath() });
      return await gitService.getRepoRemoteUrl();
    } catch {
      return undefined;
    }
  }

  private getWorkspaceFolderForRepo(repoPath: string): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.find(
      (workspaceFolder: vscode.WorkspaceFolder) => {
        return workspaceFolder.uri.fsPath === repoPath;
      }
    );
    if (!folder) {
      throw new Error(
        `No workspace folder matches repository path ${repoPath}.`
      );
    }

    return folder;
  }

  public getDraftManager(repoPath = this.getRepoPath()): DraftManager {
    return new DraftManager(this.getWorkspaceFolderForRepo(repoPath));
  }

  private getDraftWorkspacePath(repoPath: string, draftId: string): string {
    const workspaceFolder = this.getWorkspaceFolderForRepo(repoPath);
    return vscode.workspace
      .asRelativePath(
        vscode.Uri.joinPath(
          workspaceFolder.uri,
          ".conduit",
          "drafts",
          `${draftId}.json`
        ),
        false
      )
      .split("\\")
      .join("/");
  }

  private getFilesystemOperationsFromSession(
    session: ActiveRealtimeSession
  ): readonly FilesystemEvent[] {
    return session.filesystemOpLog
      .toArray()
      .map((encodedOperation: string) => {
        return this.parseFilesystemOperationRecord(encodedOperation);
      })
      .filter(
        (record): record is FilesystemOperationRecord => record !== undefined
      )
      .map((record) => record.event);
  }

  private syncDiscoveredDrafts(drafts: readonly DraftMetadata[]): void {
    this.branchSessionRegistry.syncDrafts(
      drafts.map((draftMetadata) => {
        return {
          id: draftMetadata.draft.id,
          branch: draftMetadata.draft.branch,
          status: draftMetadata.draft.status,
          sessionId: draftMetadata.draft.sessionId,
          createdBy: draftMetadata.draft.createdBy,
          createdAt: draftMetadata.draft.createdAt,
          workspacePath:
            draftMetadata.source === "remote"
              ? `Supabase drafts/${draftMetadata.draft.id}.yjs`
              : vscode.workspace
                .asRelativePath(draftMetadata.uri, false)
                .split("\\")
                .join("/")
        };
      })
    );
  }

  private async updateRemoteDraftStatus(
    draftId: string,
    status: Draft["status"]
  ): Promise<void> {
    const session = this.activeSession;
    if (!session || !this.remoteDraftStatusUpdater) {
      return;
    }

    const token = await this.getFreshToken() || session.accessToken;
    if (!token) {
      return;
    }

    try {
      const updatedDraft = await this.remoteDraftStatusUpdater(
        draftId,
        status,
        token
      );
      this.branchSessionRegistry.upsertDraft({
        id: updatedDraft.id,
        branch: updatedDraft.branch,
        status: updatedDraft.status,
        sessionId: updatedDraft.sessionId,
        createdBy: updatedDraft.createdBy,
        createdAt: updatedDraft.createdAt,
        workspacePath: this.getDraftWorkspacePath(
          session.repoPath,
          updatedDraft.id
        )
      });
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to update remote draft ${draftId} status: ${this.stringifyError(error)}`
      );
    }
  }

  private async discoverRemoteDrafts(): Promise<readonly DraftMetadata[]> {
    const session = this.activeSession;
    if (!session || !this.remoteDraftLister) {
      return [];
    }

    const token = await this.getFreshToken() || session.accessToken;
    if (!token) {
      return [];
    }

    try {
      const drafts = await this.remoteDraftLister(
        {
          roomId: session.room.id,
          status: "active"
        },
        token
      );
      return drafts.map((draft) => {
        return {
          draft,
          uri: vscode.Uri.parse(
            `conduit-draft://${encodeURIComponent(draft.roomId)}/${encodeURIComponent(draft.id)}`
          ),
          source: "remote" as const
        };
      });
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to discover remote drafts: ${this.stringifyError(error)}`
      );
      return [];
    }
  }

  private mergeDraftMetadata(
    primaryDrafts: readonly DraftMetadata[],
    fallbackDrafts: readonly DraftMetadata[]
  ): readonly DraftMetadata[] {
    const mergedDrafts = new Map<string, DraftMetadata>();

    for (const draft of fallbackDrafts) {
      mergedDrafts.set(draft.draft.id, draft);
    }

    for (const draft of primaryDrafts) {
      mergedDrafts.set(draft.draft.id, draft);
    }

    return [...mergedDrafts.values()].sort((left, right) => {
      return right.draft.createdAt.localeCompare(left.draft.createdAt);
    });
  }

  private async requireDraftById(draftId: string): Promise<DraftMetadata> {
    const drafts = await this.discoverDrafts();
    const draft = drafts.find((entry) => entry.draft.id === draftId);
    if (!draft) {
      throw new Error(`Draft ${draftId} was not found.`);
    }

    return draft;
  }

  private async ensureActiveSessionForDraft(draft: Draft): Promise<void> {
    if (
      this.activeSession &&
      this.activeSession.session.id === draft.sessionId &&
      this.activeSession.room.id === draft.roomId &&
      this.activeSession.session.branch === draft.branch
    ) {
      return;
    }

    const identity = this.lastRealtimeIdentity;
    if (!identity) {
      throw new Error(
        `Draft ${draft.id} cannot be restored because no collaborative identity is available. Join a session first.`
      );
    }

    const exactSession =
      this.branchSessionRegistry.getSession(draft.roomId, draft.sessionId) ??
      this.branchSessionRegistry.getPreferredSession(
        draft.roomId,
        draft.branch
      );
    if (!exactSession) {
      throw new Error(
        `Draft ${draft.id} cannot be restored because no branch-scoped session is known for ${draft.roomId}:${draft.branch}.`
      );
    }

    await this.joinSession({
      room: exactSession.room,
      session: exactSession.session,
      websocketUrl: exactSession.websocketUrl || identity.websocketUrl,
      localUserId: identity.localUserId,
      localUserName: identity.localUserName,
      ...(identity.accessToken ? { accessToken: identity.accessToken } : {})
    });
  }

  private requireActiveSession(): ActiveRealtimeSession {
    if (!this.activeSession) {
      throw new Error("No active Conduit session exists.");
    }

    return this.activeSession;
  }

  private setActiveSession(session: ActiveRealtimeSession): void {
    this.activeSession = session;
    this.branchSessionRegistry.upsertSession(
      {
        room: session.room,
        session: session.session,
        websocketUrl: session.websocketUrl
      },
      {
        active: true,
        source: "local",
        participantCount: session.session.participants.length
      }
    );
  }

  private resolveSessionTarget(
    target: RealtimeSessionTarget,
    preferExistingBranchSession: boolean
  ): RealtimeSessionTarget {
    if (!preferExistingBranchSession) {
      return target;
    }

    const existingSession = this.branchSessionRegistry.getPreferredSession(
      target.room.id,
      target.session.branch
    );
    if (!existingSession) {
      return target;
    }

    return {
      ...target,
      room: existingSession.room,
      session: existingSession.session,
      websocketUrl: existingSession.websocketUrl || target.websocketUrl
    };
  }

  private validateBranchName(branch: string): void {
    const normalizedBranch = branch.trim();
    if (normalizedBranch.length === 0) {
      throw new Error("Branch validation failed: branch name cannot be empty.");
    }

    if (normalizedBranch.includes(":")) {
      throw new Error(
        'Branch validation failed: ":" is reserved in Conduit room keys.'
      );
    }
  }

  private registerSessionLifecycle(session: ActiveRealtimeSession): void {
    const handleStatus = (event: {
      readonly status: "connecting" | "connected" | "disconnected";
    }): void => {
      if (!this.isCurrentSession(session)) {
        return;
      }

      const currentSession = this.activeSession ?? session;

      const nextState: ConnectionState =
        event.status === "connected"
          ? "connected"
          : this.state.connectionState === "connected"
            ? "reconnecting"
            : "disconnected";

      this.updateState({
        room: currentSession.room,
        session: currentSession.session,
        websocketUrl: currentSession.websocketUrl,
        connectionState: nextState,
        participantCount: Math.max(1, this.state.participantCount),
        collaborators: this.state.collaborators,
        lastError: nextState === "connected" ? undefined : this.state.lastError
      });

      this.broadcastHub.log(
        "info",
        `Yjs provider ${event.status} for ${session.roomKey}`
      );
    };

    const handleSync = (isSynced: boolean): void => {
      if (!isSynced || !this.isCurrentSession(session)) {
        return;
      }

      this.broadcastHub.log(
        "info",
        `Initial Yjs sync completed for ${session.roomKey}`
      );
    };

    const handleConnectionClose = (event: CloseEvent | null): void => {
      if (!this.isCurrentSession(session)) {
        return;
      }

      const currentSession = this.activeSession ?? session;
      const reason = event?.reason ?? "Connection closed";
      this.updateState({
        room: currentSession.room,
        session: currentSession.session,
        websocketUrl: currentSession.websocketUrl,
        connectionState: "reconnecting",
        participantCount: this.state.participantCount,
        collaborators: this.state.collaborators,
        lastError: reason
      });
      this.broadcastHub.log("warn", `Connection closed: ${reason}`);
    };

    const handleConnectionError = (...args: any[]): void => {
      const event = args[0] as { readonly error?: Error } | undefined;
      if (!this.isCurrentSession(session)) {
        return;
      }

      const currentSession = this.activeSession ?? session;
      this.updateState({
        room: currentSession.room,
        session: currentSession.session,
        websocketUrl: currentSession.websocketUrl,
        connectionState: "error",
        participantCount: this.state.participantCount,
        collaborators: this.state.collaborators,
        lastError: event?.error?.message ?? "Unknown realtime error"
      });
      this.broadcastHub.log(
        "error",
        `Realtime error: ${event?.error?.message ?? "Unknown realtime error"}`
      );
    };

    const handleAwarenessChange = (): void => {
      if (!this.isCurrentSession(session)) {
        return;
      }

      this.renderPresence(session);
      if (vscode.window.activeTextEditor) {
        session.cursorManager.renderRemoteCursors(
          vscode.window.activeTextEditor
        );
      }
    };

    const selectionSubscription = vscode.window.onDidChangeTextEditorSelection(
      (event: vscode.TextEditorSelectionChangeEvent) => {
        if (!this.isCurrentSession(session)) {
          return;
        }

        session.cursorManager.broadcastCursor(
          event.textEditor,
          session.localUserId,
          session.localUserName
        );
      }
    );

    const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(
      (editor: vscode.TextEditor | undefined) => {
        if (!this.isCurrentSession(session)) {
          return;
        }
        this.updateLocalActiveFile(session, editor);

        if (!editor) {
          return;
        }

        void session.fileManager.bindEditor(session.roomKey, editor);
        session.cursorManager.broadcastCursor(
          editor,
          session.localUserId,
          session.localUserName
        );
        session.cursorManager.renderRemoteCursors(editor);
      }
    );

    const openDocumentSubscription = vscode.workspace.onDidOpenTextDocument(
      (document: vscode.TextDocument) => {
        if (!this.isCurrentSession(session)) {
          return;
        }

        const visibleEditor = vscode.window.visibleTextEditors.find(
          (editor: vscode.TextEditor) => {
            return editor.document.uri.toString() === document.uri.toString();
          }
        );

        if (visibleEditor) {
          void session.fileManager.bindEditor(session.roomKey, visibleEditor);
        }
      }
    );

    const createFilesSubscription = vscode.workspace.onDidCreateFiles(
      (event: vscode.FileCreateEvent) => {
        if (!this.isCurrentSession(session)) {
          return;
        }

        for (const fileUri of event.files) {
          if (this.isFilesystemPathSuppressed(session, [fileUri])) {
            continue;
          }

          void this.enqueueFilesystemTask(session, async () => {
            const operation =
              await session.fileManager.createFileCreateEvent(fileUri);
            if (!operation) {
              return;
            }

            await session.fileManager.onFileCreated(session.roomKey, fileUri);
            this.appendFilesystemOperation(session, operation);
          });
        }
      }
    );

    const deleteFilesSubscription = vscode.workspace.onDidDeleteFiles(
      (event: vscode.FileDeleteEvent) => {
        if (!this.isCurrentSession(session)) {
          return;
        }

        for (const fileUri of event.files) {
          if (this.isFilesystemPathSuppressed(session, [fileUri])) {
            continue;
          }

          void this.enqueueFilesystemTask(session, async () => {
            const operation =
              session.fileManager.createFileDeleteEvent(fileUri);
            if (!operation) {
              return;
            }

            session.fileManager.onFileDeleted(session.roomKey, fileUri);
            this.appendFilesystemOperation(session, operation);
          });
        }
      }
    );

    const renameFilesSubscription = vscode.workspace.onDidRenameFiles(
      (event: vscode.FileRenameEvent) => {
        if (!this.isCurrentSession(session)) {
          return;
        }

        for (const file of event.files) {
          if (
            this.isFilesystemPathSuppressed(session, [file.oldUri, file.newUri])
          ) {
            continue;
          }

          void this.enqueueFilesystemTask(session, async () => {
            const operation = session.fileManager.createFileRenameEvent(
              file.oldUri,
              file.newUri
            );
            if (!operation) {
              return;
            }

            session.fileManager.onFileRenamed(
              session.roomKey,
              file.oldUri,
              file.newUri
            );
            this.appendFilesystemOperation(session, operation);
          });
        }
      }
    );

    session.provider.on("status", handleStatus);
    session.provider.on("sync", handleSync);
    session.provider.on("connection-close", handleConnectionClose);
    session.provider.on("connection-error", handleConnectionError);
    session.awareness.on("change", handleAwarenessChange);

    session.disposables.push(
      selectionSubscription,
      activeEditorSubscription,
      openDocumentSubscription,
      createFilesSubscription,
      deleteFilesSubscription,
      renameFilesSubscription,
      new vscode.Disposable(() => {
        session.provider.off("status", handleStatus);
        session.provider.off("sync", handleSync);
        session.provider.off("connection-close", handleConnectionClose);
        session.provider.off("connection-error", handleConnectionError);
        session.awareness.off("change", handleAwarenessChange);
      })
    );
  }

  private async bindEditors(session: ActiveRealtimeSession): Promise<void> {
    if (!this.isCurrentSession(session)) {
      return;
    }

    for (const editor of vscode.window.visibleTextEditors) {
      await session.fileManager.bindEditor(session.roomKey, editor);
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && this.isCurrentSession(session)) {
      session.cursorManager.broadcastCursor(
        activeEditor,
        session.localUserId,
        session.localUserName
      );
      session.cursorManager.renderRemoteCursors(activeEditor);
    }
  }

  private updateLocalActiveFile(session: ActiveRealtimeSession, editor?: vscode.TextEditor): void {
    const activeEditor = editor ?? vscode.window.activeTextEditor;
    const relPath = activeEditor
      ? vscode.workspace.asRelativePath(activeEditor.document.uri)
      : undefined;
    session.awareness.setLocalStateField("activeFile", relPath);
  }

  private publishLocalPresence(session: ActiveRealtimeSession): void {
    const color = session.cursorManager.assignColor(session.localUserId);
    const role = session.localUserId === session.room.ownerId ? "Owner" : "Member";
    session.awareness.setLocalStateField("user", {
      id: session.localUserId,
      name: session.localUserName,
      color,
      role
    });
    this.updateLocalActiveFile(session);
  }

  private renderPresence(session: ActiveRealtimeSession): void {
    const collaborators: CollaboratorPresence[] = [];

    for (const [clientId, value] of session.awareness.getStates()) {
      const state = value as AwarenessEnvelope;
      const user = state.user;
      if (
        !user ||
        typeof user.id !== "string" ||
        typeof user.name !== "string" ||
        typeof user.color !== "string"
      ) {
        continue;
      }

      collaborators.push({
        userId: user.id,
        name: user.name,
        color: user.color,
        status: "online",
        role: user.role || (user.id === session.room.ownerId ? "Owner" : "Member")
      });

      if (
        clientId !== session.awareness.clientID &&
        state.cursor &&
        vscode.window.activeTextEditor
      ) {
        session.cursorManager.updateRemoteCursor(
          clientId,
          state.cursor,
          vscode.window.activeTextEditor
        );
      }
    }

    const participantCount = collaborators.length;
    const nextSession: Session = {
      ...session.session,
      participants: collaborators.map((collaborator) => collaborator.userId)
    };
    this.setActiveSession({
      ...session,
      session: nextSession
    });

    this.updateState({
      room: session.room,
      session: nextSession,
      websocketUrl: session.websocketUrl,
      connectionState: this.state.connectionState,
      participantCount,
      collaborators,
      lastError: this.state.lastError
    });
  }

  private async getFreshToken(): Promise<string | undefined> {
    if (!this.authService) {
      return undefined;
    }
    try {
      const state = await this.authService.getState();
      return state.accessToken;
    } catch {
      return undefined;
    }
  }

  private updateState(nextState: WsClientState): void {
    this.state = nextState;

    const snapshot: CollaborationSnapshot = {
      room: nextState.room,
      roomId: nextState.room?.id ?? nextState.session?.roomId,
      session: nextState.session,
      websocketUrl: nextState.websocketUrl,
      state: nextState.connectionState,
      participantCount: nextState.participantCount,
      collaborators: nextState.collaborators,
      lastError: nextState.lastError
    };

    this.broadcastHub.publishSnapshot(snapshot);
  }

  private registerFilesystemEventBroadcasting(
    session: ActiveRealtimeSession
  ): void {
    const handleStatus = (event: {
      readonly status: "connecting" | "connected" | "disconnected";
    }): void => {
      this.broadcastHub.log(
        "info",
        `Provider status for ${session.roomKey}: ${event.status}`
      );
    };

    const handleSync = (isSynced: boolean): void => {
      if (!isSynced || !this.isCurrentSession(session)) {
        return;
      }

      this.broadcastHub.log("info", `Provider synced for ${session.roomKey}`);
    };

    const handleConnectionClose = (event: {
      readonly reason?: string;
    }): void => {
      if (!this.isCurrentSession(session)) {
        return;
      }

      this.broadcastHub.log(
        "warn",
        `Provider closed for ${session.roomKey}: ${event.reason ?? "unknown reason"
        }`
      );
    };

    const handleConnectionError = (...args: any[]): void => {
      const event = args[0] as { readonly error?: Error } | undefined;
      this.broadcastHub.log(
        "error",
        `Provider error for ${session.roomKey}: ${event?.error?.message ?? "Unknown provider error"
        }`
      );
    };

    const handleAwarenessChange = (): void => {
      if (!this.isCurrentSession(session)) {
        return;
      }

      this.renderPresence(session);
    };

    for (const encodedOperation of session.filesystemOpLog.toArray()) {
      const record = this.parseFilesystemOperationRecord(encodedOperation);
      if (record) {
        session.seenFilesystemOpIds.add(record.id);
      }
    }

    const handleFilesystemLogChange = (): void => {
      if (!this.isCurrentSession(session)) {
        return;
      }

      const pendingRecords = session.filesystemOpLog
        .toArray()
        .map((encodedOperation: string) => {
          return this.parseFilesystemOperationRecord(encodedOperation);
        })
        .filter(
          (
            record: FilesystemOperationRecord | undefined
          ): record is FilesystemOperationRecord => {
            return (
              record !== undefined &&
              !session.seenFilesystemOpIds.has(record.id)
            );
          }
        );

      for (const record of pendingRecords) {
        session.seenFilesystemOpIds.add(record.id);
        void this.enqueueFilesystemTask(session, async () => {
          if (record.clientId === session.doc.clientID) {
            return;
          }

          await this.applyRemoteFilesystemOperation(session, record);
        }).catch((error: unknown) => {
          session.seenFilesystemOpIds.delete(record.id);
          this.broadcastHub.log(
            "error",
            `Failed to apply filesystem op ${record.id}: ${this.stringifyError(error)}`
          );
        });
      }
    };

    session.filesystemOpLog.observe(handleFilesystemLogChange);
    session.disposables.push(
      new vscode.Disposable(() => {
        session.filesystemOpLog.unobserve(handleFilesystemLogChange);
      })
    );
  }

  private enqueueFilesystemTask(
    session: ActiveRealtimeSession,
    task: () => Promise<void>
  ): Promise<void> {
    const scheduledTask = session.filesystemEventQueue.then(async () => {
      if (!this.isCurrentSession(session)) {
        return;
      }

      await task();
    });
    session.filesystemEventQueue = scheduledTask.catch(() => {
      // Keep the queue flowing after a failed operation; the caller handles logging.
    });

    return scheduledTask;
  }

  private appendFilesystemOperation(
    session: ActiveRealtimeSession,
    event: FilesystemEvent
  ): void {
    const record: FilesystemOperationRecord = {
      id: `${session.doc.clientID}:${session.nextFilesystemOpSequence}`,
      clientId: session.doc.clientID,
      sequence: session.nextFilesystemOpSequence,
      timestamp: new Date().toISOString(),
      event
    };
    session.nextFilesystemOpSequence += 1;
    session.seenFilesystemOpIds.add(record.id);

    session.doc.transact(() => {
      session.filesystemOpLog.push([JSON.stringify(record)]);
    }, this);
  }

  private async applyRemoteFilesystemOperation(
    session: ActiveRealtimeSession,
    record: FilesystemOperationRecord
  ): Promise<void> {
    const affectedPaths = this.getFilesystemEventPaths(record.event);
    this.incrementSuppressedFilesystemPaths(session, affectedPaths);

    try {
      await session.fileManager.onRemoteFilesystemEvent(
        session.roomKey,
        record.event
      );
    } finally {
      this.decrementSuppressedFilesystemPaths(session, affectedPaths);
    }
  }

  private isFilesystemPathSuppressed(
    session: ActiveRealtimeSession,
    uris: readonly vscode.Uri[]
  ): boolean {
    for (const uri of uris) {
      const normalizedPath = session.fileManager.getWorkspaceRelativePath(uri);
      if ((session.suppressedFilesystemPaths.get(normalizedPath) ?? 0) > 0) {
        return true;
      }
    }

    return false;
  }

  private incrementSuppressedFilesystemPaths(
    session: ActiveRealtimeSession,
    paths: readonly string[]
  ): void {
    for (const relativePath of paths) {
      session.suppressedFilesystemPaths.set(
        relativePath,
        (session.suppressedFilesystemPaths.get(relativePath) ?? 0) + 1
      );
    }
  }

  private decrementSuppressedFilesystemPaths(
    session: ActiveRealtimeSession,
    paths: readonly string[]
  ): void {
    for (const relativePath of paths) {
      const nextValue =
        (session.suppressedFilesystemPaths.get(relativePath) ?? 0) - 1;
      if (nextValue > 0) {
        session.suppressedFilesystemPaths.set(relativePath, nextValue);
      } else {
        session.suppressedFilesystemPaths.delete(relativePath);
      }
    }
  }

  private getFilesystemEventPaths(event: FilesystemEvent): readonly string[] {
    switch (event.type) {
      case "FILE_CREATE":
      case "FILE_DELETE":
        return [event.path];
      case "FILE_RENAME":
      case "FILE_MOVE":
        return [event.oldPath, event.newPath];
    }
  }

  private parseFilesystemOperationRecord(
    encodedOperation: string
  ): FilesystemOperationRecord | undefined {
    try {
      const candidate = JSON.parse(
        encodedOperation
      ) as Partial<FilesystemOperationRecord>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.clientId !== "number" ||
        typeof candidate.sequence !== "number" ||
        typeof candidate.timestamp !== "string" ||
        !candidate.event ||
        !this.isFilesystemEvent(candidate.event)
      ) {
        return undefined;
      }

      return {
        id: candidate.id,
        clientId: candidate.clientId,
        sequence: candidate.sequence,
        timestamp: candidate.timestamp,
        event: candidate.event
      };
    } catch {
      return undefined;
    }
  }

  private isFilesystemEvent(candidate: unknown): candidate is FilesystemEvent {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }

    const event = candidate as Partial<FilesystemEvent>;
    switch (event.type) {
      case "FILE_CREATE":
        return (
          typeof event.path === "string" && typeof event.content === "string"
        );
      case "FILE_DELETE":
        return typeof event.path === "string";
      case "FILE_RENAME":
      case "FILE_MOVE":
        return (
          typeof event.oldPath === "string" && typeof event.newPath === "string"
        );
      default:
        return false;
    }
  }

  private stringifyError(error: unknown): string {
    if (error instanceof GitServiceError) {
      const stderr = error.details.stderr?.trim();
      return stderr && stderr.length > 0
        ? `${error.message}: ${stderr}`
        : error.message;
    }

    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Persists the active session to the backend Supabase database.
   * Fire-and-forget: errors are logged but never propagated.
   */
  private async persistSessionToBackend(
    session: ActiveRealtimeSession
  ): Promise<void> {
    try {
      const backendUrl = this.getBackendHttpUrl(session.websocketUrl);
      const headers: Record<string, string> = {
        "content-type": "application/json"
      };
      const token = await this.getFreshToken() || session.accessToken;
      if (token) {
        headers["authorization"] = `Bearer ${token}`;
      }

      // Upsert room first
      await fetch(`${backendUrl}/rooms`, {
        method: "POST",
        headers,
        body: JSON.stringify(session.room)
      });

      // Upsert session
      const sessionResponse = await fetch(`${backendUrl}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify(session.session)
      });

      if (!sessionResponse.ok) {
        const body = await sessionResponse.json().catch(() => ({})) as { error?: string };
        this.broadcastHub.log(
          "warn",
          `Backend session persist returned ${sessionResponse.status}: ${body.error ?? "unknown error"}`
        );
      } else {
        this.broadcastHub.log(
          "info",
          `Persisted session ${session.session.id} to backend`
        );
      }
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to persist session to backend: ${this.stringifyError(error)}`
      );
    }
  }

  /**
   * Persists a saved draft to the backend Supabase (drafts bucket).
   * The API expects the raw Yjs binary state as the request body
   * (content-type: application/octet-stream), with roomId as a query parameter.
   * Fire-and-forget: errors are logged but never propagated.
   */
  private async persistDraftToBackend(
    session: ActiveRealtimeSession,
    draft: Draft
  ): Promise<void> {
    try {
      const backendUrl = this.getBackendHttpUrl(session.websocketUrl);
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream"
      };
      const token = await this.getFreshToken() || session.accessToken;
      if (token) {
        headers["authorization"] = `Bearer ${token}`;
      }

      // The API stores the raw Yjs binary in the drafts bucket.
      // yjsState is base64-encoded in the local Draft, so decode it back to binary.
      const yjsBinary = Buffer.from(draft.yjsState, "base64");
      const postUrl = `${backendUrl}/drafts?roomId=${encodeURIComponent(draft.roomId)}`;

      const draftResponse = await fetch(postUrl, {
        method: "POST",
        headers,
        body: yjsBinary
      });

      if (!draftResponse.ok) {
        const body = await draftResponse.json().catch(() => ({})) as { error?: string };
        // If the draft already exists (409), update it via PATCH
        if (draftResponse.status === 409) {
          const patchUrl = `${backendUrl}/drafts?roomId=${encodeURIComponent(draft.roomId)}`;
          const patchResponse = await fetch(patchUrl, {
            method: "PATCH",
            headers,
            body: yjsBinary
          });
          if (patchResponse.ok) {
            this.broadcastHub.log(
              "info",
              `Updated existing draft ${draft.id} in backend`
            );
          } else {
            const patchBody = await patchResponse.json().catch(() => ({})) as { error?: string };
            this.broadcastHub.log(
              "warn",
              `Backend draft PATCH returned ${patchResponse.status}: ${patchBody.error ?? "unknown error"}`
            );
          }
        } else {
          this.broadcastHub.log(
            "warn",
            `Backend draft persist returned ${draftResponse.status}: ${body.error ?? "unknown error"}`
          );
        }
      } else {
        this.broadcastHub.log(
          "info",
          `Persisted draft ${draft.id} to backend`
        );
      }
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to persist draft to backend: ${this.stringifyError(error)}`
      );
    }
  }

  /**
   * Fetches all drafts for the current room from the backend (GET /drafts?roomId=)
   * and saves any unknown ones to the local filesystem so they surface in the UI.
   */
  private async fetchDraftsFromBackend(
    session: ActiveRealtimeSession,
    draftManager: DraftManager
  ): Promise<void> {
    try {
      const backendUrl = this.getBackendHttpUrl(session.websocketUrl);
      const fetchUrl = `${backendUrl}/drafts?roomId=${encodeURIComponent(session.room.id)}`;
      const headers: Record<string, string> = {};
      const token = await this.getFreshToken() || session.accessToken;
      if (token) {
        headers["authorization"] = `Bearer ${token}`;
      }

      const response = await fetch(fetchUrl, { headers });
      if (!response.ok) {
        // Non-fatal: local drafts still work
        this.broadcastHub.log(
          "warn",
          `Failed to fetch remote drafts from backend: ${response.status}`
        );
        return;
      }

      // The API returns an object containing the drafts array: { drafts: [...] }
      const data = (await response.json()) as {
        readonly drafts?: readonly ({
          readonly roomId?: string;
          readonly sessionId?: string;
          readonly id?: string;
          readonly branch?: string;
          readonly baseCommitHash?: string;
          readonly createdBy?: string;
          readonly createdAt?: string;
          readonly status?: string;
          readonly lineage?: string;
          // yjsState comes back as base64 string or the raw binary may be in a separate field
          readonly yjsState?: string;
          readonly filesystemOps?: readonly unknown[];
          readonly aiEvents?: readonly unknown[];
        })[];
      };

      const drafts = data.drafts;
      if (!Array.isArray(drafts)) {
        return;
      }

      for (const remoteDraft of drafts) {
        // Skip malformed entries
        if (
          typeof remoteDraft.roomId !== "string" ||
          typeof remoteDraft.sessionId !== "string" ||
          typeof remoteDraft.yjsState !== "string"
        ) {
          continue;
        }

        // Only save drafts that have a valid status
        const status = remoteDraft.status;
        if (status !== "active" && status !== "applied" && status !== "discarded") {
          continue;
        }

        // Build the local Draft shape from the remote payload
        const localDraft: Draft = {
          id: remoteDraft.id ?? remoteDraft.sessionId,
          sessionId: remoteDraft.sessionId,
          roomId: remoteDraft.roomId,
          branch: remoteDraft.branch ?? session.session.branch,
          baseCommitHash: remoteDraft.baseCommitHash ?? "HEAD",
          yjsState: remoteDraft.yjsState,
          filesystemOps: Array.isArray(remoteDraft.filesystemOps)
            ? (remoteDraft.filesystemOps as FilesystemEvent[])
            : [],
          aiEvents: Array.isArray(remoteDraft.aiEvents)
            ? (remoteDraft.aiEvents as string[])
            : [],
          createdBy: remoteDraft.createdBy ?? "unknown",
          createdAt: remoteDraft.createdAt ?? new Date().toISOString(),
          status,
          ...(remoteDraft.lineage ? { lineage: remoteDraft.lineage } : {})
        };

        // Persist locally (no-throw) — DraftManager.saveDraft writes to .conduit/drafts/
        try {
          await draftManager.saveDraft({
            draftId: localDraft.id,
            sessionId: localDraft.sessionId,
            roomId: localDraft.roomId,
            branch: localDraft.branch,
            baseCommitHash: localDraft.baseCommitHash,
            createdBy: localDraft.createdBy,
            ydoc: (() => {
              // Reconstruct a Y.Doc from the stored binary so saveDraft can re-encode it
              const tempDoc = new Y.Doc();
              Y.applyUpdate(tempDoc, Buffer.from(localDraft.yjsState, "base64"));
              return tempDoc;
            })(),
            filesystemOps: localDraft.filesystemOps,
            aiEvents: localDraft.aiEvents as string[],
            status: localDraft.status,
            createdAt: localDraft.createdAt,
            ...(localDraft.lineage ? { lineage: localDraft.lineage } : {})
          });
        } catch {
          // Ignore individual draft save failures
        }
      }

      this.broadcastHub.log(
        "info",
        `Fetched ${drafts.length} remote draft(s) for room ${session.room.id}`
      );
    } catch (error) {
      this.broadcastHub.log(
        "warn",
        `Failed to fetch remote drafts: ${this.stringifyError(error)}`
      );
    }
  }

  /**
   * Derives the backend HTTP base URL from the websocket URL.
   */
  private getBackendHttpUrl(websocketUrl: string): string {
    const parsedUrl = new URL(websocketUrl);
    parsedUrl.protocol = parsedUrl.protocol === "wss:" ? "https:" : "http:";
    parsedUrl.pathname = "";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString().replace(/\/$/u, "");
  }

  private ensureNotDisposed(): void {
    if (this.isDisposed) {
      throw new Error("Conduit session manager is already disposed.");
    }
  }

  private isCurrentSession(session: ActiveRealtimeSession): boolean {
    return (
      !this.isDisposed &&
      this.activeSession?.roomKey === session.roomKey &&
      this.activeSession.lifecycleToken === session.lifecycleToken
    );
  }

  private ensureSessionIsCurrent(session: ActiveRealtimeSession): void {
    if (!this.isCurrentSession(session)) {
      throw new Error(
        `Session ${session.roomKey} was superseded by a newer transition.`
      );
    }
  }

  private async restoreAutoStashes(
    session: ActiveRealtimeSession
  ): Promise<void> {
    for (const stashRef of [...session.autoStashRefs].reverse()) {
      try {
        const result = await session.gitService.stashPop(stashRef);
        this.broadcastHub.log(
          result.conflicts ? "warn" : "info",
          result.conflicts
            ? `Restored stashed local changes from ${stashRef} with conflicts.`
            : `Restored stashed local changes from ${stashRef}.`
        );
      } catch (error) {
        this.broadcastHub.log(
          "warn",
          `Failed to restore stashed local changes ${stashRef}: ${this.stringifyError(error)}`
        );
      }
    }
  }
}
