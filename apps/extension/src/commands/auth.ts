import * as vscode from "vscode";
import type { ExtensionServices } from "./index.js";

export function signInCommand(services: ExtensionServices): vscode.Disposable {
  return vscode.commands.registerCommand("codesync.signIn", async () => {
    try {
      const state = await services.authService.signIn();
      const currentSnapshot = services.broadcastHub.getSnapshot();
      services.broadcastHub.publishSnapshot({
        ...currentSnapshot,
        collaborators: state.user
          ? [
              {
                userId: state.user.id,
                name: state.user.name || "Me",
                color: "#0000ff",
                status: "online",
              },
            ]
          : currentSnapshot.collaborators,
      });
      vscode.window.showInformationMessage(`Signed in successfully as ${state.user?.name || "user"}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Sign in failed: ${err.message}`);
    }
  });
}

export function signOutCommand(services: ExtensionServices): vscode.Disposable {
  return vscode.commands.registerCommand("codesync.signOut", async () => {
    try {
      await services.authService.signOut();
      await services.wsClient.disconnect(false);
      vscode.window.showInformationMessage("Signed out successfully.");
    } catch (err: any) {
      vscode.window.showErrorMessage(`Sign out failed: ${err.message}`);
    }
  });
}

export function showAccountCommand(services: ExtensionServices): vscode.Disposable {
  return vscode.commands.registerCommand("codesync.showAccount", async () => {
    const state = services.authService.getState();
    if (!state.accessToken || !state.user) {
      vscode.window.showInformationMessage("Not signed in.");
      return;
    }

    const selection = await vscode.window.showQuickPick(
      [
        { label: `User: ${state.user.name || "No name"}` },
        { label: `Email: ${state.user.email || "No email"}` },
        { label: "Sign Out", description: "Sign out of your account" },
      ],
      { title: "CodeSync Account Information" }
    );

    if (selection?.label === "Sign Out") {
      await vscode.commands.executeCommand("codesync.signOut");
    }
  });
}
