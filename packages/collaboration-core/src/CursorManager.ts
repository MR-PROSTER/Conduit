import type { Awareness } from "y-protocols/awareness";

export interface CursorPosition {
  line: number;
  character: number;
  selectionEndLine?: number;
  selectionEndCharacter?: number;
}

export interface CursorState {
  userId: string;
  filePath: string;
  cursor: CursorPosition;
}

export interface RangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface DecorationTypeLike {
  dispose(): void;
}

export interface EditorDecorationTarget {
  setDecorations(decoration: DecorationTypeLike, ranges: readonly RangeLike[]): void;
}

export interface CursorManagerDeps {
  getEditor(filePath: string): EditorDecorationTarget | undefined;
  createDecorationType(options: { backgroundColor: string; borderColor: string }): DecorationTypeLike;
}

export class CursorManager {
  private readonly decorations = new Map<string, DecorationTypeLike>();
  private readonly peerStates = new Map<string, CursorState>();
  private readonly renderedFilePaths = new Map<string, string>();
  private readonly listener: () => void;

  constructor(
    private readonly awareness: Awareness,
    private readonly deps: CursorManagerDeps
  ) {
    this.listener = () => this.refreshFromAwareness();
    (this.awareness as any).on?.("change", this.listener);
    this.refreshFromAwareness();
  }

  setLocalState(filePath: string, cursor: CursorPosition): void {
    const localState = (this.awareness as any).getLocalState?.() ?? {};
    (this.awareness as any).setLocalState({
      ...localState,
      filePath,
      cursor
    });
  }

  disposeAll(): void {
    (this.awareness as any).off?.("change", this.listener);
    for (const decoration of this.decorations.values()) {
      decoration.dispose();
    }
    this.decorations.clear();
    this.peerStates.clear();
    this.renderedFilePaths.clear();
  }

  private refreshFromAwareness(): void {
    const states = ((this.awareness as any).getStates?.() ?? new Map()).entries?.() ??
      [];

    this.peerStates.clear();
    for (const [clientId, state] of states) {
      if (!state || (this.awareness as any).clientID === clientId) {
        continue;
      }
      if (!state.userId || !state.filePath || !state.cursor) {
        continue;
      }
      this.peerStates.set(String(clientId), {
        userId: String(state.userId),
        filePath: String(state.filePath),
        cursor: state.cursor as CursorPosition
      });
    }

    const activePeerIds = new Set<string>();
    for (const [peerId, state] of this.peerStates.entries()) {
      activePeerIds.add(peerId);
      this.renderPeer(peerId, state);
    }

    for (const [peerId, decoration] of this.decorations.entries()) {
      if (!activePeerIds.has(peerId)) {
        decoration.dispose();
        this.decorations.delete(peerId);
      }
    }
  }

  private renderPeer(peerId: string, state: CursorState): void {
    const editor = this.deps.getEditor(state.filePath);
    const previousFilePath = this.renderedFilePaths.get(peerId);
    if (!editor) {
      this.renderedFilePaths.delete(peerId);
      return;
    }

    const color = this.colorForUser(state.userId);
    let decoration = this.decorations.get(peerId);
    if (!decoration) {
      decoration = this.deps.createDecorationType({
        backgroundColor: `${color}33`,
        borderColor: color
      });
      this.decorations.set(peerId, decoration);
    }

    if (previousFilePath && previousFilePath !== state.filePath) {
      const previousEditor = this.deps.getEditor(previousFilePath);
      previousEditor?.setDecorations(decoration, []);
    }

    editor.setDecorations(decoration, [this.cursorToRange(state.cursor)]);
    this.renderedFilePaths.set(peerId, state.filePath);
  }

  private cursorToRange(cursor: CursorPosition): RangeLike {
    const endLine = cursor.selectionEndLine ?? cursor.line;
    const endCharacter = cursor.selectionEndCharacter ?? cursor.character + 1;
    return {
      start: { line: cursor.line, character: cursor.character },
      end: { line: endLine, character: endCharacter }
    };
  }

  private colorForUser(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i += 1) {
      hash = (hash << 5) - hash + userId.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 80% 55%)`;
  }
}
