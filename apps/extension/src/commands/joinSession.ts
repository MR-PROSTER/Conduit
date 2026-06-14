import * as vscode from "vscode";
import * as crypto from "node:crypto";

import type { Room, Session } from "@conduit/shared-types";
import { GitService } from "@conduit/git-core";

import type { ExtensionServices } from "../extension.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

/**
 * Runs pre-join Git checks for a discovered session and handles any blocking
 * issues interactively (dirty working tree, branch mismatch, HEAD divergence).
 *
 * Returns `true` if the join should proceed, `false` if it was cancelled.
 */
async function runPreJoinChecks(
  services: ExtensionServices,
  session: { branch: string; baseCommitHash: string },
  repoPath: string
): Promise<boolean> {
  const git = new GitService({ repoPath });

  // ── 1. Repo remote URL check ──────────────────────────────────────────────
  // (already enforced by SessionManager.validateGitState; skip here to avoid
  //  duplicate prompts, but we do show a warning so the user is aware)

  // ── 2. Branch check ───────────────────────────────────────────────────────
  const branchResult = await git.getCurrentBranch();
  const currentBranch = branchResult.branch;

  if (currentBranch !== session.branch) {
    const action = await vscode.window.showWarningMessage(
      `This session is on branch **${session.branch}**, but your workspace is on **${currentBranch ?? "detached HEAD"}**. Conduit will switch to \`${session.branch}\` before joining.`,
      { modal: true },
      "Switch & Join",
      "Cancel"
    );
    if (action !== "Switch & Join") {
      return false;
    }
    // SessionManager.validateGitState handles the actual checkout
  }

  // ── 3. Dirty working tree check ───────────────────────────────────────────
  const status = await git.getStatus();
  if (!status.clean) {
    const fileCount =
      status.staged.length +
      status.modified.length +
      status.untracked.length +
      status.deleted.length;

    const action = await vscode.window.showWarningMessage(
      `Your working tree has ${fileCount} uncommitted change${fileCount === 1 ? "" : "s"}. You must commit or stash them before joining the session.`,
      { modal: true },
      "Commit Changes",
      "Stash Changes",
      "Cancel"
    );

    if (action === "Commit Changes") {
      const message = await vscode.window.showInputBox({
        title: "Commit Before Joining Session",
        prompt: "Enter a commit message for your local changes",
        placeHolder: "wip: save local changes before collab session",
        validateInput: (v) =>
          v.trim().length === 0 ? "Commit message cannot be empty" : undefined
      });
      if (!message) {
        return false;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Committing local changes…",
          cancellable: false
        },
        async () => {
          await git.commit(message.trim(), { all: true });
        }
      );
      void vscode.window.showInformationMessage("Local changes committed.");
    } else if (action === "Stash Changes") {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Stashing local changes…",
          cancellable: false
        },
        async () => {
          await git.stash("[conduit] stash before joining session");
        }
      );
      void vscode.window.showInformationMessage("Local changes stashed.");
    } else {
      // Cancel
      return false;
    }
  }

  // ── 4. HEAD vs room baseCommitHash check ──────────────────────────────────
  const baseHash = session.baseCommitHash;
  if (baseHash && baseHash !== "HEAD") {
    const currentHead = await git.getHead();

    if (currentHead !== baseHash) {
      const baseIsAncestor = await git.isAncestor(baseHash, "HEAD").catch(() => false);
      const headIsAncestor = await git.isAncestor("HEAD", baseHash).catch(() => false);

      if (baseIsAncestor) {
        // Local HEAD is AHEAD of the session base — warn but allow
        const aheadCount = await git.commitCount(baseHash, "HEAD").catch(() => 0);
        const proceed = await vscode.window.showWarningMessage(
          `Your local branch is ${aheadCount} commit${aheadCount === 1 ? "" : "s"} ahead of the session's base commit (\`${baseHash.slice(0, 8)}\`). Joining may cause conflicts if those commits overlap with collaborative changes.`,
          { modal: true },
          "Join Anyway",
          "Cancel"
        );
        if (proceed !== "Join Anyway") {
          return false;
        }
      } else if (headIsAncestor) {
        // Local HEAD is BEHIND the session base — must pull/rebase first
        const proceed = await vscode.window.showWarningMessage(
          `Your local branch is behind the session's base commit (\`${baseHash.slice(0, 8)}\`). You need to pull or rebase before joining so your workspace matches the collaborative state.`,
          { modal: true },
          "Join Anyway",
          "Cancel"
        );
        if (proceed !== "Join Anyway") {
          return false;
        }
      } else {
        // Diverged — heads have branched apart
        const proceed = await vscode.window.showWarningMessage(
          `Your local branch has diverged from the session's base commit (\`${baseHash.slice(0, 8)}\`). Joining may produce unpredictable results. Consider rebasing first.`,
          { modal: true },
          "Join Anyway",
          "Cancel"
        );
        if (proceed !== "Join Anyway") {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Joins an existing collaborative session using user-provided identifiers.
 */
export const joinSessionCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.joinSession", async () => {
    const stateManager = getStateManager();
    const state = stateManager.get();
    if (state.state !== "IN_ROOM_NO_SESSION") {
      void vscode.window.showInformationMessage(
        "Join a room before joining a session."
      );
      return;
    }

    const { room: currentRoom } = state;
    if (!currentRoom) {
      void vscode.window.showInformationMessage(
        "Join a room before joining a session."
      );
      return;
    }

    const auth = await services.authService.requireState();
    const discoveredSessions = await services.wsClient.discoverSessions(
      services.websocketUrl,
      auth.accessToken
    );
    const roomSessions = discoveredSessions.filter((entry) => {
      return entry.room.id === currentRoom.id;
    });
    const selectedDiscoveredSession = await vscode.window.showQuickPick(
      [
        ...roomSessions.map((entry) => {
          return {
            label: `${entry.room.name} (${entry.session.branch})`,
            description: entry.session.id,
            detail: entry.hasSavedDraft
              ? "Known branch session with saved draft"
              : "Known branch session",
            entry
          };
        }),
        {
          label: "Manual session entry",
          description: "Enter room, branch, and session IDs",
          detail: "Use this when the target session is not in discovery."
        }
      ],
      {
        title: "Join Branch Session",
        placeHolder: "Choose a discovered session or enter one manually"
      }
    );
    if (!selectedDiscoveredSession) {
      return;
    }

    if ("entry" in selectedDiscoveredSession) {
      // ── Discovered session: run pre-join checks first ──────────────────────
      const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (repoPath) {
        const ok = await runPreJoinChecks(
          services,
          selectedDiscoveredSession.entry.session,
          repoPath
        ).catch((err) => {
          // Non-fatal: let SessionManager.validateGitState be the final guard
          services.broadcastHub.log(
            "warn",
            `Pre-join check failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return true;
        });
        if (!ok) {
          return;
        }
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Joining session on ${selectedDiscoveredSession.entry.session.branch}…`,
          cancellable: false
        },
        async () => {
          await services.wsClient.joinSession({
            room: selectedDiscoveredSession.entry.room,
            session: selectedDiscoveredSession.entry.session,
            websocketUrl:
              selectedDiscoveredSession.entry.websocketUrl ||
              services.websocketUrl,
            localUserId: auth.user.id,
            localUserName: auth.user.username || auth.user.email || services.localUserName,
            accessToken: auth.accessToken
        });
      }
      );
      stateManager.setSession(selectedDiscoveredSession.entry.session);
      void services.sidebarProvider.refresh();
      services.broadcastHub.log(
        "info",
        `Joined collaborative session ${selectedDiscoveredSession.entry.session.id}`
      );
      void services.draftRestoreController.promptToRestoreUnresolvedDrafts();
      return;
    }

    // ── Manual entry flow ────────────────────────────────────────────────────
    const roomIdInput = await vscode.window.showInputBox({
      prompt: "Room ID / Name"
    });
    if (!roomIdInput) {
      return;
    }

    const isUuid = (val: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        val
      );

    const getDeterministicUuid = (input: string): string => {
      const hash = crypto
        .createHash("sha256")
        .update(input.trim().toLowerCase())
        .digest("hex");
      return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        `4${hash.slice(13, 16)}`,
        `8${hash.slice(17, 20)}`,
        hash.slice(20, 32)
      ].join("-");
    };

    const roomId = isUuid(roomIdInput)
      ? roomIdInput
      : getDeterministicUuid(roomIdInput);
    const roomName = roomIdInput.trim().length > 0 ? roomIdInput : "Room";

    const currentBranch = await services.wsClient.getCurrentBranch();
    const availableBranches = await services.wsClient.listBranches();
    const branch =
      (await vscode.window.showQuickPick(availableBranches, {
        title: "Branch",
        placeHolder: currentBranch ?? "Select a branch"
      })) ??
      (await vscode.window.showInputBox({
        prompt: "Branch",
        value: currentBranch ?? "main"
      }));
    if (!branch) {
      return;
    }

    const sessionId = await vscode.window.showInputBox({
      prompt: "Session ID"
    });
    if (!sessionId) {
      return;
    }

    // Pre-join checks for manual entry too
    const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (repoPath) {
      const ok = await runPreJoinChecks(
        services,
        { branch, baseCommitHash: "HEAD" },
        repoPath
      ).catch(() => true);
      if (!ok) {
        return;
      }
    }

    const remoteUrl = await services.wsClient.getRepoRemoteUrl();
    const roomInput: Room = {
      id: roomId,
      name: roomName,
      repoUrl:
        remoteUrl ??
        vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
        "file://local-workspace",
      defaultBranch: branch,
      ownerId: auth.user.id
    };

    // Ensure the room exists and retrieve the correct ownerId from the database
    const backendRoom = await services.authService.createRoom(
      roomInput,
      auth.accessToken
    );

    const session: Session = {
      id: sessionId,
      roomId,
      branch,
      baseCommitHash: "HEAD",
      participants: [auth.user.id],
      status: "active"
    };

    // Persist the session to the backend (upsert is idempotent)
    await services.authService.createSession(session, auth.accessToken);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Joining session on ${branch}…`,
        cancellable: false
      },
      async () => {
        await services.wsClient.joinSession({
          room: backendRoom,
          session,
          websocketUrl: services.websocketUrl,
          localUserId: auth.user.id,
          localUserName: auth.user.username || auth.user.email || services.localUserName,
          accessToken: auth.accessToken
        });
      }
    );
    stateManager.setSession(session);
    void services.sidebarProvider.refresh();

    services.broadcastHub.log(
      "info",
      `Joined collaborative session ${session.id} for branch ${branch}`
    );
    void services.draftRestoreController.promptToRestoreUnresolvedDrafts();
  });
};
