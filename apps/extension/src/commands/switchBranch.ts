import * as vscode from "vscode";
import type { ExtensionServices } from "./index.js";

export function switchBranchCommand(services: ExtensionServices): vscode.Disposable {
  return vscode.commands.registerCommand("conduit.switchBranch", async () => {
    try {
      const branches = await services.gitService.listBranches(false);

      if (branches.length === 0) {
        vscode.window.showInformationMessage("No git branches found.");
        return;
      }

      const branchItems = branches.map((b) => ({
        label: b.name,
        description: b.current ? "Current branch" : "",
        value: b,
      }));

      const selected = await vscode.window.showQuickPick(branchItems, {
        title: "Switch Git Branch & Session",
        placeHolder: "Select a branch to switch to",
      });

      if (!selected) {
        return;
      }

      if (selected.value.current) {
        vscode.window.showInformationMessage(`Already on branch '${selected.value.name}'.`);
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Switching to branch '${selected.value.name}'...`,
          cancellable: false,
        },
        async () => {
          await services.sessionManager.switchBranch(selected.value.name);
        }
      );

      vscode.window.showInformationMessage(`Successfully switched to branch '${selected.value.name}'!`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to switch branch: ${err.message}`);
    }
  });
}
