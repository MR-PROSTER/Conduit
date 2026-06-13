import * as path from "node:path";

import * as vscode from "vscode";
import * as Y from "yjs";

import type { FilesystemEvent } from "@conduit/shared-types";

const IGNORED_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", ".conduit"]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".pdf",
  ".png",
  ".so",
  ".ttf",
  ".vsix",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);

export interface SessionState {
  readonly sessionKey: string;
  readonly ydoc: Y.Doc;
  readonly ownsDoc: boolean;
  readonly files: Y.Map<Y.Text>;
  readonly fileRegistry: Y.Map<string>;
  readonly bindings: Map<string, EditorBinding>;
}

interface EditorBinding {
  readonly sessionKey: string;
  readonly relativePath: string;
  readonly documentUri: string;
  readonly ytext: Y.Text;
  readonly observer: (event: Y.YTextEvent) => void;
}

interface TextDeltaOperation {
  readonly retain?: number | undefined;
  readonly insert?: unknown;
  readonly delete?: number | undefined;
  readonly attributes?: Record<string, unknown> | undefined;
}

export class FileManager implements vscode.Disposable {
  private readonly sessions = new Map<string, SessionState>();
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceFolders: readonly vscode.WorkspaceFolder[];
  private remoteOpQueue: Promise<void> = Promise.resolve();
  private isApplyingRemoteOp = false;
  private expectedRemoteChangesCount = 0;
  private isDisposed = false;

