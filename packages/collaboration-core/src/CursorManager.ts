import * as path from "node:path";

import * as vscode from "vscode";
import { Awareness } from "y-protocols/awareness";

const CURSOR_PALETTE = [
  "#E85D75",
  "#2D8CFF",
  "#17A673",
  "#F59E0B",
  "#8B5CF6",
  "#D946EF",
  "#0EA5A4",
  "#EF4444"
] as const;

interface CursorPosition {
  readonly line: number;
  readonly character: number;
}

export interface RemoteCursorState {
  readonly userId: string;
  readonly label: string;
  readonly color: string;
  readonly path: string;
  readonly anchor: CursorPosition;
  readonly active: CursorPosition;
}

interface ManagedCursorDecoration {
  readonly clientId: number;
  readonly state: RemoteCursorState;
  readonly cursorDecoration: vscode.TextEditorDecorationType;
  readonly selectionDecoration: vscode.TextEditorDecorationType;
}

export class CursorManager implements vscode.Disposable {
    // It manages Awareness-backed remote cursor rendering for a single collaborative session.
  private readonly decorations = new Map<number, ManagedCursorDecoration>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeEditor?: vscode.TextEditor;

  public constructor(
    private readonly awareness: Awareness,
    private readonly workspaceRoot: vscode.Uri = CursorManager.getWorkspaceRoot()
  ) {
    const handleAwarenessChange = ({
      added,
      updated,
      removed
    }: {
      readonly added: readonly number[];
      readonly updated: readonly number[];
      readonly removed: readonly number[];
    }): void => {
        // Whenever Awareness states change, we re-render the remote cursors for the active editor. We remove any clients that are no longer present, and add or update decorations for new or changed clients.
      if (this.activeEditor) {
        for (const clientId of [...added, ...updated]) {
          const state = this.getRemoteCursorState(clientId);
          if (state) {
            this.updateRemoteCursor(clientId, state, this.activeEditor);
          }
        }

        for (const clientId of removed) {
          this.removeRemoteCursor(clientId);
        }

        this.renderRemoteCursors(this.activeEditor);
      } else {
        for (const clientId of removed) {
          this.removeRemoteCursor(clientId);
        }
      }
    };

    this.awareness.on("change", handleAwarenessChange);
    this.disposables.push(
      new vscode.Disposable(() => {
        this.awareness.off("change", handleAwarenessChange);
      })
    );
  }

  public broadcastCursor(
    editor: vscode.TextEditor,
    userId: string,
    label: string
  ): void {
    // It broadcasts the local selection into awareness for other collaborators
    this.activeEditor = editor;

    const relativePath = this.getRelativePath(editor.document.uri);
    const color = this.assignColor(userId);
    const selection = editor.selection;
    const state: RemoteCursorState = {
      userId,
      label,
      color,
      path: relativePath,
      anchor: {
        line: selection.anchor.line,
        character: selection.anchor.character
      },
      active: {
        line: selection.active.line,
        character: selection.active.character
      }
    };

    this.awareness.setLocalStateField("cursor", state);
  }

  public renderRemoteCursors(editor: vscode.TextEditor): void {
    // It re-renders every remote cursor that belongs to the provided editor document
    this.activeEditor = editor;
    const currentPath = this.getRelativePath(editor.document.uri);
    const activeClientIds = new Set<number>();

    for (const [clientId] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) {
        continue;
      }

      const state = this.getRemoteCursorState(clientId);
      if (!state || state.path !== currentPath) {
        this.removeRemoteCursor(clientId);
        continue;
      }

      activeClientIds.add(clientId);
      this.updateRemoteCursor(clientId, state, editor);
    }

