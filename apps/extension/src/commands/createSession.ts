import * as vscode from "vscode";
import * as Y from "yjs";
import type { ExtensionServices } from "./index.js";
import type { Room, Session } from "@conduit/shared-types";

export function createSessionCommand(services: ExtensionServices): vscode.Disposable {
    return vscode.commands.registerCommand("conduit.createSession", async () => {
        try {
            const authState = services.authService.getState();
            if (!authState.accessToken || !authState.user) {
                throw new Error("You must be signed in to create a session.");
            }

            const token = authState.accessToken;
            const config = vscode.workspace.getConfiguration("conduit");
            const backendUrl = config.get<string>("backendUrl") || "http://localhost:4000";

            const branchInfo = await services.gitService.getCurrentBranch();
            const headCommit = await services.gitService.getHead();

            const roomsResponse = await fetch(`${backendUrl}/rooms`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!roomsResponse.ok) {
                throw new Error(`Failed to fetch rooms: ${roomsResponse.statusText}`);
            }
            const rooms = (await roomsResponse.json()) as Room[];

            const roomItems = [
                { label: "$(plus) Create new room...", value: "NEW" },
                ...rooms.map((r) => ({ label: r.name, description: `ID: ${r.id}`, value: r })),
            ];

            const selectedOption = await vscode.window.showQuickPick(roomItems, {
                title: "Select or Create a Room",
                placeHolder: "Choose an option",
            });

            if (!selectedOption) {
                return;
            }

            let room: Room;

            if (selectedOption.value === "NEW") {
                const roomName = await vscode.window.showInputBox({
                    title: "Create New Room",
                    prompt: "Enter room name",
                    validateInput: (value) => (value.trim() ? null : "Room name cannot be empty"),
                });

                if (!roomName) {
                    return;
                }

                const repoUrl = (await services.gitService.getRepoRemoteUrl()) || "";

                const createRoomResponse = await fetch(`${backendUrl}/rooms`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        name: roomName,
                        repoUrl,
                        defaultBranch: branchInfo.branch,
                    }),
                });

                if (!createRoomResponse.ok) {
                    throw new Error(`Failed to create room: ${createRoomResponse.statusText}`);
                }

                room = (await createRoomResponse.json()) as Room;
            } else {
                room = selectedOption.value as Room;
            }

            const createSessionResponse = await fetch(`${backendUrl}/sessions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    roomId: room.id,
                    branch: branchInfo.branch,
                    baseCommitHash: headCommit,
                }),
            });

            if (!createSessionResponse.ok) {
                throw new Error(`Failed to create session: ${createSessionResponse.statusText}`);
            }

            const session = (await createSessionResponse.json()) as Session;

            const websocketUrl = config.get<string>("websocketUrl") || "ws://localhost:4000";
            const doc = new Y.Doc();

            await services.wsClient.connect({
                websocketUrl,
                roomId: room.id,
                branch: branchInfo.branch,
                sessionId: session.id,
                userId: authState.user.id,
                doc,
                baseCommitHash: headCommit,
            });

            vscode.window.showInformationMessage(`Collaboration session started in room '${room.name}'!`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create session: ${err.message}`);
        }
    });
}