  public constructor(
    workspaceFolders: readonly vscode.WorkspaceFolder[] = FileManager.getWorkspaceFolders()
  ) {
    this.workspaceFolders = workspaceFolders;

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(
        (event: vscode.TextDocumentChangeEvent) => {
          void this.handleLocalDocumentChange(event);
        }
      )
    );
  }

  public getOrCreate(sessionKey: string, ydoc?: Y.Doc): SessionState {
    // It returns the session state for the given session key, creating the single Y.doc when needed
    const existingSession = this.sessions.get(sessionKey);
    if (existingSession) {
      return existingSession;
    }

    const sessionDoc = ydoc ?? new Y.Doc();
    const files = sessionDoc.getMap<Y.Text>("files");
    const fileRegistry = sessionDoc.getMap<string>("fileRegistry");
    const sessionState: SessionState = {
      sessionKey,
      ydoc: sessionDoc,
      ownsDoc: ydoc === undefined,
      files,
      fileRegistry,
      bindings: new Map<string, EditorBinding>()
    };

    this.sessions.set(sessionKey, sessionState);
    return sessionState;
  }

  /**
   * Returns true when the collaborative session currently has no tracked files.
   */
  public isEmpty(sessionKey: string): boolean {
    return this.requireSession(sessionKey).files.size === 0;
  }

  public async bindEditor(
    // It binds a text editor to the collaborative state for the given session key, creating a new Y.Doc if necessary. It also seeds the Y.Doc with the local document content if it's not already present, or replaces the local document content with the Y.Doc state if it already exists.
    sessionKey: string,
    editor: vscode.TextEditor
  ): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const session = this.getOrCreate(sessionKey);
    const document = editor.document;
    if (!this.isWorkspaceTextDocument(document)) {
      return;
    }

    const relativePath = this.getRelativePath(document.uri);

    if (
      this.shouldIgnore(relativePath) ||
      (await this.isBinaryFile(document.uri))
    ) {
      return;
    }

    const documentUri = document.uri.toString();
    this.unbind(document.uri);

    let ytext = session.files.get(relativePath);
    if (!ytext) {
      ytext = new Y.Text();
      session.files.set(relativePath, ytext);
    }

    const documentText = document.getText();
    const collaborativeText = ytext.toString();

    if (collaborativeText.length === 0 && documentText.length > 0) {
      session.ydoc.transact(() => {
        ytext!.insert(0, documentText);
      }, this);
    } else if (collaborativeText !== documentText) {
      await this.replaceWholeDocument(document.uri, collaborativeText);
    }

    const observer = (event: Y.YTextEvent): void => {
      console.log("[conduit-collaboration] observer triggered", {
        origin: event.transaction.origin,
        isOriginThis: event.transaction.origin === this,
        delta: event.delta
      });
      // Skip changes that originated from this FileManager (local edits).
      // Without this guard, local keystrokes are echoed back into the editor,
      // causing double characters (e.g. typing "a" produces "aa").
      if (event.transaction.origin === this) {
        console.log("[conduit-collaboration] observer ignored local transaction");
        return;
      }
      this.remoteOpQueue = this.remoteOpQueue
        .then(async () => {
          console.log("[conduit-collaboration] applying remote delta to", document.uri.toString());
          await this.applyRemoteDelta(document.uri, event.delta);
        })
        .catch((error: unknown) => {
          console.error(
            "[conduit-collaboration] failed to apply remote delta",
            error
          );
        });
    };

    ytext.observe(observer);

    session.bindings.set(documentUri, {
      sessionKey,
      relativePath,
      documentUri,
      ytext,
      observer
    });
  }

  public unbind(documentUri: vscode.Uri): void {
    // It unbinds a single document
    const documentKey = documentUri.toString();

    for (const session of this.sessions.values()) {
      const binding = session.bindings.get(documentKey);
      if (!binding) {
        continue;
      }

      binding.ytext.unobserve(binding.observer);
      session.bindings.delete(documentKey);
    }
  }

  public unbindAll(sessionKey?: string): void {
    // It removes al lthe bindings for a session
    const sessions = sessionKey
      ? this.sessions.has(sessionKey)
        ? [this.requireSession(sessionKey)]
        : []
      : Array.from(this.sessions.values());

    for (const session of sessions) {
      for (const binding of session.bindings.values()) {
        binding.ytext.unobserve(binding.observer);
      }

      session.bindings.clear();
    }
  }

  public async syncSessionFilesToDisk(sessionKey: string): Promise<void> {
    // It writes every collaborative text file in the session to disk using normalized workspace-relative paths
    if (this.isDisposed || !this.sessions.has(sessionKey)) {
      return;
    }

    const session = this.requireSession(sessionKey);

    for (const relativePath of session.files.keys()) {
      await this.flushToDisk(sessionKey, relativePath);
    }

    const workspaceFiles = await this.collectWorkspaceFiles();
    for (const workspaceFile of workspaceFiles) {
      if (session.files.has(workspaceFile.relativePath)) {
        continue;
      }

      await this.applyingRemoteOp(async () => {
        await this.deleteIfExists(workspaceFile.fileUri);
      });
      this.unbind(workspaceFile.fileUri);
    }

    await this.cleanupEmptyDirectories();
    this.syncFileRegistry(session);
  }

  public async flushToDisk(
    // It flushes a single collaborative file from Y.Text to the workspace filesystem.
    sessionKey: string,
    relativePath: string
  ): Promise<void> {
    if (this.isDisposed || !this.sessions.has(sessionKey)) {
      return;
    }

    if (this.shouldIgnore(relativePath)) {
      return;
    }

    const session = this.requireSession(sessionKey);
    const ytext = session.files.get(relativePath);
    if (!ytext) {
      return;
    }

    const fileUri = this.resolveRelativePath(relativePath);
    await this.applyingRemoteOp(async () => {
      await this.ensureParentDirectory(fileUri);
      await vscode.workspace.fs.writeFile(
        fileUri,
        this.textEncoder.encode(ytext.toString())
      );
    });
  }

  public async initFromWorkspace(sessionKey: string): Promise<void> {
    // we populate the Y.doc with all the workspace files, skipping ignored and binary files
    if (this.isDisposed) {
      return;
    }

    const session = this.getOrCreate(sessionKey);
    const files = await this.collectWorkspaceFiles();

    for (const file of files) {
      if (await this.isBinaryFile(file.fileUri)) {
        continue;
      }

      const content = this.textDecoder.decode(
        await vscode.workspace.fs.readFile(file.fileUri)
      );
      let ytext = session.files.get(file.relativePath);
      if (!ytext) {
        ytext = new Y.Text();
        session.files.set(file.relativePath, ytext);
      }

      this.setYTextContent(session.ydoc, ytext, content);
    }

    this.syncFileRegistry(session);
  }

  public async onFileCreated(
    // It updates the collaborative map when a local file is created
    sessionKey: string,
    fileUri: vscode.Uri
  ): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const relativePath = this.getRelativePath(fileUri);
    if (this.shouldIgnore(relativePath) || (await this.isBinaryFile(fileUri))) {
      return;
    }

    const session = this.getOrCreate(sessionKey);
    const content = this.textDecoder.decode(
      await vscode.workspace.fs.readFile(fileUri)
    );

    let ytext = session.files.get(relativePath);
    if (!ytext) {
      ytext = new Y.Text();
      session.files.set(relativePath, ytext);
    }

    this.setYTextContent(session.ydoc, ytext, content);
    this.syncFileRegistry(session);
  }

  public async createFileCreateEvent(
    fileUri: vscode.Uri
  ): Promise<FilesystemEvent | undefined> {
    const relativePath = this.getRelativePath(fileUri);
    if (this.shouldIgnore(relativePath) || (await this.isBinaryFile(fileUri))) {
      return undefined;
    }

    const content = this.textDecoder.decode(
      await vscode.workspace.fs.readFile(fileUri)
    );
    return {
      type: "FILE_CREATE",
      path: relativePath,
      content
    };
  }

  public getWorkspaceRelativePath(fileUri: vscode.Uri): string {
    return this.getRelativePath(fileUri);
  }

  public createFileDeleteEvent(
    fileUri: vscode.Uri
  ): FilesystemEvent | undefined {
    const relativePath = this.getRelativePath(fileUri);
    if (this.shouldIgnore(relativePath)) {
      return undefined;
    }

    return {
      type: "FILE_DELETE",
      path: relativePath
    };
  }

  public createFileRenameEvent(
    oldUri: vscode.Uri,
    newUri: vscode.Uri
  ): FilesystemEvent | undefined {
    const oldRelativePath = this.getRelativePath(oldUri);
    const newRelativePath = this.getRelativePath(newUri);

    if (
      this.shouldIgnore(oldRelativePath) ||
      this.shouldIgnore(newRelativePath)
    ) {
      return undefined;
    }

    const oldDirectory = path.posix.dirname(oldRelativePath);
    const newDirectory = path.posix.dirname(newRelativePath);

    return oldDirectory === newDirectory
      ? {
          type: "FILE_RENAME",
          oldPath: oldRelativePath,
          newPath: newRelativePath
        }
      : {
          type: "FILE_MOVE",
          oldPath: oldRelativePath,
          newPath: newRelativePath
        };
  }

  public onFileDeleted(sessionKey: string, fileUri: vscode.Uri): void {
    // It updates the collaborative map when a local file is deleted
    const relativePath = this.getRelativePath(fileUri);
    if (this.shouldIgnore(relativePath)) {
      return;
    }

    const session = this.requireSession(sessionKey);
    session.ydoc.transact(() => {
      session.files.delete(relativePath);
    }, this);

    this.syncFileRegistry(session);
    this.unbind(fileUri);
  }

  public onFileRenamed(
    // It updates the collaborative map when a local file is renamed
    sessionKey: string,
    oldUri: vscode.Uri,
    newUri: vscode.Uri
  ): void {
    const oldRelativePath = this.getRelativePath(oldUri);
    const newRelativePath = this.getRelativePath(newUri);

    if (
      this.shouldIgnore(oldRelativePath) ||
      this.shouldIgnore(newRelativePath)
    ) {
      return;
    }

    const session = this.requireSession(sessionKey);
    const existing = session.files.get(oldRelativePath);
    if (!existing) {
      return;
    }

    session.ydoc.transact(() => {
      session.files.set(newRelativePath, existing);
      session.files.delete(oldRelativePath);
    }, this);

    this.syncFileRegistry(session);
    this.unbind(oldUri);
  }

  public async onRemoteFilesystemEvent(
    // It applies filesystem operations originating from remote collaborators to both disk and Yjs state.
    sessionKey: string,
    event: FilesystemEvent
  ): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const session = this.getOrCreate(sessionKey);

    switch (event.type) {
      case "FILE_CREATE": {
        if (this.shouldIgnore(event.path)) {
          return;
        }

        const fileUri = this.resolveRelativePath(event.path);
        await this.applyingRemoteOp(async () => {
          await this.ensureParentDirectory(fileUri);
          await vscode.workspace.fs.writeFile(
            fileUri,
            this.textEncoder.encode(event.content)
          );
        });

        let ytext = session.files.get(event.path);
        if (!ytext) {
          ytext = new Y.Text();
          session.files.set(event.path, ytext);
        }

        this.setYTextContent(session.ydoc, ytext, event.content);
        this.syncFileRegistry(session);
        return;
      }

      case "FILE_DELETE": {
        if (this.shouldIgnore(event.path)) {
          return;
        }

        const fileUri = this.resolveRelativePath(event.path);
        await this.applyingRemoteOp(async () => {
          await this.deleteIfExists(fileUri);
        });

        session.ydoc.transact(() => {
          session.files.delete(event.path);
        }, this);
        this.syncFileRegistry(session);
        this.unbind(fileUri);
        return;
      }

      case "FILE_RENAME":
      case "FILE_MOVE": {
        if (
          this.shouldIgnore(event.oldPath) ||
          this.shouldIgnore(event.newPath)
        ) {
          return;
        }

        const oldUri = this.resolveRelativePath(event.oldPath);
        const newUri = this.resolveRelativePath(event.newPath);
        const existing = session.files.get(event.oldPath);

        await this.applyingRemoteOp(async () => {
          await this.ensureParentDirectory(newUri);
          await this.renameIfExists(oldUri, newUri);
        });

        if (existing) {
          session.ydoc.transact(() => {
            session.files.set(event.newPath, existing);
            session.files.delete(event.oldPath);
          }, this);
        }

        this.syncFileRegistry(session);
        this.unbind(oldUri);
      }
    }
  }

  public shouldIgnore(relativePath: string): boolean {
    // It checks if the given relative path should be ignored
    const normalizedPath = this.normalizeRelativePath(relativePath);
    if (
      normalizedPath.length === 0 ||
      normalizedPath.startsWith("../") ||
      normalizedPath === ".."
    ) {
      return true;
    }

    const segments = normalizedPath
      .split("/")
      .filter((segment) => segment.length > 0);
    return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
  }

  public async isBinaryFile(fileUri: vscode.Uri): Promise<boolean> {
    // It checks if the given file URI is a binary file or not
    const extension = path.extname(fileUri.fsPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) {
      return true;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const sampleLength = Math.min(bytes.length, 8_000);
      for (let index = 0; index < sampleLength; index += 1) {
        if (bytes[index] === 0) {
          return true;
        }
      }
    } catch {
      return false;
    }

    return false;
  }

  public dispose(): void {
    // It unbinds all editors, destroys all Y.doc instances
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.unbindAll();
    for (const session of this.sessions.values()) {
      if (session.ownsDoc) {
        session.ydoc.destroy();
      }
    }

    this.sessions.clear();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async handleLocalDocumentChange(
    // It converts local editor mutations into exact Y.text deletes/inserts
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    if (this.isApplyingRemoteOp) {
      if (this.expectedRemoteChangesCount > 0) {
        this.expectedRemoteChangesCount--;
      }
      return;
    }

    if (this.expectedRemoteChangesCount > 0) {
      this.expectedRemoteChangesCount--;
      console.log("[conduit-collaboration] handleLocalDocumentChange ignored expected remote change. Remaining expected:", this.expectedRemoteChangesCount);
      return;
    }

    const documentKey = event.document.uri.toString();
    const binding = this.findBinding(documentKey);
    if (!binding) {
      return;
    }

    if (!this.sessions.has(binding.sessionKey)) {
      return;
    }

    const session = this.requireSession(binding.sessionKey);
    const orderedChanges = [...event.contentChanges].sort(
      (left, right) => right.rangeOffset - left.rangeOffset
    );

    session.ydoc.transact(() => {
      for (const change of orderedChanges) {
        if (change.rangeLength > 0) {
          binding.ytext.delete(change.rangeOffset, change.rangeLength);
        }

        if (change.text.length > 0) {
          binding.ytext.insert(change.rangeOffset, change.text);
        }
      }
    }, this);
  }

  private async applyRemoteDelta(
    documentUri: vscode.Uri,
    delta: ReadonlyArray<TextDeltaOperation>
  ): Promise<void> {
    if (this.isDisposed || !this.findBinding(documentUri.toString())) {
      return;
    }

    // we first find the corresponding editor binding for the given document URI, then we translate the Y.Text delta into a series of WorkspaceEdits which are applied in a single batch to minimize flickering and ensure the document content always matches the Yjs state
    const document = await vscode.workspace.openTextDocument(documentUri);
    const workspaceEdit = new vscode.WorkspaceEdit();
    const pendingEdits: Array<{
      readonly startOffset: number;
      readonly endOffset: number;
      readonly text: string;
    }> = [];

    let offset = 0;
    for (const operation of delta) {
      if ("retain" in operation && typeof operation.retain === "number") {
        offset += operation.retain;
      }

      if ("insert" in operation) {
        const insertedText =
          typeof operation.insert === "string" ? operation.insert : "";

        pendingEdits.push({
          startOffset: offset,
          endOffset: offset,
          text: insertedText
        });
      }

      if ("delete" in operation && typeof operation.delete === "number") {
        pendingEdits.push({
          startOffset: offset,
          endOffset: offset + operation.delete,
          text: ""
        });
        offset += operation.delete;
      }
    }

    if (pendingEdits.length === 0) {
      return;
    }

    pendingEdits.sort((left, right) => right.startOffset - left.startOffset);

    for (const edit of pendingEdits) {
      const range = new vscode.Range(
        document.positionAt(edit.startOffset),
        document.positionAt(edit.endOffset)
      );
      workspaceEdit.replace(documentUri, range, edit.text);
    }

    console.log("[conduit-collaboration] applyRemoteDelta pendingEdits:", pendingEdits);

    this.expectedRemoteChangesCount++;
    await this.applyingRemoteOp(async () => {
      if (this.isDisposed || !this.findBinding(documentUri.toString())) {
        console.log("[conduit-collaboration] applyRemoteDelta aborted: disposed or binding missing");
        this.expectedRemoteChangesCount--;
        return;
      }

      try {
        const success = await vscode.workspace.applyEdit(workspaceEdit);
        console.log("[conduit-collaboration] applyRemoteDelta applyEdit result:", success);
        if (!success) {
          this.expectedRemoteChangesCount--;
        }
      } catch (error) {
        this.expectedRemoteChangesCount--;
        throw error;
      }
    });
  }

  private setYTextContent(ydoc: Y.Doc, ytext: Y.Text, content: string): void {
    // This method replaces the entire content of a Y.text with the given content
    if (ytext.toString() === content) {
      return;
    }

    ydoc.transact(() => {
      const existingLength = ytext.length;
      // We delete any content in Y.text before inserting the new content
      if (existingLength > 0) {
        ytext.delete(0, existingLength);
      }
      // We insert the new content into Y.text only if it's not empty
      if (content.length > 0) {
        ytext.insert(0, content);
      }
    }, this);
  }

  private async replaceWholeDocument(
    // This method replaces the entire content of a document with the given content
    documentUri: vscode.Uri,
    content: string
  ): Promise<void> {
    // We first open the document to get its full range, then replace the entire content with a single edit.
    const document = await vscode.workspace.openTextDocument(documentUri);
    const lastLine = document.lineAt(document.lineCount - 1);
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      lastLine.range.end
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(documentUri, fullRange, content);

    this.expectedRemoteChangesCount++;
    await this.applyingRemoteOp(async () => {
      try {
        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          this.expectedRemoteChangesCount--;
        }
      } catch (error) {
        this.expectedRemoteChangesCount--;
        throw error;
      }
    });
  }

  private getRelativePath(fileUri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!workspaceFolder) {
      throw new Error(
        `File is outside the current workspace: ${fileUri.fsPath}`
      );
    }

    const relativePath = this.normalizeRelativePath(
      path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath)
    );
    if (this.workspaceFolders.length === 1) {
      return relativePath;
    }

    return this.normalizeRelativePath(
      relativePath.length > 0
        ? `${workspaceFolder.name}/${relativePath}`
        : workspaceFolder.name
    );
  }

  private isWorkspaceTextDocument(document: vscode.TextDocument): boolean {
    return (
      document.uri.scheme === "file" &&
      vscode.workspace.getWorkspaceFolder(document.uri) !== undefined
    );
  }

  private findBinding(documentKey: string): EditorBinding | undefined {
    for (const session of this.sessions.values()) {
      const binding = session.bindings.get(documentKey);
      if (binding) {
        return binding;
      }
    }

    return undefined;
  }

  private requireSession(sessionKey: string): SessionState {
    // It returns the session state for the given session key
    const session = this.sessions.get(sessionKey);
    if (!session) {
      throw new Error(`Unknown collaboration session: ${sessionKey}`);
    }

    return session;
  }

  private async applyingRemoteOp<T>(operation: () => Promise<T>): Promise<T> {
    // It sets a flag which prevents local document changes while we are applying remote Yjs deltas
    this.isApplyingRemoteOp = true;

    try {
      return await operation();
    } finally {
      this.isApplyingRemoteOp = false;
    }
  }

  private resolveRelativePath(relativePath: string): vscode.Uri {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    if (this.shouldIgnore(normalizedPath)) {
      throw new Error(`Cannot resolve ignored path: ${relativePath}`);
    }

    if (this.workspaceFolders.length === 1) {
      return vscode.Uri.joinPath(this.workspaceFolders[0]!.uri, normalizedPath);
    }

    const [folderName, ...rest] = normalizedPath.split("/");
    const workspaceFolder = this.workspaceFolders.find(
      (folder) => folder.name === folderName
    );
    if (!workspaceFolder) {
      throw new Error(`Unknown workspace folder for path: ${relativePath}`);
    }

    return rest.length > 0
      ? vscode.Uri.joinPath(workspaceFolder.uri, ...rest)
      : workspaceFolder.uri;
  }

  private normalizeRelativePath(relativePath: string): string {
    const normalizedPath = path.posix.normalize(
      relativePath.split(path.sep).join("/")
    );
    if (normalizedPath === ".") {
      return "";
    }

    return normalizedPath.replace(/^\/+/, "");
  }

  private async collectWorkspaceFiles(): Promise<readonly WorkspaceFile[]> {
    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,.git,dist,build}/**"
    );

    const workspaceFiles: WorkspaceFile[] = [];
    for (const fileUri of files) {
      const relativePath = this.getRelativePath(fileUri);
      if (this.shouldIgnore(relativePath)) {
        continue;
      }

      workspaceFiles.push({
        fileUri,
        relativePath
      });
    }

    return workspaceFiles;
  }

  private syncFileRegistry(session: SessionState): void {
    const nextEntries = new Map<string, string>();

    for (const relativePath of session.files.keys()) {
      const normalizedPath = this.normalizeRelativePath(relativePath);
      if (normalizedPath.length === 0) {
        continue;
      }

      nextEntries.set(normalizedPath, "file");

      const segments = normalizedPath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const directoryPath = segments.slice(0, index).join("/");
        if (!nextEntries.has(directoryPath)) {
          nextEntries.set(directoryPath, "directory");
        }
      }
    }

    session.ydoc.transact(() => {
      for (const existingPath of Array.from(
        session.fileRegistry.keys()
      ) as string[]) {
        if (!nextEntries.has(existingPath)) {
          session.fileRegistry.delete(existingPath);
        }
      }

      for (const [entryPath, entryType] of nextEntries) {
        session.fileRegistry.set(entryPath, entryType);
      }
    }, this);
  }

  private async ensureParentDirectory(fileUri: vscode.Uri): Promise<void> {
    // This method ensures that the parent directory of the given file URI exists, creating it if necessary
    const parentUri = fileUri.with({
      path: path.posix.dirname(fileUri.path)
    });
    await vscode.workspace.fs.createDirectory(parentUri);
  }

  private async deleteIfExists(fileUri: vscode.Uri): Promise<void> {
    // This method deletes the file at the given URI if it exists
    try {
      await vscode.workspace.fs.delete(fileUri, {
        recursive: false,
        useTrash: false
      });
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return;
      }

      throw error;
    }
  }

  private async renameIfExists(
    // This method renames the file from oldUri to newUri if it exists
    oldUri: vscode.Uri,
    newUri: vscode.Uri
  ): Promise<void> {
    try {
      await vscode.workspace.fs.rename(oldUri, newUri, {
        overwrite: true
      });
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return;
      }

      throw error;
    }
  }

  private isFileNotFoundError(error: unknown): boolean {
    // It Checks if the error is a FileNotFound error or not
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name.toLowerCase().includes("filenotfound");
  }

  private async cleanupEmptyDirectories(): Promise<void> {
    for (const workspaceFolder of this.workspaceFolders) {
      await this.deleteEmptyDirectoriesRecursively(workspaceFolder.uri, true);
    }
  }

  private async deleteEmptyDirectoriesRecursively(
    directoryUri: vscode.Uri,
    isWorkspaceRoot = false
  ): Promise<boolean> {
    let entries: readonly [string, vscode.FileType][];

    try {
      entries = await vscode.workspace.fs.readDirectory(directoryUri);
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return true;
      }

      throw error;
    }

    let hasVisibleEntries = false;

    for (const [name, fileType] of entries) {
      const childUri = vscode.Uri.joinPath(directoryUri, name);
      const relativePath = this.getRelativePath(childUri);
      if (this.shouldIgnore(relativePath)) {
        hasVisibleEntries = true;
        continue;
      }

      if (fileType === vscode.FileType.Directory) {
        const deleted = await this.deleteEmptyDirectoriesRecursively(childUri);
        if (!deleted) {
          hasVisibleEntries = true;
        }
        continue;
      }

      hasVisibleEntries = true;
    }

    if (hasVisibleEntries || isWorkspaceRoot) {
      return false;
    }

    await vscode.workspace.fs.delete(directoryUri, {
      recursive: false,
      useTrash: false
    });
    return true;
  }

  private static getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error("FileManager requires an open VS Code workspace folder.");
    }

    return folders;
  }
}

interface WorkspaceFile {
  readonly fileUri: vscode.Uri;
  readonly relativePath: string;
}
