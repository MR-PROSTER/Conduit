import * as vscode from "vscode";
import { GitService } from "@conduit/git-core";

import type { ExtensionServices } from "../extension.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

/**
 * Leaves the active collaborative session.
 *
 * If the user is the LAST participant remaining in the session they are
 * prompted to save a draft, commit, or discard their changes before leaving —
 * because once they leave there is nobody left to hold the shared Yjs state.
 *
 * All other participants can leave silently; their changes are already
 * replicated to the remaining collaborators via Yjs.
 */
export const leaveSessionCommand = (
  services: ExtensionServices
): vscode.Disposable => {
    return vscode.commands.registerCommand("conduit.leaveSession", async () => {
      const stateManager = getStateManager();
      if (stateManager.get().state !== "IN_ROOM_IN_SESSION") {
        void vscode.window.showInformationMessage("No active session.");
        return;
      }

      // Check if there are any uncommitted changes relative to Git HEAD
      const repoPath = services.wsClient.getRepoPath();
      if (repoPath) {
        const git = new GitService({ repoPath });
        try {
          const status = await git.getStatus();
          if (status.clean) {
            // Leave silently since there are no changes, but discard Yjs session drafts
            await services.wsClient.discardSession();
            stateManager.clearSession();
            void services.sidebarProvider.refresh();
            services.broadcastHub.log("info", "Left collaborative session silently (no changes)");
            void vscode.window.showInformationMessage("Left collaborative session (no changes).");
            return;
          }
        } catch (err) {
          // Fallback to prompting on check failure
        }
      }

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(save) Save Draft",
            description: "Save collaborative changes as a draft to restore later",
            value: "draft" as const
          },
          {
            label: "$(trash) Discard Draft",
            description: "Discard all collaborative changes and leave",
            value: "discard" as const
          },
          {
            label: "$(x) Cancel Operation",
            description: "Cancel leaving the session",
            value: "cancel" as const
          }
        ],
        {
          title: "Leave Session",
          placeHolder: "What do you want to do with your collaborative changes?"
        }
      );

      if (!choice || choice.value === "cancel") {
        return;
      }

      switch (choice.value) {
        case "draft": {
          try {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Saving collaborative draft…",
                cancellable: false
              },
              async () => {
                await services.wsClient.saveDraftFromSession();
              }
            );
            await services.wsClient.disconnect();
            stateManager.clearSession();
            void services.sidebarProvider.refresh();
            services.broadcastHub.log("info", "Left session and saved draft");
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Failed to save draft: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          break;
        }

        case "discard": {
          const confirm = await vscode.window.showWarningMessage(
            "Discard all collaborative changes? This cannot be undone.",
            { modal: true },
            "Discard"
          );
          if (confirm !== "Discard") {
            return;
          }

          try {
            await services.wsClient.discardSession();
            stateManager.clearSession();
            void services.sidebarProvider.refresh();
            services.broadcastHub.log(
              "info",
              "Left session and discarded changes"
            );
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Failed to discard session: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          break;
        }
      }
    });
};
