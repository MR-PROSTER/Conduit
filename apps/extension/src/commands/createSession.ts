import * as vscode from "vscode";
import type { Session } from "@conduit/shared-types";
import { GitService } from "@conduit/git-core";

import type { ExtensionServices } from "../extension.js";
import { createSessionId } from "../sessionKeys.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

/**
 * Prompts for session metadata and starts a new collaborative connection.
 */
export const createSessionCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.createSession", async () => {
    try {
      const auth = await services.authService.requireState();
      const state = getStateManager().get();
      if (state.state !== "IN_ROOM_NO_SESSION") {
        throw new Error("Create or join a room before creating a session.");
      }
      const { room } = state;
      if (!room) {
        throw new Error("Create or join a room before creating a session.");
      }

      const currentBranch = await services.wsClient.getCurrentBranch();
      const availableBranches = await services.wsClient.listBranches();
      const branch =
        (await vscode.window.showQuickPick(availableBranches, {
          title: "Branch",
          placeHolder: currentBranch ?? "Select a branch"
        })) ??
        (await vscode.window.showInputBox({
          prompt: "Branch",
          placeHolder: currentBranch ?? "main",
          value: currentBranch ?? "main"
        }));
      if (!branch) {
        return;
      }

      // Check for uncommitted changes
      const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (repoPath) {
        const git = new GitService({ repoPath });
        const status = await git.getStatus();
        if (!status.clean) {
          const fileCount =
            status.staged.length +
            status.modified.length +
            status.untracked.length +
            status.deleted.length;

          const action = await vscode.window.showWarningMessage(
            `Your working tree has ${fileCount} uncommitted change${fileCount === 1 ? "" : "s"}. You must commit or stash them before creating the session.`,
            { modal: true },
            "Commit Changes",
            "Stash Changes",
            "Cancel Session Creation"
          );

          if (action === "Commit Changes") {
            const message = await vscode.window.showInputBox({
              title: "Commit Before Creating Session",
              prompt: "Enter a commit message for your local changes",
              placeHolder: "wip: save local changes before collab session",
              validateInput: (v) =>
                v.trim().length === 0 ? "Commit message cannot be empty" : undefined
            });
            if (!message) {
              return;
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
                await git.stash("[conduit] stash before creating session");
              }
            );
            void vscode.window.showInformationMessage("Local changes stashed.");
          } else {
            // Cancel Session Creation
            return;
          }
        }
      }

      const sessionId = createSessionId();
      const session: Session = {
        id: sessionId,
        roomId: room.id,
        branch,
        baseCommitHash: "HEAD",
        participants: [auth.user.id],
        status: "active"
      };
      const backendSession = await services.authService.createSession(
        session,
        auth.accessToken
      );

      await services.wsClient.createSession({
        room: room as unknown as Parameters<
          typeof services.wsClient.createSession
        >[0]["room"],
        session: backendSession,
        websocketUrl: services.websocketUrl,
        localUserId: auth.user.id,
        localUserName:
          auth.user.username || auth.user.email || services.localUserName,
        accessToken: auth.accessToken
      });

      getStateManager().setSession(backendSession);
      void services.sidebarProvider.refresh();

      services.broadcastHub.log(
        "info",
        `Created collaborative session ${session.id} for branch ${branch}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  });
};
