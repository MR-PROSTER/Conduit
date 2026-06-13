import * as vscode from "vscode";

import type { ExtensionServices } from "../extension.js";

export const signInCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.signIn", async () => {
    try {
      const user = await services.authService.signInWithGitHub();
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
    await services.authService.signOut();
    await services.wsClient.disconnect();
    void services.sidebarProvider.refresh();
    vscode.window.showInformationMessage("Signed out of Conduit.");
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
