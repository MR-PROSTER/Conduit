import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import type { FilesystemEvent } from "@codesync/shared-types";

export interface DisposableLike {
  dispose(): void;
}

export interface TextRangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface TextDocumentLike {
  uri: { fsPath: string };
  getText(): string;
}

export interface TextEditorEditLike {
  replace(range: TextRangeLike, text: string): void;
}

export interface TextEditorLike {
  document: TextDocumentLike;
  edit(callback: (editBuilder: TextEditorEditLike) => void): Promise<boolean>;
  onDidChangeTextDocument?: (listener: () => void) => DisposableLike;
  onDidChange?: (listener: () => void) => DisposableLike;
}

interface FileBinding {
  text: Y.Text;
  editor: TextEditorLike;
  dispose: () => void;
  updatingFromYjs: boolean;
  updatingFromEditor: boolean;
}

export class FileManager {
  readonly doc: Y.Doc;
  readonly files: Y.Map<Y.Text>;

  private readonly bindings = new Map<string, FileBinding>();

  constructor(
    private readonly workspaceRoot: string,
    doc: Y.Doc = new Y.Doc(),
  ) {
    this.doc = doc;
    this.files = this.doc.getMap<Y.Text>("files");
  }

  bind(filePath: string, editor: TextEditorLike): void {
    this.unbind(filePath);
    const text = this.getOrCreateFileText(filePath, editor.document.getText());

    const state: FileBinding = {
      text,
      editor,
      dispose: () => undefined,
      updatingFromYjs: false,
      updatingFromEditor: false,
    };

    const syncEditor = async () => {
      if (state.updatingFromEditor) {
        return;
      }
      state.updatingFromYjs = true;
      try {
        const content = text.toString();
        const current = editor.document.getText();
        if (current !== content) {
          await editor.edit((editBuilder) => {
            editBuilder.replace(this.fullDocumentRange(editor.document), content);
          });
        }
      } finally {
        state.updatingFromYjs = false;
      }
    };

    const syncYjs = () => {
      if (state.updatingFromYjs) {
        return;
      }
      state.updatingFromEditor = true;
      try {
        const content = editor.document.getText();
        const current = text.toString();
        if (content !== current) {
          text.delete(0, text.length);
          text.insert(0, content);
        }
      } finally {
        state.updatingFromEditor = false;
      }
    };

    text.observe(syncEditor);

    const disposable =
      editor.onDidChangeTextDocument?.(syncYjs) ??
      editor.onDidChange?.(syncYjs) ??
      ({
        dispose: () => undefined,
      } as DisposableLike);

    state.dispose = () => {
      text.unobserve(syncEditor);
      disposable.dispose();
    };

    this.bindings.set(filePath, state);
    void syncEditor();
  }

  unbind(filePath: string): void {
    const binding = this.bindings.get(filePath);
    if (!binding) {
      return;
    }
    binding.dispose();
    this.bindings.delete(filePath);
  }

  applyFilesystemOp(event: FilesystemEvent): void {
    switch (event.type) {
      case "FILE_CREATE": {
        const text = this.getOrCreateFileText(event.path);
        text.delete(0, text.length);
        text.insert(0, event.content);
        return;
      }
      case "FILE_DELETE": {
        this.files.delete(event.path);
        this.unbind(event.path);
        return;
      }
      case "FILE_RENAME":
      case "FILE_MOVE": {
        const existing = this.files.get(event.oldPath);
        if (!existing) {
          return;
        }
        this.files.delete(event.oldPath);
        this.unbind(event.oldPath);
        this.files.set(event.newPath, existing);
        return;
      }
      default:
        return;
    }
  }

  async flushToDisk(): Promise<void> {
    const paths = Array.from(this.files.keys());
    await Promise.all(
      paths.map(async (filePath) => {
        const text = this.files.get(filePath);
        if (!text) {
          return;
        }
        const absolutePath = path.join(this.workspaceRoot, filePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, text.toString(), "utf8");
      }),
    );
  }

  getActiveFiles(): string[] {
    return Array.from(this.files.keys());
  }

  async loadFileFromDisk(filePath: string): Promise<Y.Text> {
    const absolutePath = path.join(this.workspaceRoot, filePath);
    const content = await readFile(absolutePath, "utf8");
    const text = this.getOrCreateFileText(filePath);
    text.delete(0, text.length);
    text.insert(0, content);
    return text;
  }

  async scanWorkspaceFiles(): Promise<string[]> {
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  }

  private getOrCreateFileText(filePath: string, initialContent = ""): Y.Text {
    const existing = this.files.get(filePath);
    if (existing) {
      return existing;
    }
    const text = new Y.Text(initialContent);
    this.files.set(filePath, text);
    return text;
  }

  private fullDocumentRange(document: TextDocumentLike): TextRangeLike {
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const lastLine = Math.max(0, lines.length - 1);
    const lastCharacter = lines[lastLine]?.length ?? 0;
    return {
      start: { line: 0, character: 0 },
      end: { line: lastLine, character: lastCharacter },
    };
  }
}
