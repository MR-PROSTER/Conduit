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

async function joinRoomOnBackend(
  services: ExtensionServices,
  roomId: string,
  accessToken: string
): Promise<Room> {
  const response = await fetch(
    `${services.authService.backendUrl}/rooms/${encodeURIComponent(roomId)}/join`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`
      }
    }
  );

  const body = (await response.json().catch(() => ({}))) as {
    readonly error?: string;
    readonly room?: Room;
  };

  if (!response.ok) {
    throw new Error(
      body.error ?? `Failed to join room: ${String(response.status)}`
    );
  }

  if (!body.room) {
    throw new Error("Failed to join room: Invalid server response");
  }

  return body.room;
}

export const joinRoomCommand = (
  services: ExtensionServices
): vscode.Disposable => {
  return vscode.commands.registerCommand("conduit.joinRoom", async () => {
    try {
      const auth = await services.authService.requireState();
      const rooms = await listRooms(services, auth.accessToken);

      const items = [
        ...rooms.map((room) => ({
          label: room.name,
          description: room.repoUrl || room.id,
          room: room as Room | null
        })),
        {
          label: "$(plus) Join Room by ID...",
          description: "Enter a room ID manually to join",
          room: null
        }
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a room to join"
      });
      if (!picked) {
        return;
      }

      let roomToJoin: Room;
      if (picked.room === null) {
        const inputId = await vscode.window.showInputBox({
          prompt: "Enter Room ID to join",
          placeHolder: "e.g. 112d9517-c912-477d-abb0-eeac6bb523ee"
        });
        if (!inputId) {
          return;
        }

        roomToJoin = await joinRoomOnBackend(services, inputId.trim(), auth.accessToken);
      } else {
        roomToJoin = picked.room;
      }

      const localRepoUrl = await services.wsClient.getRepoRemoteUrl();
      if (
        localRepoUrl &&
        roomToJoin.repoUrl &&
        localRepoUrl.trim() !== roomToJoin.repoUrl.trim()
      ) {
        void vscode.window.showWarningMessage(
          `This room was created for ${roomToJoin.repoUrl}, but your local remote is ${localRepoUrl}. Joining anyway.`
        );
      }

      getStateManager().setRoom(roomToJoin);
      void services.sidebarProvider.refresh();
      vscode.window.showInformationMessage(`Joined room "${roomToJoin.name}".`);
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  });
};
