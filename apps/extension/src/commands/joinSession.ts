import * as vscode from "vscode";
import * as Y from "yjs";
import type { ExtensionServices } from "./index.js";
import type { Room, Session } from "@codesync/shared-types";

export function joinSessionCommand(services: ExtensionServices): vscode.Disposable {
  return vscode.commands.registerCommand("codesync.joinSession", async () => {
    try {
      const authState = services.authService.getState();
      if (!authState.accessToken || !authState.user) {
        throw new Error("You must be signed in to join a session.");
      }

      const token = authState.accessToken;
      const config = vscode.workspace.getConfiguration("codesync");
      const backendUrl = config.get<string>("backendUrl") || "http://localhost:3000";

      const sessionsResponse = await fetch(`${backendUrl}/sessions?status=active`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!sessionsResponse.ok) {
        throw new Error(`Failed to fetch active sessions: ${sessionsResponse.statusText}`);
      }

      const sessions = (await sessionsResponse.json()) as Session[];

      if (sessions.length === 0) {
        vscode.window.showInformationMessage("No active collaboration sessions found.");
        return;
      }

      const roomsResponse = await fetch(`${backendUrl}/rooms`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const rooms = roomsResponse.ok ? ((await roomsResponse.json()) as Room[]) : [];
      const roomsMap = new Map(rooms.map((r) => [r.id, r]));

      const sessionItems = sessions.map((s) => {
        const room = roomsMap.get(s.roomId);
        return {
          label: `Branch: ${s.branch}`,
          description: room ? `Room: ${room.name}` : `Room ID: ${s.roomId}`,
          detail: `Session ID: ${s.id}`,
          value: { session: s, room },
        };
      });

      const selected = await vscode.window.showQuickPick(sessionItems, {
        title: "Join Collaboration Session",
        placeHolder: "Select a session to join",
      });

      if (!selected) {
        return;
      }

      const { session, room } = selected.value;

      let finalRoom = room;
      if (!finalRoom) {
        const roomResponse = await fetch(`${backendUrl}/rooms/${session.roomId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (roomResponse.ok) {
          finalRoom = (await roomResponse.json()) as Room;
        }
      }

      if (!finalRoom) {
        throw new Error("Failed to load room details for validation.");
      }

      const currentRemoteUrl = (await services.gitService.getRepoRemoteUrl()) || "";
      if (
        currentRemoteUrl &&
        finalRoom.repoUrl &&
        currentRemoteUrl.replace(/\.git$/, "") !== finalRoom.repoUrl.replace(/\.git$/, "")
      ) {
        throw new Error(
          `Repository mismatch! Current remote '${currentRemoteUrl}' does not match session's repository '${finalRoom.repoUrl}'.`
        );
      }

      const websocketUrl = config.get<string>("websocketUrl") || "ws://localhost:3000";
      const doc = new Y.Doc();

      await services.wsClient.connect({
        websocketUrl,
        roomId: finalRoom.id,
        branch: session.branch,
        sessionId: session.id,
        userId: authState.user.id,
        doc,
        baseCommitHash: session.baseCommitHash,
      });

      vscode.window.showInformationMessage(`Successfully joined session on branch '${session.branch}'!`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to join session: ${err.message}`);
    }
  });
}
