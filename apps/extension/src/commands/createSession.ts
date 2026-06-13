import * as vscode from "vscode";
import * as crypto from "node:crypto";

import type { Room, Session } from "@conduit/shared-types";

import type { ExtensionServices } from "../extension.js";
import { createSessionId } from "../sessionKeys.js";

/**
 * Prompts for session metadata and starts a new collaborative connection.
 */
export const createSessionCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.createSession", async () => {
    const auth = await services.authService.requireState();
    const roomIdInput = await vscode.window.showInputBox({
      prompt: "Room Name / ID (Leave blank to generate a random room)",
      placeHolder: "e.g., My Collaboration Room"
    });
    if (roomIdInput === undefined) {
      return;
    }

    const isUuid = (val: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

    const getDeterministicUuid = (input: string): string => {
      const hash = crypto.createHash("sha256").update(input.trim().toLowerCase()).digest("hex");
      return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        `4${hash.slice(13, 16)}`,
        `8${hash.slice(17, 20)}`,
        hash.slice(20, 32)
      ].join("-");
    };

    const roomId = roomIdInput.trim().length === 0
      ? crypto.randomUUID()
      : (isUuid(roomIdInput) ? roomIdInput : getDeterministicUuid(roomIdInput));
    const roomName = roomIdInput.trim().length > 0 ? roomIdInput : "New Room";

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
    const remoteUrl = await services.wsClient.getRepoRemoteUrl();
    const room: Room = {
      id: roomId,
      name: roomName,
      repoUrl:
        remoteUrl ??
        vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
        "file://local-workspace",
      defaultBranch: branch,
      ownerId: auth.user.id
    };
    const session: Session = {
      id: sessionId,
      roomId,
      branch,
      baseCommitHash: "HEAD",
      participants: [auth.user.id],
      status: "active"
    };

    const backendRoom = await services.authService.createRoom(
      room,
      auth.accessToken
    );
    const backendSession = await services.authService.createSession(
      session,
      auth.accessToken
    );

    await services.wsClient.createSession({
      room: backendRoom,
      session: backendSession,
      websocketUrl: services.websocketUrl,
      localUserId: auth.user.id,
      localUserName: auth.user.username || auth.user.email || services.localUserName,
      accessToken: auth.accessToken
    });

    services.broadcastHub.log(
      "info",
      `Created collaborative session ${session.id} for branch ${branch}`
    );
  });
};
