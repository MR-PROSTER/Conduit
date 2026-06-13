import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";

/**
 * Reconnects the active session on a different branch scope.
 */
export const switchBranchCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.switchBranch", async () => {
    const currentState = services.wsClient.getState();
    if (
      !currentState.session ||
      !currentState.room ||
      !currentState.websocketUrl
    ) {
      void vscode.window.showWarningMessage(
        "No active Conduit session to switch."
      );
      return;
    }

    const availableBranches = await services.wsClient.listBranches();
    const branch =
      (await vscode.window.showQuickPick(availableBranches, {
        title: "Switch Branch Session",
        placeHolder: currentState.session.branch
      })) ??
      (await vscode.window.showInputBox({
        prompt: "New branch",
        value: currentState.session.branch
      }));
    if (!branch) {
      return;
    }

    await services.wsClient.switchBranch(branch);

    services.broadcastHub.log(
      "info",
      `Switched collaboration scope to branch ${branch}`
    );
  });
};
