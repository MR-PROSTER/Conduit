import * as vscode from "vscode";

import type { Room } from "@conduit/shared-types";

import type { ExtensionServices } from "../extension.js";
import { getStateManager } from "../state/ExtensionStateManager.js";

async function listRooms(
  services: ExtensionServices,
  accessToken: string
): Promise<readonly Room[]> {
  const response = await fetch(`${services.authService.backendUrl}/rooms`, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  const body = (await response.json().catch(() => ({}))) as {
    readonly error?: string;
    readonly rooms?: readonly Room[];
  };

  if (!response.ok) {
    if (response.status === 401) {
      await services.authService.signOut();
    }

    throw new Error(
      body.error ?? `Conduit request failed with ${String(response.status)}`
    );
  }

  return body.rooms ?? [];
}

export const joinRoomCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.joinRoom", async () => {
    try {
      const auth = await services.authService.requireState();
      const rooms = await listRooms(services, auth.accessToken);

      const picked = await vscode.window.showQuickPick(
        rooms.map((room) => ({
          label: room.name,
          description: room.repoUrl || room.id,
          room
        })),
        {
          placeHolder: "Select a room to join"
        }
      );
      if (!picked) {
        return;
      }

      const localRepoUrl = await services.wsClient.getRepoRemoteUrl();
      if (
        localRepoUrl &&
        picked.room.repoUrl &&
        localRepoUrl.trim() !== picked.room.repoUrl.trim()
      ) {
        void vscode.window.showWarningMessage(
          `This room was created for ${picked.room.repoUrl}, but your local remote is ${localRepoUrl}. Joining anyway.`
        );
      }

      getStateManager().setRoom(picked.room);
      void services.sidebarProvider.refresh();
      vscode.window.showInformationMessage(`Joined room "${picked.room.name}".`);
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  });
};
