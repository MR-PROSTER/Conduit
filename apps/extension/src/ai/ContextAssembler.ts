import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextRef, Session } from "@codesync/shared-types";
import type { ILLMProvider } from "@codesync/ai-core";
import type { CollaboratorPresence } from "../broadcast.js";

export interface AssembledContext {
  contextText: string;
  contextRefs: ContextRef[];
}

export class ContextAssembler {
  private tokenProvider: ILLMProvider | undefined;

  constructor(tokenProvider?: ILLMProvider) {
    this.tokenProvider = tokenProvider;
  }

  setTokenProvider(provider: ILLMProvider | undefined): void {
    this.tokenProvider = provider;
  }

  async countTokens(text: string): Promise<number> {
    if (this.tokenProvider) {
      try {
        return await this.tokenProvider.countTokens(text);
      } catch {
        // fall through to rough estimate
      }
    }

    return Math.max(1, Math.ceil(text.length / 4));
  }

  async assembleContext(
    session?: Session,
    openFiles: readonly string[] = [],
    activeEditor?: vscode.TextEditor,
    peers: readonly CollaboratorPresence[] = []
  ): Promise<AssembledContext> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const contextRefs: ContextRef[] = [];
    const chunks: string[] = [];
    const seen = new Set<string>();
    const budget = 12_000;
    let remaining = budget;

    const activeFile = activeEditor
      ? vscode.workspace.asRelativePath(activeEditor.document.uri, false)
      : undefined;

    if (session) {
      chunks.push(
        [
          `Session ID: ${session.id}`,
          `Room ID: ${session.roomId}`,
          `Branch: ${session.branch}`,
          `Base commit: ${session.baseCommitHash}`,
          `Status: ${session.status}`,
        ].join("\n")
      );
    }

    const paths = this.uniquePaths([activeFile, ...openFiles]);
    for (const filePath of paths) {
      const content = await this.readFileContent(filePath, activeEditor);
      if (!content) {
        continue;
      }

      const tokenCount = await this.countTokens(content);
      if (chunks.length > 0 && tokenCount > remaining) {
        break;
      }

      chunks.push(`File: ${filePath}\n${content}`);
      contextRefs.push({
        filePath,
        startLine: 1,
        endLine: this.countLines(content),
        nodeType: "file",
      });
      seen.add(filePath);
      remaining -= tokenCount;
    }

    const peerBlock = this.formatPeers(peers);
    if (peerBlock) {
      chunks.push(`Peer presence:\n${peerBlock}`);
    }

    if (workspaceRoot) {
      chunks.unshift(`Workspace root: ${workspaceRoot}`);
    }

    return {
      contextText: chunks.join("\n\n"),
      contextRefs,
    };
  }

  private uniquePaths(paths: readonly (string | undefined)[]): string[] {
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const candidate of paths) {
      if (!candidate) {
        continue;
      }

      const normalized = candidate.replace(/\\/g, "/");
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      unique.push(normalized);
    }

    return unique;
  }

  private async readFileContent(
    filePath: string,
    activeEditor?: vscode.TextEditor
  ): Promise<string | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return undefined;
    }

    const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);

    try {
      if (activeEditor && vscode.workspace.asRelativePath(activeEditor.document.uri, false).replace(/\\/g, "/") === filePath) {
        return this.formatDocumentExcerpt(activeEditor);
      }

      const raw = await fs.readFile(absPath, "utf8");
      return this.truncateContent(raw);
    } catch {
      return undefined;
    }
  }

  private formatDocumentExcerpt(editor: vscode.TextEditor): string {
    const doc = editor.document;
    const selection = editor.selection;
    const cursorLine = selection.active.line;
    const startLine = Math.max(0, cursorLine - 60);
    const endLine = Math.min(doc.lineCount - 1, cursorLine + 60);
    const lines: string[] = [];

    for (let line = startLine; line <= endLine; line += 1) {
      lines.push(`${String(line + 1).padStart(4, " ")} | ${doc.lineAt(line).text}`);
    }

    const selected = selection.isEmpty ? "" : `\nSelected text:\n${doc.getText(selection)}`;
    return [
      `Cursor line: ${cursorLine + 1}`,
      selected,
      lines.join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
  }

  private truncateContent(content: string): string {
    const lines = content.split(/\r?\n/);
    if (lines.length <= 200) {
      return lines
        .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
        .join("\n");
    }

    return [
      ...lines.slice(0, 120).map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`),
      "     | ... truncated ...",
      ...lines.slice(-40).map((line, index) => `${String(lines.length - 39 + index).padStart(4, " ")} | ${line}`),
    ].join("\n");
  }

  private countLines(content: string): number {
    return content.split(/\r?\n/).length;
  }

  private formatPeers(peers: readonly CollaboratorPresence[]): string {
    if (peers.length === 0) {
      return "";
    }

    return peers
      .map((peer) => {
        const activeFile = (peer as any).activeFile as string | undefined;
        return `- ${peer.name} (${peer.status})${activeFile ? ` editing ${activeFile}` : ""}`;
      })
      .join("\n");
  }
}
