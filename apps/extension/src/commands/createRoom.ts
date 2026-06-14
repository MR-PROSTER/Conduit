import * as crypto from "node:crypto";
import * as vscode from "vscode";

import type { Room } from "@conduit/shared-types";

import type { ExtensionServices } from "../extension.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

export const createRoomCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.createRoom", async () => {
    try {
      const auth = await services.authService.requireState();
      const stateManager = getStateManager();
      const state = stateManager.get();
      if (state.state === "IN_ROOM_NO_SESSION" || state.state === "IN_ROOM_IN_SESSION") {
        const leaveAction = await vscode.window.showWarningMessage(
          `You are already in room "${state.room?.name || "another room"}". Would you like to leave it before continuing?`,
          { modal: true },
          "Leave and Continue",
          "Cancel"
        );
        if (leaveAction !== "Leave and Continue") {
          return;
        }
        await vscode.commands.executeCommand("conduit.leaveRoom");
        if (stateManager.get().state !== "SIGNED_IN_NO_ROOM") {
          return;
        }
      }

      const name = await vscode.window.showInputBox({
        prompt: "Room name",
        placeHolder: "e.g. ProjectAlpha"
      });
      if (name === undefined) {
        return;
      }

      const roomName = name.trim();
      if (roomName.length === 0) {
        throw new Error("Room name cannot be empty.");
      }

      const repoUrl =
        (await services.wsClient.getRepoRemoteUrl()) ??
        vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
        "file://local-workspace";
      const defaultBranch = (await services.wsClient.getCurrentBranch()) ?? "main";
      const room: Room = {
        id: crypto.randomUUID(),
        name: roomName,
        repoUrl,
        defaultBranch,
        ownerId: auth.user.id
      };

      const backendRoom = await services.authService.createRoom(
        room,
        auth.accessToken
      );
      getStateManager().setRoom(backendRoom);
      void services.sidebarProvider.refresh();
      vscode.window.showInformationMessage(`Room "${roomName}" created.`);
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  });
};
