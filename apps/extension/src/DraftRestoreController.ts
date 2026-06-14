import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

import type {
  DraftFreshnessResult,
  DraftMetadata,
  DraftRestoreResult,
  DraftRestoreStrategy
} from "@conduit/collaboration-core";

import type { ConduitWebSocketClient } from "./wsClient.js";

interface DraftQuickPickItem extends vscode.QuickPickItem {
  readonly draft: DraftMetadata;
  readonly freshness: DraftFreshnessResult;
}

export class DraftRestoreController {
  public constructor(private readonly wsClient: ConduitWebSocketClient) {}

  public async promptToRestoreUnresolvedDrafts(): Promise<void> {
    await this.wsClient.recoverLocalFallbacks();
    const drafts = await this.loadDraftItems();
    if (drafts.length === 0) {
      return;
    }

    await vscode.commands.executeCommand("workbench.view.extension.conduit");
    await this.showRestorePicker();
  }

  public async showRestorePicker(): Promise<void> {
    const draftItems = await this.loadDraftItems();
    if (draftItems.length === 0) {
      void vscode.window.showInformationMessage(
        "No unresolved Conduit drafts were found."
      );
      return;
    }

    const selectedDrafts = await vscode.window.showQuickPick(draftItems, {
      canPickMany: true,
      title: "Restore Collaborative Drafts",
      placeHolder:
        "Select one or more unresolved drafts to restore, compare, or discard"
    });
    if (!selectedDrafts || selectedDrafts.length === 0) {
      return;
    }

    if (selectedDrafts.length === 1) {
      await this.handleSingleDraftSelection(selectedDrafts[0]!, draftItems);
      return;
    }

    await this.handleMultipleDraftSelection(selectedDrafts, draftItems);
  }

  private async handleSingleDraftSelection(
    selectedDraft: DraftQuickPickItem,
    allDrafts: readonly DraftQuickPickItem[]
  ): Promise<void> {
    const actions = [
      {
        label: "Restore with Merge",
        description: "Apply Yjs update and replay filesystem operations",
        action: "restore-merge"
      },
      ...(this.wsClient.canReplaceDraftState()
        ? [
            {
              label: "Restore by Replace",
              description: "Replace Yjs state for solo restore only",
              action: "restore-replace"
            }
          ]
        : []),
      {
        label: "Interactive Three-Way Merge",
        description: "Review and resolve conflicts file-by-file",
        action: "interactive-merge"
      },
      {
        label: "Compare Drafts",
        description: "Visualize the diff against another draft",
        action: "compare"
      },
      {
        label: "Discard Draft",
        description: "Mark this unresolved draft as discarded",
        action: "discard"
      }
    ] as const;

    const selectedAction = await vscode.window.showQuickPick(actions, {
      title: `Draft ${selectedDraft.draft.draft.id}`,
      placeHolder: "Choose a collaborative draft action"
    });
    if (!selectedAction) {
      return;
    }

    switch (selectedAction.action) {
      case "restore-merge":
        await this.restoreDraft(selectedDraft, "merge");
        return;
      case "restore-replace":
        await this.restoreDraft(selectedDraft, "replace");
        return;
      case "interactive-merge":
        await this.launchInteractiveMerge(selectedDraft);
        return;
      case "compare":
        await this.promptCompareDrafts(allDrafts, selectedDraft);
        return;
      case "discard":
        await this.discardDrafts([selectedDraft]);
    }
  }

  private async handleMultipleDraftSelection(
    selectedDrafts: readonly DraftQuickPickItem[],
    allDrafts: readonly DraftQuickPickItem[]
  ): Promise<void> {
    const actions = [
      {
        label: "Compare Selected Drafts",
        description: "Choose two selected drafts and visualize the diff",
        action: "compare"
      },
      {
        label: "Restore One Selected Draft",
        description: "Pick one draft to restore without auto-merging",
        action: "restore-one"
      },
      {
        label: "Discard Selected Drafts",
        description: "Discard every selected unresolved draft",
        action: "discard"
      }
    ] as const;

    const selectedAction = await vscode.window.showQuickPick(actions, {
      title: "Selected Collaborative Drafts",
      placeHolder:
        "Multiple selection never auto-merges drafts; choose compare, restore one, or discard"
    });
    if (!selectedAction) {
      return;
    }

    switch (selectedAction.action) {
      case "compare":
        await this.promptCompareDrafts(allDrafts, ...selectedDrafts);
        return;
      case "restore-one": {
        const restoreTarget = await vscode.window.showQuickPick(
          selectedDrafts,
          {
            title: "Restore One Selected Draft",
            placeHolder: "Choose the single draft to restore"
          }
        );
        if (!restoreTarget) {
          return;
        }

        await this.handleSingleDraftSelection(restoreTarget, allDrafts);
        return;
      }
      case "discard":
        await this.discardDrafts(selectedDrafts);
    }
  }

