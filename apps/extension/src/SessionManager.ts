import * as vscode from "vscode";
import type { CodeSyncWebSocketClient } from "./wsClient.js";
import type { IGitService } from "@codesync/git-core";
import type { BranchSessionRegistry } from "./BranchSessionRegistry.js";
import type { DraftRestoreController } from "./DraftRestoreController.js";

export class SessionManager {
  constructor(
    private readonly wsClient: CodeSyncWebSocketClient,
    private readonly gitService: IGitService,
    private readonly branchSessionRegistry: BranchSessionRegistry,
    private readonly draftRestoreController: DraftRestoreController
  ) {}

  async switchBranch(targetBranch: string): Promise<void> {
    // 1. disconnect
    // 2. awareness null
    // 3. saveDraft if last (handled inside wsClient.disconnect())
    await this.wsClient.disconnect();

    // 4. stash dirty
    const status = await this.gitService.getStatus();
    if (!status.clean) {
      await this.gitService.stash(`Stash before switching to ${targetBranch}`);
    }

    // 5. checkout
    await this.gitService.checkout(targetBranch);

    // 6. reconnect
    const descriptor = this.branchSessionRegistry.get(targetBranch);
    if (descriptor) {
      await this.wsClient.restoreSession({
        roomId: descriptor.roomId,
        branch: descriptor.branch,
        sessionId: descriptor.sessionId,
      });
    }

    // 7. prompt draft restore
    await this.draftRestoreController.promptToRestoreUnresolvedDrafts();
  }
}
