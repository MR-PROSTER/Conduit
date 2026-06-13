import * as vscode from "vscode";

import type { Room, Session } from "@conduit/shared-types";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface CollaborationSnapshot {
  readonly room: Room | undefined;
  readonly session: Session | undefined;
  readonly roomId: string | undefined;
  readonly websocketUrl: string | undefined;
  readonly state: ConnectionState;
  readonly participantCount: number;
  readonly collaborators: readonly CollaboratorPresence[];
  readonly lastError: string | undefined;
}

export interface CollaboratorPresence {
  readonly userId: string;
  readonly name: string;
  readonly color: string;
  readonly status: "online" | "offline";
}

export type CollaborationEvent =
  | {
      readonly type: "snapshot";
      readonly snapshot: CollaborationSnapshot;
    }
  | {
      readonly type: "log";
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    };

/**
 * Event bus for extension services, commands, and the sidebar UI.
 */
export class BroadcastHub implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CollaborationEvent>();
  private snapshot: CollaborationSnapshot = {
    room: undefined,
    session: undefined,
    roomId: undefined,
    websocketUrl: undefined,
    state: "disconnected",
    participantCount: 0,
    collaborators: [],
    lastError: undefined
  };

  public readonly onDidBroadcast = this.emitter.event;

  public getSnapshot(): CollaborationSnapshot {
    return this.snapshot;
  }

  public publishSnapshot(snapshot: CollaborationSnapshot): void {
    this.snapshot = snapshot;
    this.emitter.fire({
      type: "snapshot",
      snapshot
    });
  }

  public log(
    level: "info" | "warn" | "error",
    message: string
  ): void {
    this.emitter.fire({
      type: "log",
      level,
      message
    });
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}
