import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

export const leaveRoomCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.leaveRoom", async () => {
    try {
      const stateManager = getStateManager();
      const state = stateManager.get();

      if (state.state === "IN_ROOM_IN_SESSION") {
        await vscode.commands.executeCommand("conduit.leaveSession");
        if (stateManager.get().state === "IN_ROOM_IN_SESSION") {
          return;
        }
      }

      await services.wsClient.disconnect();
      stateManager.clearRoom();
      void services.sidebarProvider.refresh();
      vscode.window.showInformationMessage("Left room.");
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  });
};