    for (const clientId of this.decorations.keys()) {
      if (!activeClientIds.has(clientId)) {
        this.removeRemoteCursor(clientId);
      }
    }
  }

  public updateRemoteCursor(
    clientId: number,
    state: RemoteCursorState,
    editor?: vscode.TextEditor
  ): void {
    // It creates or updates decorations for a specific remote collaborator
    const targetEditor = editor ?? this.activeEditor;
    if (!targetEditor) {
      return;
    }

    const currentPath = this.getRelativePath(targetEditor.document.uri);
    if (state.path !== currentPath) {
      this.removeRemoteCursor(clientId);
      return;
    }

    const existingDecoration = this.decorations.get(clientId);
    if (
      existingDecoration &&
      (existingDecoration.state.color !== state.color ||
        existingDecoration.state.label !== state.label)
    ) {
      this.removeRemoteCursor(clientId);
    }

    const managedDecoration =
      this.decorations.get(clientId) ??
      this.createManagedDecoration(clientId, state);

    const anchorPosition = this.clampPosition(targetEditor.document, state.anchor);
    const activePosition = this.clampPosition(targetEditor.document, state.active);
    const cursorRange = new vscode.Range(activePosition, activePosition);
    const selectionRange = this.createSelectionRange(anchorPosition, activePosition);

    targetEditor.setDecorations(managedDecoration.cursorDecoration, [
      {
        range: cursorRange,
        hoverMessage: new vscode.MarkdownString(`Conduit collaborator: ${state.label}`)
      }
    ]);

    if (selectionRange) {
      targetEditor.setDecorations(managedDecoration.selectionDecoration, [
        {
          range: selectionRange,
          hoverMessage: new vscode.MarkdownString(`Selection by ${state.label}`)
        }
      ]);
    } else {
      targetEditor.setDecorations(managedDecoration.selectionDecoration, []);
    }
  }

  public removeRemoteCursor(clientId: number): void {
    // It removes a remote collaborator cursor and disposes the associated decoration types
    const managedDecoration = this.decorations.get(clientId);
    if (!managedDecoration) {
      return;
    }

    if (this.activeEditor) {
      this.activeEditor.setDecorations(managedDecoration.cursorDecoration, []);
      this.activeEditor.setDecorations(managedDecoration.selectionDecoration, []);
    }

    managedDecoration.cursorDecoration.dispose();
    managedDecoration.selectionDecoration.dispose();
    this.decorations.delete(clientId);
  }

  public disposeAll(): void {
    // It disposes every tracked cursor decoration and clears local awareness cursor state
    for (const clientId of [...this.decorations.keys()]) {
      this.removeRemoteCursor(clientId);
    }

    this.awareness.setLocalStateField("cursor", null);
  }

  public assignColor(userId: string): string | any {
    // It assigns a deterministic color for a user identifier
    let hash = 0;
    for (let index = 0; index < userId.length; index += 1) {
      hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
    }

    return CURSOR_PALETTE[hash % CURSOR_PALETTE.length];
  }

  public dispose(): void {
    // It disposes every tracked cursor decoration and clears local awareness cursor state
    this.disposeAll();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private getRemoteCursorState(clientId: number): RemoteCursorState | undefined {
    // It returns a remote cursor state for a given Awareness client ID, or undefined if the state is malformed or missing required fields
    const awarenessState = this.awareness.getStates().get(clientId);
    const cursorState = awarenessState?.["cursor"];
    if (!cursorState || typeof cursorState !== "object") {
      return undefined;
    }

    const candidate = cursorState as Partial<RemoteCursorState>;
    if (
      typeof candidate.userId !== "string" ||
      typeof candidate.label !== "string" ||
      typeof candidate.color !== "string" ||
      typeof candidate.path !== "string" ||
      !this.isCursorPosition(candidate.anchor) ||
      !this.isCursorPosition(candidate.active)
    ) {
      return undefined;
    }

    return {
      userId: candidate.userId,
      label: candidate.label,
      color: candidate.color,
      path: candidate.path,
      anchor: candidate.anchor,
      active: candidate.active
    };
  }

  private createManagedDecoration(
    clientId: number,
    state: RemoteCursorState
  ): ManagedCursorDecoration {
    // It creates a new managed decoration for a remote collaborator based on their awareness state
    const cursorDecoration = vscode.window.createTextEditorDecorationType({
      borderColor: state.color,
      borderStyle: "solid",
      borderWidth: "0 0 0 2px",
      after: {
        contentText: state.label,
        color: "#FFFFFF",
        backgroundColor: state.color,
        textDecoration: "none; position: absolute; top: -18px; font-size: 12px; padding: 0 4px; border-radius: 2px; font-weight: bold; pointer-events: none; white-space: nowrap; z-index: 100; line-height: 14px; height: 14px;"
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });

    const selectionDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: `${state.color}33`,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });

    const managedDecoration: ManagedCursorDecoration = {
      clientId,
      state,
      cursorDecoration,
      selectionDecoration
    };

    this.decorations.set(clientId, managedDecoration);
    return managedDecoration;
  }

  private createSelectionRange(
    // It creates a vscode.Range for the selection between the anchor and active positions, or returns undefined if the positions are the same (i.e. no selection)
    anchor: vscode.Position,
    active: vscode.Position
  ): vscode.Range | undefined {
    if (anchor.isEqual(active)) {
      return undefined;
    }

    return anchor.isBeforeOrEqual(active)
      ? new vscode.Range(anchor, active)
      : new vscode.Range(active, anchor);
  }

  private clampPosition(
      document: vscode.TextDocument,
      position: CursorPosition
    ): vscode.Position {
      // It clamps a cursor position to ensure it stays within the bounds of the document
    const line = Math.max(0, Math.min(position.line, document.lineCount - 1));
    const lineRange = document.lineAt(line).range;
    const character = Math.max(0, Math.min(position.character, lineRange.end.character));
    return new vscode.Position(line, character);
  }

  private getRelativePath(fileUri: vscode.Uri): string {
    return path.relative(this.workspaceRoot.fsPath, fileUri.fsPath).split(path.sep).join("/");
  }

  private isCursorPosition(value: unknown): value is CursorPosition {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Partial<CursorPosition>;
    return (
      typeof candidate.line === "number" &&
      Number.isInteger(candidate.line) &&
      candidate.line >= 0 &&
      typeof candidate.character === "number" &&
      Number.isInteger(candidate.character) &&
      candidate.character >= 0
    );
  }

  private static getWorkspaceRoot(): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      throw new Error("CursorManager requires an open VS Code workspace folder.");
    }

    return root;
  }
}
