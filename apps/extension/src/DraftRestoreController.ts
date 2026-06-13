import * as vscode from "vscode";
import type { ConduitWebSocketClient } from "./wsClient.js";

export class DraftRestoreController {
  constructor(private readonly wsClient: ConduitWebSocketClient) {}

  async promptToRestoreUnresolvedDrafts(): Promise<void> {
    try {
      const drafts = await this.wsClient.listDraftsFn({ status: "active" });

      for (const draft of drafts) {
        if (draft.status !== "active") {
          continue;
        }

        const selection = await vscode.window.showQuickPick(
          [
            {
              label: "Restore",
              description: `Restore draft on branch '${draft.branch}' created at ${new Date(draft.createdAt).toLocaleString()}`,
            },
            {
              label: "Discard",
              description: "Discard this draft permanently",
            },
            {
              label: "Skip",
              description: "Leave this draft active and decide later",
            },
          ],
          {
            title: `Unresolved Draft found for branch: ${draft.branch}`,
            placeHolder: "Select an action for this draft",
            ignoreFocusOut: true,
          }
        );

        if (!selection) {
          continue;
        }

        if (selection.label === "Restore") {
          await this.wsClient.restoreSession({
            roomId: draft.roomId,
            branch: draft.branch,
            sessionId: draft.sessionId,
          });
        } else if (selection.label === "Discard") {
          await this.wsClient.updateDraftStatusFn(draft.id, "discarded");
        }
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to check or restore active drafts: ${error.message}`);
    }
  }
}
