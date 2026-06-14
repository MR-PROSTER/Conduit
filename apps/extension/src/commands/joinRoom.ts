import * as vscode from "vscode";

import type { Room } from "@conduit/shared-types";
import { GitService } from "@conduit/git-core";

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
      const expectedRepoUrl = roomToJoin.repoUrl?.trim();
      if (!localRepoUrl) {
        void vscode.window.showWarningMessage(
          `Warning: No repository remote URL found. To join this room, you should open the respective repository (${expectedRepoUrl || "unknown repository"}).`
        );
      } else if (expectedRepoUrl && localRepoUrl.trim() !== expectedRepoUrl) {
        void vscode.window.showWarningMessage(
          `Warning: Your open repository (${localRepoUrl}) does not match this room's repository (${expectedRepoUrl}). Please make sure you are in the respective repository.`
        );
      } else if (localRepoUrl && expectedRepoUrl && localRepoUrl.trim() === expectedRepoUrl) {
        const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (repoPath) {
          try {
            const git = new GitService({ repoPath });
            const emailsToCheck: string[] = [];
            if (auth.user.email) {
              emailsToCheck.push(auth.user.email);
            }
            if (auth.user.username) {
              emailsToCheck.push(auth.user.username);
            }
            const isContributor = await git.checkIsContributor(emailsToCheck);
            if (!isContributor) {
              void vscode.window.showWarningMessage(
                "Warning: You are not a contributor to this repository. In order to collaborate, one must be a contributor to the repository."
              );
            }
          } catch (err) {
            // Ignore Git check errors
          }
        }
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
