import * as vscode from "vscode";
import * as Y from "yjs";

import type {
  BranchSessionRecord,
  BranchSessionRegistry
} from "./BranchSessionRegistry.js";
import { LocalFallbackStore } from "./LocalFallbackStore.js";
import {
  SessionManager,
  type RemoteDraftLister,
  type RemoteDraftSaver,
  type RemoteDraftStatusUpdater,
  type RealtimeSessionTarget,
  type WsClientState
} from "./SessionManager.js";
import type { Draft } from "@conduit/shared-types";
import type { GitCommitResult } from "@conduit/git-core";
import type { BroadcastHub } from "./broadcast.js";
import {
  DraftManager,
  type DraftCompareResult,
  type DraftFreshnessResult,
  type DraftMetadata,
  type DraftRestoreResult,
  type DraftRestoreStrategy
} from "@conduit/collaboration-core";

/**
 * Backward-compatible wrapper around SessionManager for extension consumers.
 */
export class ConduitWebSocketClient implements vscode.Disposable {
  private readonly sessionManager: SessionManager;
  private authService: any;

  public constructor(
    broadcastHub: BroadcastHub,
    branchSessionRegistry: BranchSessionRegistry,
    localFallbackStore: LocalFallbackStore,
    remoteDraftSaver?: RemoteDraftSaver,
    remoteDraftStatusUpdater?: RemoteDraftStatusUpdater,
    remoteDraftLister?: RemoteDraftLister
  ) {
    this.sessionManager = new SessionManager(
      broadcastHub,
      branchSessionRegistry,
      localFallbackStore,
      remoteDraftSaver,
      remoteDraftStatusUpdater,
      remoteDraftLister
    );
  }

  public setAuthService(authService: any): void {
    this.authService = authService;
    this.sessionManager.setAuthService(authService);
  }

  public getState(): WsClientState {
    return this.sessionManager.getState();
  }

  public getActiveDoc(): Y.Doc | undefined {
    return this.sessionManager.getActiveDoc();
  }

  public getActiveAwareness(): import('y-protocols/awareness').Awareness | undefined {
    return this.sessionManager.getActiveAwareness();
  }

  public async createSession(target: RealtimeSessionTarget): Promise<void> {
    await this.sessionManager.createSession(target);
  }

  public async joinSession(target: RealtimeSessionTarget): Promise<void> {
    await this.sessionManager.joinSession(target);
  }

  public async switchBranch(branch: string): Promise<void> {
    await this.sessionManager.switchBranch(branch);
  }

  public async listBranches(): Promise<readonly string[]> {
    return this.sessionManager.listBranches();
  }

  public async getCurrentBranch(): Promise<string | undefined> {
    return this.sessionManager.getCurrentBranch();
  }

  public async getRepoRemoteUrl(): Promise<string | undefined> {
    return this.sessionManager.getRepoRemoteUrl();
  }

  public async restoreSession(options: {
    readonly websocketUrl: string;
    readonly localUserId: string;
    readonly localUserName: string;
    readonly accessToken?: string;
  }): Promise<boolean> {
    return this.sessionManager.restoreSession(options);
  }

  public async discoverSessions(
    websocketUrl: string,
    accessToken?: string
  ): Promise<readonly BranchSessionRecord[]> {
    return this.sessionManager.discoverSessions(websocketUrl, accessToken);
  }

  public async filterSessionsForCurrentWorkspace(
    sessions: readonly BranchSessionRecord[]
  ): Promise<BranchSessionRecord[]> {
    return this.sessionManager.filterSessionsForCurrentWorkspace(sessions);
  }

  public async discoverDrafts(): Promise<readonly DraftMetadata[]> {
    return this.sessionManager.discoverDrafts();
  }

  public async recoverLocalFallbacks(): Promise<readonly DraftMetadata[]> {
    return this.sessionManager.recoverLocalFallbacks();
  }

  public async checkDraftFreshness(
    draftId: string
  ): Promise<DraftFreshnessResult> {
    return this.sessionManager.checkDraftFreshness(draftId);
  }

  public async compareDrafts(
    leftDraftId: string,
    rightDraftId: string
  ): Promise<{
    readonly comparison: DraftCompareResult;
    readonly diff: string;
  }> {
    return this.sessionManager.compareDrafts(leftDraftId, rightDraftId);
  }

  public async discardDraft(draftId: string): Promise<void> {
    await this.sessionManager.discardDraft(draftId);
  }

  public async applyDraft(draftId: string): Promise<void> {
    await this.sessionManager.applyDraft(draftId);
  }

  public async getDraft(draftId: string): Promise<Draft> {
    if (!this.authService) {
      throw new Error("AuthService is not initialized.");
    }
    const state = await this.authService.getState();
    if (!state.accessToken) {
      throw new Error("You must be signed in to retrieve drafts.");
    }
    return this.authService.getDraft(draftId, state.accessToken);
  }

  public async restoreDraft(
    draftId: string,
    strategy: DraftRestoreStrategy
  ): Promise<DraftRestoreResult> {
    return this.sessionManager.restoreDraft(draftId, strategy);
  }

  public canReplaceDraftState(): boolean {
    return this.sessionManager.canReplaceDraftState();
  }

  public async disconnect(): Promise<void> {
    await this.sessionManager.leaveGraceful();
  }

  public async leaveUnexpected(reason?: string): Promise<void> {
    await this.sessionManager.leaveUnexpected(reason);
  }

  public async commitSession(message: string): Promise<GitCommitResult> {
    return this.sessionManager.commitSession(message);
  }

  public async saveDraftFromSession(): Promise<Draft> {
    return this.sessionManager.saveDraftFromSession();
  }

  public async discardSession(): Promise<void> {
    await this.sessionManager.discardSession();
  }

  public dispose(): void {
    this.sessionManager.dispose();
  }

  public getRepoPath(): string {
    return this.sessionManager.getRepoPath();
  }

  public getDraftManager(): DraftManager {
    return this.sessionManager.getDraftManager();
  }
}

export type { RealtimeSessionTarget, WsClientState } from "./SessionManager.js";
