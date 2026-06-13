import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";

export const restoreDraftsCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.restoreDrafts", async () => {
    await services.draftRestoreController.showRestorePicker();
  });
};
