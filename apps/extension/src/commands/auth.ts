import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

export const signInCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.signIn", async () => {
    try {
      const user = await services.authService.signInWithGitHub();
      getStateManager().signIn({
        id: user.id,
        email: user.email ?? user.id,
        username: user.username ?? user.email ?? user.id
      });
      void services.sidebarProvider.refresh();
      vscode.window.showInformationMessage(
        `Signed in to Conduit as ${user.email ?? user.id}.`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to sign in to Conduit: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
};

export const signOutCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.signOut", async () => {
    try {
      const current = getStateManager().get();
      if (current.state === "SIGNED_OUT") {
        return;
      }

      if (current.state === "IN_ROOM_IN_SESSION") {
        await vscode.commands.executeCommand("conduit.leaveSession");
        if (getStateManager().get().state === "IN_ROOM_IN_SESSION") {
          return;
        }
      }

      if (current.state === "IN_ROOM_NO_SESSION") {
        await services.wsClient.disconnect();
        getStateManager().clearRoom();
      }

      await services.authService.signOut();
      await services.wsClient.disconnect();
      getStateManager().signOut();
      void services.sidebarProvider.refresh();
      vscode.window.showInformationMessage("Signed out of Conduit.");
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to sign out of Conduit: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
};

export const showAccountCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.showAccount", async () => {
    try {
      const state = await services.authService.getState();
      if (!state.accessToken || !state.user) {
        vscode.window.showInformationMessage("Conduit: Not signed in.");
        return;
      }

      const user = await services.authService.refreshMe();
      void services.sidebarProvider.refresh();
      vscode.window.showInformationMessage(
        `Conduit account: ${user.username || user.email || user.id}.`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to retrieve account: ${err?.message || err || "Unknown error"}`
      );
    }
  });
};
