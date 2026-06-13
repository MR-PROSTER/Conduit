import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";

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
    const state = services.wsClient.getState();
    if (!state.session) {
      // No active session — nothing to do
      await services.wsClient.disconnect();
      return;
    }

    const isLast = services.wsClient.canReplaceDraftState();

    if (!isLast) {
      // Other participants are still in the session — safe to leave silently.
      // Their Yjs state will carry on without us.
      await services.wsClient.disconnect();
      services.broadcastHub.log("info", "Left collaborative session");
      void vscode.window.showInformationMessage(
        "You left the session. Other participants are still connected."
      );
      return;
    }

    // Last person in the room — prompt for what to do with the shared state.
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(save) Save Draft",
          description:
            "Save collaborative changes as a draft to restore later",
          value: "draft" as const
        },
        {
          label: "$(git-commit) Commit",
          description: "Commit collaborative changes to Git and leave",
          value: "commit" as const
        },
        {
          label: "$(trash) Discard",
          description: "Discard all collaborative changes and leave",
          value: "discard" as const
        }
      ],
      {
        title: "Leave Session — Last Participant",
        placeHolder:
          "You are the last person in this session. What do you want to do with the collaborative changes?"
      }
    );

    if (!choice) {
      // User pressed Escape — keep the session open
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
          services.broadcastHub.log("info", "Left session and saved draft");
          // Open the restore picker immediately so the user can act on the draft
          await services.draftRestoreController.showRestorePicker();
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Failed to save draft: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        break;
      }

      case "commit": {
        const message = await vscode.window.showInputBox({
          title: "Commit Collaborative Changes",
          prompt: "Enter a commit message",
          placeHolder: "feat: collaborative session changes",
          validateInput: (value) =>
            value.trim().length === 0
              ? "Commit message cannot be empty"
              : undefined
        });
        if (!message) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Committing collaborative changes…",
              cancellable: false
            },
            async () => {
              await services.wsClient.commitSession(message.trim());
            }
          );
          await services.wsClient.disconnect();
          services.broadcastHub.log(
            "info",
            "Left session and committed changes"
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Failed to commit: ${
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