  private async restoreDraft(
    draftItem: DraftQuickPickItem,
    strategy: DraftRestoreStrategy
  ): Promise<void> {
    try {
      const restoreResult = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Restoring draft ${draftItem.draft.draft.id}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({
            message: "Validating ancestry"
          });

          progress.report({
            increment: 25,
            message: "Applying collaborative overlay"
          });
          const result = await this.wsClient.restoreDraft(
            draftItem.draft.draft.id,
            strategy
          );

          progress.report({
            increment: 75,
            message: "Cleaning up restored draft state"
          });
          return result;
        }
      );

      if (restoreResult.outcome === "restored") {
        void vscode.window.showInformationMessage(
          `Restored collaborative draft ${restoreResult.draft.id} with ${restoreResult.strategy} strategy.`
        );
        return;
      }

      await this.handleDraftConflict(draftItem, restoreResult);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Failed to restore draft ${draftItem.draft.draft.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async handleDraftConflict(
    draftItem: DraftQuickPickItem,
    restoreResult: Extract<DraftRestoreResult, { readonly outcome: "conflict" }>
  ): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `${restoreResult.message}`,
      "Interactive Merge",
      "Compare Drafts",
      "Discard Draft",
      "Keep Fallback"
    );

    switch (choice) {
      case "Interactive Merge":
        await this.launchInteractiveMerge(draftItem);
        return;
      case "Compare Drafts":
        await this.promptCompareDrafts(await this.loadDraftItems(), draftItem);
        return;
      case "Discard Draft":
        await this.discardDrafts([draftItem]);
        return;
      default:
        return;
    }
  }

  private async discardDrafts(
    draftItems: readonly DraftQuickPickItem[]
  ): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Discard ${draftItems.length} unresolved draft${draftItems.length === 1 ? "" : "s"}?`,
      { modal: true },
      "Discard"
    );
    if (choice !== "Discard") {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Discarding collaborative drafts",
        cancellable: false
      },
      async (progress) => {
        let completed = 0;
        for (const draftItem of draftItems) {
          await this.wsClient.discardDraft(draftItem.draft.draft.id);
          completed += 1;
          progress.report({
            increment: 100 / draftItems.length,
            message: `${completed}/${draftItems.length} discarded`
          });
        }
      }
    );

    void vscode.window.showInformationMessage(
      `Discarded ${draftItems.length} collaborative draft${draftItems.length === 1 ? "" : "s"}.`
    );
  }

  private async promptCompareDrafts(
    allDrafts: readonly DraftQuickPickItem[],
    ...preferredDrafts: readonly DraftQuickPickItem[]
  ): Promise<void> {
    const availableDrafts = allDrafts.filter((draft) => {
      return draft.draft.draft.status === "active";
    });

    let leftDraft: DraftQuickPickItem | undefined = preferredDrafts[0];
    let rightDraft: DraftQuickPickItem | undefined = preferredDrafts[1];

    if (!leftDraft) {
      leftDraft = await vscode.window.showQuickPick(availableDrafts, {
        title: "Compare Drafts",
        placeHolder: "Choose the first draft (Before)"
      });
      if (!leftDraft) {
        return;
      }
    }

    if (!rightDraft) {
      rightDraft = await vscode.window.showQuickPick(
        availableDrafts.filter(
          (draft) => draft.draft.draft.id !== leftDraft!.draft.draft.id
        ),
        {
          title: "Compare Drafts",
          placeHolder: "Choose the second draft (After)"
        }
      );
      if (!rightDraft) {
        return;
      }
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      void vscode.window.showErrorMessage("No open workspace folder found.");
      return;
    }

    try {
      let fullLeftDraft = leftDraft.draft.draft;
      if (leftDraft.draft.source === "remote") {
        fullLeftDraft = await this.wsClient.getDraft(leftDraft.draft.draft.id);
      }
      let fullRightDraft = rightDraft.draft.draft;
      if (rightDraft.draft.source === "remote") {
        fullRightDraft = await this.wsClient.getDraft(rightDraft.draft.draft.id);
      }

      const draftManager = this.wsClient.getDraftManager();
      const leftFiles = draftManager.readFilesFromDraft(fullLeftDraft);
      const rightFiles = draftManager.readFilesFromDraft(fullRightDraft);

      const allPaths = [...new Set([...leftFiles.keys(), ...rightFiles.keys()])].sort((a, b) =>
        a.localeCompare(b)
      );

      const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, ".conduit", "compare-temp");
      try {
        await vscode.workspace.fs.delete(tempDir, { recursive: true, useTrash: false });
      } catch {}
      await vscode.workspace.fs.createDirectory(tempDir);

      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(tempDir, ".gitignore"),
        encoder.encode("*")
      );

      const diffUris: { left: vscode.Uri; right: vscode.Uri; relativePath: string }[] = [];

      for (const relativePath of allPaths) {
        const leftContent = leftFiles.get(relativePath) ?? "";
        const rightContent = rightFiles.get(relativePath) ?? "";

        if (leftContent === rightContent) {
          continue;
        }

        const sanitizedPath = relativePath.replace(/[\/\\:\*\?\"<>\|]/g, "_");
        const leftTempUri = vscode.Uri.joinPath(tempDir, `left_${sanitizedPath}`);
        const rightTempUri = vscode.Uri.joinPath(tempDir, `right_${sanitizedPath}`);

        await vscode.workspace.fs.writeFile(leftTempUri, encoder.encode(leftContent));
        await vscode.workspace.fs.writeFile(rightTempUri, encoder.encode(rightContent));

        diffUris.push({
          left: leftTempUri,
          right: rightTempUri,
          relativePath
        });
      }

      if (diffUris.length === 0) {
        void vscode.window.showInformationMessage("No content differences were found between the selected drafts.");
        return;
      }

      for (const diff of diffUris) {
        const title = `${path.basename(diff.relativePath)}: Draft ${fullLeftDraft.id} ↔ Draft ${fullRightDraft.id}`;
        await vscode.commands.executeCommand("vscode.diff", diff.left, diff.right, title);
      }

      void vscode.window.showInformationMessage(
        `Opened split-screen comparison for ${diffUris.length} file(s) between Draft ${fullLeftDraft.id} and Draft ${fullRightDraft.id}.`
      );

    } catch (error) {
      void vscode.window.showErrorMessage(
        `Failed to compare drafts: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async loadDraftItems(): Promise<readonly DraftQuickPickItem[]> {
    const currentBranch = await this.wsClient.getCurrentBranch();
    const activeSession = this.wsClient.getState().session;
    const drafts = (await this.wsClient.discoverDrafts()).filter((draft) => {
      if (draft.draft.status !== "active") {
        return false;
      }
      if (activeSession && draft.draft.sessionId === activeSession.id) {
        return false;
      }
      return true;
    });

    const items = await Promise.all(
      drafts.map(async (draft): Promise<DraftQuickPickItem> => {
        const freshness = await this.safeCheckDraftFreshness(
          draft.draft.id,
          draft.draft.branch
        );
        const isCurrentBranch = currentBranch === draft.draft.branch;

        return {
          label: `${isCurrentBranch ? "$(git-branch) " : ""}${draft.draft.id}`,
          description: `${draft.draft.branch} • session ${draft.draft.sessionId}`,
          detail: `${freshness.status} • ${freshness.reason}`,
          picked: isCurrentBranch,
          draft,
          freshness
        };
      })
    );

    return items.sort((left, right) => {
      if (left.picked !== right.picked) {
        return left.picked ? -1 : 1;
      }

      return right.draft.draft.createdAt.localeCompare(
        left.draft.draft.createdAt
      );
    });
  }

  private async safeCheckDraftFreshness(
    draftId: string,
    branch: string
  ): Promise<DraftFreshnessResult> {
    try {
      return await this.wsClient.checkDraftFreshness(draftId);
    } catch (error) {
      return {
        status: "unknown",
        currentBranch: branch,
        currentHead: "unknown",
        reason:
          error instanceof Error
            ? error.message
            : "Unable to validate draft freshness."
      };
    }
  }

  private async launchInteractiveMerge(draftItem: DraftQuickPickItem): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      void vscode.window.showErrorMessage("No open workspace folder found.");
      return;
    }

    try {
      let fullDraft = draftItem.draft.draft;
      if (draftItem.draft.source === "remote") {
        fullDraft = await this.wsClient.getDraft(draftItem.draft.draft.id);
      }
      const draftManager = this.wsClient.getDraftManager();
      const draftFiles = draftManager.readFilesFromDraft(fullDraft);

      const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, ".conduit", "merge-temp");
      await vscode.workspace.fs.createDirectory(tempDir);

      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(tempDir, ".gitignore"), encoder.encode("*"));

      let mergeCount = 0;

      for (const [relativePath, remoteContent] of draftFiles.entries()) {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

        // Read local content
        let localContent = "";
        let hasLocal = false;
        try {
          const localBytes = await vscode.workspace.fs.readFile(fileUri);
          localContent = new TextDecoder().decode(localBytes);
          hasLocal = true;
        } catch {
          // File does not exist locally yet
        }

        if (hasLocal && localContent === remoteContent) {
          continue;
        }

        // Read base content
        const baseCommit = fullDraft.baseCommitHash;
        let baseContent = "";
        if (baseCommit) {
          try {
            const repoPath = this.wsClient.getRepoPath();
            const { stdout } = await execFileAsync("git", ["show", `${baseCommit}:${relativePath}`], { cwd: repoPath });
            baseContent = stdout;
          } catch {
            // File might not have existed at baseCommit
          }
        }

        // Write temp files for merging
        const sanitizedPath = relativePath.replace(/[\/\\:\*\?\"<>\|]/g, "_");
        const baseTempUri = vscode.Uri.joinPath(tempDir, `base_${sanitizedPath}`);
        const localTempUri = vscode.Uri.joinPath(tempDir, `local_${sanitizedPath}`);
        const remoteTempUri = vscode.Uri.joinPath(tempDir, `draft_${sanitizedPath}`);

        await vscode.workspace.fs.writeFile(baseTempUri, encoder.encode(baseContent));
        await vscode.workspace.fs.writeFile(localTempUri, encoder.encode(localContent));
        await vscode.workspace.fs.writeFile(remoteTempUri, encoder.encode(remoteContent));

        // Ensure parent directory of output file exists
        const parentDir = vscode.Uri.joinPath(fileUri, "..");
        await vscode.workspace.fs.createDirectory(parentDir);

        // Open the merge editor
        const args = {
          base: baseTempUri,
          input1: { uri: localTempUri, title: "Current Workspace (Local)" },
          input2: { uri: remoteTempUri, title: `Draft ${fullDraft.id} (Remote)` },
          output: fileUri
        };

        await vscode.commands.executeCommand("_open.mergeEditor", args);
        mergeCount++;
      }

      if (mergeCount === 0) {
        void vscode.window.showInformationMessage("No conflicting or differing files found to merge.");
      } else {
        void vscode.window.showInformationMessage(`Opened merge editor for ${mergeCount} files. Please resolve conflicts and save the files.`);
        // Mark draft as applied in the backend
        await this.wsClient.applyDraft(fullDraft.id);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Failed to launch interactive merge: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async promptToRestoreSessionDrafts(sessionId: string): Promise<boolean> {
    await this.wsClient.recoverLocalFallbacks();
    const drafts = await this.wsClient.discoverDrafts();

    const sessionDrafts = drafts.filter((draft) => {
      return draft.draft.sessionId === sessionId && draft.draft.status === "active";
    });

    if (sessionDrafts.length === 0) {
      return false;
    }

    const draftItems = await Promise.all(
      sessionDrafts.map(async (draft): Promise<DraftQuickPickItem> => {
        const freshness = await this.safeCheckDraftFreshness(
          draft.draft.id,
          draft.draft.branch
        );
        const currentBranch = await this.wsClient.getCurrentBranch();
        const isCurrentBranch = currentBranch === draft.draft.branch;

        return {
          label: `${isCurrentBranch ? "$(git-branch) " : ""}${draft.draft.id}`,
          description: `${draft.draft.branch} • session ${draft.draft.sessionId}`,
          detail: `Created: ${new Date(draft.draft.createdAt).toLocaleString()} • ${freshness.status} • ${freshness.reason}`,
          picked: isCurrentBranch,
          draft,
          freshness
        };
      })
    );

    const selectedDraft = await vscode.window.showQuickPick(draftItems, {
      title: "Restore Session Draft",
      placeHolder: "Select a previous draft from this session to view changes and restore"
    });

    if (!selectedDraft) {
      return true; // Prompted, but user chose not to proceed
    }

    await this.showBeforeAfterChanges(selectedDraft);
    return true;
  }

  private async showBeforeAfterChanges(draftItem: DraftQuickPickItem): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      void vscode.window.showErrorMessage("No open workspace folder found.");
      return;
    }

    try {
      let fullDraft = draftItem.draft.draft;
      if (draftItem.draft.source === "remote") {
        fullDraft = await this.wsClient.getDraft(draftItem.draft.draft.id);
      }
      const draftManager = this.wsClient.getDraftManager();
      const draftFiles = draftManager.readFilesFromDraft(fullDraft);

      const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, ".conduit", "diff-temp");
      // Clean up previous temp files first if any exist
      try {
        await vscode.workspace.fs.delete(tempDir, { recursive: true, useTrash: false });
      } catch {}

      await vscode.workspace.fs.createDirectory(tempDir);

      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(tempDir, ".gitignore"),
        encoder.encode("*")
      );

      const diffUris: { left: vscode.Uri; right: vscode.Uri; relativePath: string }[] = [];

      for (const [relativePath, remoteContent] of draftFiles.entries()) {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

        // Read local content
        let localContent = "";
        let hasLocal = false;
        try {
          const localBytes = await vscode.workspace.fs.readFile(fileUri);
          localContent = new TextDecoder().decode(localBytes);
          hasLocal = true;
        } catch {
          // File does not exist locally yet
        }

        if (hasLocal && localContent === remoteContent) {
          continue;
        }

        // Write remote/draft content to temp file
        const sanitizedPath = relativePath.replace(/[\/\\:\*\?\"<>\|]/g, "_");
        const tempFileUri = vscode.Uri.joinPath(tempDir, `draft_${sanitizedPath}`);
        await vscode.workspace.fs.writeFile(tempFileUri, encoder.encode(remoteContent));

        let leftUri: vscode.Uri;
        if (hasLocal) {
          leftUri = fileUri;
        } else {
          const emptyTempUri = vscode.Uri.joinPath(tempDir, `empty_${sanitizedPath}`);
          await vscode.workspace.fs.writeFile(emptyTempUri, encoder.encode(""));
          leftUri = emptyTempUri;
        }

        diffUris.push({
          left: leftUri,
          right: tempFileUri,
          relativePath
        });
      }

      if (diffUris.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          "No content differences found between your workspace and the draft. Apply the draft anyway?",
          "Apply",
          "Cancel"
        );
        if (choice === "Apply") {
          await this.restoreDraft(draftItem, "merge");
        }
        try {
          await vscode.workspace.fs.delete(tempDir, { recursive: true, useTrash: false });
        } catch {}
        return;
      }

      // Open split-screen diffs for all differing files
      for (const diff of diffUris) {
        const title = `${path.basename(diff.relativePath)}: Workspace ↔ Draft`;
        await vscode.commands.executeCommand("vscode.diff", diff.left, diff.right, title);
      }

      const choice = await vscode.window.showInformationMessage(
        `Opened split-screen changes for ${diffUris.length} file(s). Do you want to accept and restore this draft?`,
        "Accept & Restore",
        "Decline"
      );

      if (choice === "Accept & Restore") {
        await this.restoreDraft(draftItem, "merge");
      }

      // Clean up temp directory
      try {
        await vscode.workspace.fs.delete(tempDir, { recursive: true, useTrash: false });
      } catch {}

    } catch (error) {
      void vscode.window.showErrorMessage(
        `Failed to show before/after changes: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

