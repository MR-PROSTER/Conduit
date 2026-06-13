import * as vscode from "vscode";
import type { ExtensionServices } from "./index.js";

export function leaveSessionCommand(services: ExtensionServices): vscode.Disposable {
  return vscode.commands.registerCommand("conduit.leaveSession", async () => {
    try {
      const snapshot = services.broadcastHub.getSnapshot();
      if (snapshot.state === "disconnected") {
        vscode.window.showInformationMessage("No active session to leave.");
        return;
      }

      const options = [
        {
          label: "Commit changes",
          description: "Commit and save changes to Git, then disconnect",
          value: "COMMIT",
        },
        {
          label: "Save as draft",
          description: "Save session progress as a draft and disconnect",
          value: "DRAFT",
        },
        {
          label: "Discard and leave",
          description: "Disconnect and discard any unsaved progress since last save",
          value: "DISCARD",
        },
      ];

      const selected = await vscode.window.showQuickPick(options, {
        title: "Leave Session Options",
        placeHolder: "Select how you would like to leave this session",
      });

      if (!selected) {
        return;
      }

      if (selected.value === "COMMIT") {
        const commitMessage = await vscode.window.showInputBox({
          title: "Commit Changes",
          prompt: "Enter commit message",
          validateInput: (value) => (value.trim() ? null : "Commit message cannot be empty"),
        });

        if (!commitMessage) {
          return;
        }

        await services.gitService.commit(commitMessage, { all: true });
        await services.wsClient.disconnect(true);
        vscode.window.showInformationMessage("Changes committed and session disconnected.");
      } else if (selected.value === "DRAFT") {
        await services.wsClient.disconnect(true);
        vscode.window.showInformationMessage("Session saved as draft and disconnected.");
      } else if (selected.value === "DISCARD") {
        await services.wsClient.disconnect(false);
        vscode.window.showInformationMessage("Session disconnected without saving draft.");
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to leave session: ${err.message}`);
    }
  });
}
