import * as vscode from "vscode";

export interface SessionDescriptor {
  roomId: string;
  branch: string;
  sessionId: string;
  websocketUrl: string;
  userId: string;
}

export class BranchSessionRegistry {
  private readonly workspaceState: vscode.Memento;
  private readonly keyPrefix = "codesync:branch-session:";

  constructor(context: vscode.ExtensionContext) {
    this.workspaceState = context.workspaceState;
  }

  async save(branch: string, descriptor: SessionDescriptor): Promise<void> {
    await this.workspaceState.update(this.getKey(branch), descriptor);
  }

  get(branch: string): SessionDescriptor | undefined {
    return this.workspaceState.get<SessionDescriptor>(this.getKey(branch));
  }

  async clear(branch: string): Promise<void> {
    await this.workspaceState.update(this.getKey(branch), undefined);
  }

  async clearAll(): Promise<void> {
    const keys = this.workspaceState.keys();
    for (const key of keys) {
      if (key.startsWith(this.keyPrefix)) {
        await this.workspaceState.update(key, undefined);
      }
    }
  }

  private getKey(branch: string): string {
    return `${this.keyPrefix}${branch}`;
  }
}
