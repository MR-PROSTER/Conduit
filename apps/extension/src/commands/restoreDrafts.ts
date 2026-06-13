import * as vscode from "vscode";
import type { ExtensionServices } from "./index.js";

export function restoreDraftsCommand(services: ExtensionServices): vscode.Disposable {
  return vscode.commands.registerCommand("codesync.restoreDrafts", async () => {
    try {
      await services.draftRestoreController.promptToRestoreUnresolvedDrafts();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to restore drafts: ${err.message}`);
    }
  });
}
