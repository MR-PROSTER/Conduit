import * as vscode from "vscode";
import * as Y from "yjs";
import type { Room, Session } from "@codesync/shared-types";
import type { IGitService } from "@codesync/git-core";
import type { AuthService } from "./AuthService.js";
import type { BranchSessionRegistry } from "./BranchSessionRegistry.js";
import type { CodeSyncWebSocketClient } from "./wsClient.js";

export type SessionLifecycleState = "IDLE" | "ACTIVE";
export type LeaveGracefulChoice = "commit" | "draft" | "discard";

export interface SessionTarget {
  room: Room;
  session: Session;
  websocketUrl: string;
}

export interface CreateSessionOptions extends SessionTarget {}

export interface JoinSessionDescriptor extends SessionTarget {}

interface ActiveSessionRecord extends SessionTarget {}

export class SessionManager implements vscode.Disposable {
  private state: SessionLifecycleState = "IDLE";
  private activeSession: ActiveSessionRecord | undefined;

  constructor(
    private readonly wsClient: CodeSyncWebSocketClient,
    private readonly gitService: IGitService,
    private readonly branchSessionRegistry: BranchSessionRegistry,
    private readonly authService: AuthService
  ) {}

  get lifecycleState(): SessionLifecycleState {
    return this.state;
  }

  get currentSession(): SessionTarget | undefined {
    return this.activeSession;
  }

  async createSession(opts: CreateSessionOptions): Promise<void> {
    this.ensureIdle();
    await this.validateRoomRepository(opts.room);
    await this.connectToSession(opts);
  }

  async joinSession(sessionDescriptor: JoinSessionDescriptor): Promise<void> {
    this.ensureIdle();
    await this.validateRoomRepository(sessionDescriptor.room);
    await this.validateJoinTarget(sessionDescriptor);
    await this.connectToSession(sessionDescriptor);
  }

  async leaveGraceful(choice: LeaveGracefulChoice): Promise<void> {
    this.ensureActive();

    if (choice === "commit") {
      await this.gitService.commit("CodeSync session changes", { all: true });
      await this.wsClient.disconnect(false);
    } else if (choice === "draft") {
      await this.wsClient.disconnect(true);
    } else {
      await this.wsClient.disconnect(false);
    }

    this.clearActiveSession();
  }

  async leaveUnexpected(reason: string): Promise<void> {
    await this.wsClient.leaveUnexpected(reason);
    this.clearActiveSession();
  }

  async switchBranch(targetBranch: string): Promise<void> {
    const branch = targetBranch.trim();
    if (!branch) {
      throw new Error("Branch name cannot be empty.");
    }

    const previousSession = this.activeSession;

    if (this.state === "ACTIVE") {
      await this.wsClient.disconnect(true);
      this.clearActiveSession();
    }

    const status = await this.gitService.getStatus();
    if (!status.clean) {
      await this.gitService.stash(`Stash before switching to ${branch}`);
    }

    await this.gitService.checkout(branch);

    const descriptor = this.branchSessionRegistry.get(branch);
    if (descriptor) {
      await this.wsClient.restoreSession({
        roomId: descriptor.roomId,
        branch,
        sessionId: descriptor.sessionId,
      });
      this.activeSession = previousSession
        ? {
            room: previousSession.room,
            session: {
              ...previousSession.session,
              branch,
              id: descriptor.sessionId,
            },
            websocketUrl: descriptor.websocketUrl,
          }
        : {
            room: {
              id: descriptor.roomId,
              name: descriptor.roomId,
              repoUrl: "",
              defaultBranch: branch,
              ownerId: "",
            },
            session: {
              id: descriptor.sessionId,
              roomId: descriptor.roomId,
              branch,
              baseCommitHash: "",
              participants: [],
              status: "active",
            },
            websocketUrl: descriptor.websocketUrl,
          };
      this.state = "ACTIVE";
    }

    await vscode.commands.executeCommand("codesync.restoreDrafts");
  }

  dispose(): void {
    this.clearActiveSession();
  }

  private async connectToSession(target: SessionTarget): Promise<void> {
    const authState = this.authService.getState();
    const user = authState.user;

    if (!user?.id) {
      throw new Error("You must be signed in before connecting to a session.");
    }

    const doc = new Y.Doc();
    await this.wsClient.connect({
      websocketUrl: target.websocketUrl,
      roomId: target.room.id,
      branch: target.session.branch,
      sessionId: target.session.id,
      userId: user.id,
      doc,
      baseCommitHash: target.session.baseCommitHash,
    });

    this.activeSession = target;
    this.state = "ACTIVE";
  }

  private async validateJoinTarget(target: JoinSessionDescriptor): Promise<void> {
    await this.ensureBranchExists(target.session.branch);

    const baseCommitHash = target.session.baseCommitHash?.trim();
    if (baseCommitHash) {
      const head = await this.gitService.getHead();
      const isAncestor = await this.gitService.isAncestor(baseCommitHash, head);
      if (!isAncestor) {
        throw new Error(
          `Join validation failed: ${baseCommitHash} is not an ancestor of current HEAD ${head}.`
        );
      }
    }

    const status = await this.gitService.getStatus();
    if (!status.clean) {
      throw new Error("Join validation failed: working tree must be clean.");
    }
  }

  private async validateRoomRepository(room: Room): Promise<void> {
    const repoUrl = room.repoUrl.trim();
    if (!repoUrl) {
      return;
    }

    const remoteUrl = await this.gitService.getRepoRemoteUrl();
    if (!remoteUrl) {
      throw new Error(
        `Repository validation failed: room ${room.id} expects ${repoUrl}, but no Git remote is configured.`
      );
    }

    if (this.normalizeRepoUrl(remoteUrl) !== this.normalizeRepoUrl(repoUrl)) {
      throw new Error(
        `Repository validation failed: expected ${repoUrl} but found ${remoteUrl}.`
      );
    }
  }

  private async ensureBranchExists(branch: string): Promise<void> {
    const targetBranch = branch.trim();
    if (!targetBranch) {
      throw new Error("Branch validation failed: branch name cannot be empty.");
    }

    const branches = await this.gitService.listBranches(true);
    const exists = branches.some((candidate) => {
      return (
        candidate.name === targetBranch ||
        candidate.name.endsWith(`/${targetBranch}`)
      );
    });

    if (!exists) {
      throw new Error(`Branch validation failed: ${targetBranch} does not exist.`);
    }
  }

  private normalizeRepoUrl(value: string): string {
    const trimmed = value.trim().replace(/\.git\/?$/, "").replace(/\/+$/, "");
    if (trimmed.startsWith("file://")) {
      try {
        return vscode.Uri.parse(trimmed).fsPath.toLowerCase().replace(/\/+$/, "");
      } catch {
        return trimmed.toLowerCase();
      }
    }

    return trimmed
      .toLowerCase()
      .replace(/^git@/, "")
      .replace(/^(https?:\/\/|ssh:\/\/|git:\/\/)/, "")
      .replace(/\/+$/, "");
  }

  private ensureIdle(): void {
    if (this.state !== "IDLE") {
      throw new Error("A CodeSync session is already active.");
    }
  }

  private ensureActive(): void {
    if (this.state !== "ACTIVE" || !this.activeSession) {
      throw new Error("No active CodeSync session exists.");
    }
  }

  private clearActiveSession(): void {
    this.activeSession = undefined;
    this.state = "IDLE";
  }
}
