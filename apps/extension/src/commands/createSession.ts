import * as vscode from "vscode";
import type { Session } from "@conduit/shared-types";

import type { ExtensionServices } from "../extension.js";
import { createSessionId } from "../sessionKeys.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

/**
 * Prompts for session metadata and starts a new collaborative connection.
 */
export const createSessionCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.createSession", async () => {
    try {
      const auth = await services.authService.requireState();
      const state = getStateManager().get();
      if (state.state !== "IN_ROOM_NO_SESSION") {
        throw new Error("Create or join a room before creating a session.");
      }
      const { room } = state;
      if (!room) {
        throw new Error("Create or join a room before creating a session.");
      }

      const currentBranch = await services.wsClient.getCurrentBranch();
      const availableBranches = await services.wsClient.listBranches();
      const branch =
        (await vscode.window.showQuickPick(availableBranches, {
          title: "Branch",
          placeHolder: currentBranch ?? "Select a branch"
        })) ??
        (await vscode.window.showInputBox({
          prompt: "Branch",
          placeHolder: currentBranch ?? "main",
          value: currentBranch ?? "main"
        }));
      if (!branch) {
        return;
      }

      const sessionId = createSessionId();
      const session: Session = {
        id: sessionId,
        roomId: room.id,
        branch,
        baseCommitHash: "HEAD",
        participants: [auth.user.id],
        status: "active"
      };
      const backendSession = await services.authService.createSession(
        session,
        auth.accessToken
      );

      await services.wsClient.createSession({
        room: room as unknown as Parameters<
          typeof services.wsClient.createSession
        >[0]["room"],
        session: backendSession,
        websocketUrl: services.websocketUrl,
        localUserId: auth.user.id,
        localUserName:
          auth.user.username || auth.user.email || services.localUserName,
        accessToken: auth.accessToken
      });

      getStateManager().setSession(backendSession);
      void services.sidebarProvider.refresh();

      services.broadcastHub.log(
        "info",
        `Created collaborative session ${session.id} for branch ${branch}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  });
};
