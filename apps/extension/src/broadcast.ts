import * as vscode from "vscode";
import type { Room, Session } from "@codesync/shared-types";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export interface CollaboratorPresence {
  userId: string;
  name: string;
  color: string;
  status: "online" | "offline";
}

export interface CollaborationSnapshot {
  room?: Room;
  session?: Session;
  roomId?: string;
  websocketUrl?: string;
  state: ConnectionState;
  participantCount: number;
  collaborators: CollaboratorPresence[];
  lastError?: string;
}

export type CollaborationEvent =
  | { type: "snapshot"; snapshot: CollaborationSnapshot }
  | { type: "log"; level: string; message: string };

export class BroadcastHub implements vscode.Disposable {
  private readonly _onDidBroadcast = new vscode.EventEmitter<CollaborationEvent>();
  public readonly onDidBroadcast: vscode.Event<CollaborationEvent> = this._onDidBroadcast.event;

  private _currentSnapshot: CollaborationSnapshot = {
    state: "disconnected",
    participantCount: 0,
    collaborators: [],
  };

  getSnapshot(): CollaborationSnapshot {
    return this._currentSnapshot;
  }

  publishSnapshot(snapshot: CollaborationSnapshot): void {
    this._currentSnapshot = snapshot;
    this._onDidBroadcast.fire({ type: "snapshot", snapshot });
  }

  log(level: string, message: string): void {
    this._onDidBroadcast.fire({ type: "log", level, message });
  }

  dispose(): void {
    this._onDidBroadcast.dispose();
  }
}
