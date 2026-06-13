import * as vscode from "vscode";

export type ConduitState =
  | "SIGNED_OUT"
  | "SIGNED_IN_NO_ROOM"
  | "IN_ROOM_NO_SESSION"
  | "IN_ROOM_IN_SESSION";

export interface StatePayload {
  state: ConduitState;
  user: { id: string; email: string; username: string } | null;
  room: {
    id: string;
    name: string;
    repoUrl: string;
    defaultBranch: string;
  } | null;
  session: {
    id: string;
    branch: string;
    baseCommitHash: string;
  } | null;
}

export class ExtensionStateManager implements vscode.Disposable {
  private static instance: ExtensionStateManager | undefined;

  private readonly emitter = new vscode.EventEmitter<StatePayload>();
  public readonly onDidChangeState = this.emitter.event;

  private state: StatePayload = {
    state: "SIGNED_OUT",
    user: null,
    room: null,
    session: null,
  };

  public static getInstance(): ExtensionStateManager {
    if (!ExtensionStateManager.instance) {
      ExtensionStateManager.instance = new ExtensionStateManager();
    }

    return ExtensionStateManager.instance;
  }

  public get(): StatePayload {
    return this.state;
  }

  public signIn(user: { id: string; email: string; username: string }): void {
    this.assertState("SIGNED_OUT", "signIn");
    this.updateState({
      state: "SIGNED_IN_NO_ROOM",
      user: sanitizeUser(user),
      room: null,
      session: null,
    });
  }

  public signOut(): void {
    this.assertNotState("SIGNED_OUT", "signOut");
    this.updateState({
      state: "SIGNED_OUT",
      user: null,
      room: null,
      session: null,
    });
  }

  public setRoom(room: {
    id: string;
    name: string;
    repoUrl: string;
    defaultBranch: string;
  }): void {
    this.assertState("SIGNED_IN_NO_ROOM", "setRoom");
    this.updateState({
      state: "IN_ROOM_NO_SESSION",
      user: this.state.user,
      room: sanitizeRoom(room),
      session: null,
    });
  }

  public clearRoom(): void {
    this.assertStateOneOf(["IN_ROOM_NO_SESSION", "IN_ROOM_IN_SESSION"], "clearRoom");
    this.updateState({
      state: "SIGNED_IN_NO_ROOM",
      user: this.state.user,
      room: null,
      session: null,
    });
  }

  public setSession(session: {
    id: string;
    branch: string;
    baseCommitHash: string;
  }): void {
    this.assertState("IN_ROOM_NO_SESSION", "setSession");
    this.updateState({
      state: "IN_ROOM_IN_SESSION",
      user: this.state.user,
      room: this.state.room,
      session: sanitizeSession(session),
    });
  }

  public clearSession(): void {
    this.assertState("IN_ROOM_IN_SESSION", "clearSession");
    this.updateState({
      state: "IN_ROOM_NO_SESSION",
      user: this.state.user,
      room: this.state.room,
      session: null,
    });
  }

  public dispose(): void {
    this.emitter.dispose();
  }

  private updateState(nextState: StatePayload): void {
    this.state = nextState;
    this.emitter.fire(this.state);
  }

  private assertState(expected: ConduitState, operation: string): void {
    if (this.state.state !== expected) {
      throw new Error(
        `${operation}() is only allowed when state is ${expected}, current state is ${this.state.state}`
      );
    }
  }

  private assertStateOneOf(expected: readonly ConduitState[], operation: string): void {
    if (!expected.includes(this.state.state)) {
      throw new Error(
        `${operation}() is only allowed when state is ${expected.join(" or ")}, current state is ${this.state.state}`
      );
    }
  }

  private assertNotState(disallowed: ConduitState, operation: string): void {
    if (this.state.state === disallowed) {
      throw new Error(
        `${operation}() is not allowed when state is ${disallowed}`
      );
    }
  }
}

export function getStateManager(): ExtensionStateManager {
  return ExtensionStateManager.getInstance();
}

function sanitizeUser(user: { id: string; email: string; username: string }): {
  id: string;
  email: string;
  username: string;
} {
  return {
    id: String(user.id),
    email: String(user.email),
    username: String(user.username),
  };
}

function sanitizeRoom(room: {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
}): {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
} {
  return {
    id: String(room.id),
    name: String(room.name),
    repoUrl: String(room.repoUrl),
    defaultBranch: String(room.defaultBranch),
  };
}

function sanitizeSession(session: {
  id: string;
  branch: string;
  baseCommitHash: string;
}): {
  id: string;
  branch: string;
  baseCommitHash: string;
} {
  return {
    id: String(session.id),
    branch: String(session.branch),
    baseCommitHash: String(session.baseCommitHash),
  };
}
