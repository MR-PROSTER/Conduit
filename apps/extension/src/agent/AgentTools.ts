import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diffLines } from "diff";
import * as vscode from "vscode";
import type { AgentToolDefinition } from "@conduit/ai-core";
import type { DiffHunk, DiffLine, FileDiff, SafetyBlock } from "@conduit/shared-types";
import type { AgentSafetyLock, SafetyCheckResult } from "./AgentSafetyLock.js";

const execFileAsync = promisify(execFile);

export interface AgentToolResult {
  output: string;
  error?: string;
  fileDiff?: FileDiff;
  safetyBlock?: SafetyBlock;
}

export type SafetyAction = "wait" | "proceed" | "skip";

export interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface EditFileArgs {
  path: string;
  oldContent: string;
  newContent: string;
  startLine?: number;
  endLine?: number;
  force?: boolean;
}

export interface RunTerminalArgs {
  command: string;
}

export interface SearchCodebaseArgs {
  query: string;
}

export interface ListDirectoryArgs {
  path: string;
}

export interface CreateFileArgs {
  path: string;
  content: string;
}

export interface DeleteFileArgs {
  path: string;
}

export class AgentTools {
  private readonly workspaceRoot: string;

  constructor(
    private readonly safetyLock: AgentSafetyLock,
    private readonly onSafetyBlock: (block: SafetyBlock) => Promise<SafetyAction> | SafetyAction
  ) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error("Agent tools require an open workspace folder.");
    }

    this.workspaceRoot = root;
  }

  checkSafety(filePath: string): SafetyCheckResult {
    return this.safetyLock.check(filePath);
  }

  getToolDefinitions(): readonly AgentToolDefinition[] {
    return [
      {
        name: "read_file",
        description: "Read a file and return numbered lines.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "edit_file",
        description: "Replace file content or a numbered line range.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldContent: { type: "string" },
            newContent: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
          required: ["path", "oldContent", "newContent"],
          additionalProperties: false,
        },
      },
      {
        name: "run_terminal",
        description: "Run a terminal command in the workspace root.",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      {
        name: "search_codebase",
        description: "Search file names and file contents for a query string.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "list_directory",
        description: "List a directory with file types.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "create_file",
        description: "Create a new file. Fails if the file already exists.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      {
        name: "delete_file",
        description: "Delete an existing file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ];
  }

  async read_file(args: ReadFileArgs): Promise<AgentToolResult> {
    try {
      const absPath = await this.resolveExistingPath(args.path);
      const content = await fs.readFile(absPath, "utf8");
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, args.startLine ?? 1);
      const end = Math.min(lines.length, args.endLine ?? lines.length);
      const output = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(4, " ")} | ${line}`)
        .join("\n");

      return { output };
    } catch (error) {
      return { output: "", error: this.formatError("read_file", args.path, error) };
    }
  }

  async edit_file(args: EditFileArgs): Promise<AgentToolResult> {
    const safety = this.safetyLock.check(args.path);
    if (safety.blocked) {
      return {
        output: "",
        error: "SAFETY_BLOCK",
        safetyBlock: { filePath: args.path, peerName: safety.peerName ?? "A peer" },
      };
    }

    try {
      const absPath = await this.resolveExistingPath(args.path);
      const before = await fs.readFile(absPath, "utf8");
      const after = this.applyEdit(before, args);
      await fs.writeFile(absPath, after, "utf8");

      return {
        output: `Edited ${args.path}`,
        fileDiff: buildFileDiff(args.path, before, after),
      };
    } catch (error) {
      return { output: "", error: this.formatError("edit_file", args.path, error) };
    }
  }

  async run_terminal(args: RunTerminalArgs): Promise<AgentToolResult> {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", args.command], {
        cwd: this.workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
      });

      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      return { output: output || "(no output)" };
    } catch (error) {
      return { output: "", error: this.formatError("run_terminal", args.command, error) };
    }
  }

  async search_codebase(args: SearchCodebaseArgs): Promise<AgentToolResult> {
    try {
      const query = args.query.trim();
      if (!query) {
        return { output: "", error: "Query cannot be empty." };
      }

      const hits: string[] = [];
      await this.walkWorkspace(async (absPath, relPath, dirent) => {
        if (dirent.isDirectory()) {
          if (this.shouldSkipDirectory(dirent.name)) {
            return false;
          }
          if (relPath.toLowerCase().includes(query.toLowerCase())) {
            hits.push(`FILE ${relPath}/`);
          }
          return true;
        }

        if (relPath.toLowerCase().includes(query.toLowerCase())) {
          hits.push(`FILE ${relPath}`);
        }

        if (this.shouldSearchContent(absPath)) {
          const content = await fs.readFile(absPath, "utf8").catch(() => "");
          if (content.toLowerCase().includes(query.toLowerCase())) {
            const lines = content.split(/\r?\n/);
            lines.forEach((line, index) => {
              if (line.toLowerCase().includes(query.toLowerCase())) {
                hits.push(`${relPath}:${index + 1}: ${line.trim()}`);
              }
            });
          }
        }

        return true;
      });

      return {
        output: hits.length > 0 ? hits.slice(0, 250).join("\n") : `No matches found for "${query}"`,
      };
    } catch (error) {
      return { output: "", error: this.formatError("search_codebase", args.query, error) };
    }
  }

  async list_directory(args: ListDirectoryArgs): Promise<AgentToolResult> {
    try {
      const absPath = this.resolvePath(args.path);
      const entries = await fs.readdir(absPath, { withFileTypes: true });
      const output = entries
        .map((entry) => `${entry.isDirectory() ? "dir " : entry.isFile() ? "file" : "oth "} ${entry.name}`)
        .join("\n");
      return { output: output || "(empty directory)" };
    } catch (error) {
      return { output: "", error: this.formatError("list_directory", args.path, error) };
    }
  }

  async create_file(args: CreateFileArgs): Promise<AgentToolResult> {
    try {
      const absPath = this.resolvePath(args.path);
      try {
        await fs.stat(absPath);
        throw new Error("File already exists.");
      } catch (error) {
        if (error instanceof Error && error.message === "File already exists.") {
          throw error;
        }
      }

      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, args.content, "utf8");
      return { output: `Created ${args.path}` };
    } catch (error) {
      return { output: "", error: this.formatError("create_file", args.path, error) };
    }
  }

  async delete_file(args: DeleteFileArgs): Promise<AgentToolResult> {
    try {
      const absPath = await this.resolveExistingPath(args.path);
      await fs.unlink(absPath);
      return { output: `Deleted ${args.path}` };
    } catch (error) {
      return { output: "", error: this.formatError("delete_file", args.path, error) };
    }
  }

  async handleSafetyBlock(block: SafetyBlock): Promise<SafetyAction> {
    const action = await this.onSafetyBlock(block);
    return action;
  }

  private applyEdit(before: string, args: EditFileArgs): string {
    const beforeLines = before.split(/\r?\n/);
    const newLines = args.newContent.split(/\r?\n/);

    if (typeof args.startLine === "number" && typeof args.endLine === "number") {
      const startIndex = Math.max(0, Math.min(beforeLines.length, args.startLine - 1));
      const endIndex = Math.max(startIndex, Math.min(beforeLines.length, args.endLine));
      return [...beforeLines.slice(0, startIndex), ...newLines, ...beforeLines.slice(endIndex)].join("\n");
    }

    const oldContent = args.oldContent.replace(/\r\n/g, "\n");
    const normalizedBefore = before.replace(/\r\n/g, "\n");
    if (!normalizedBefore.includes(oldContent)) {
      throw new Error("The provided oldContent did not match the current file content.");
    }

    return normalizedBefore.replace(oldContent, args.newContent);
  }

  private async walkWorkspace(
    visit: (absPath: string, relPath: string, dirent: Dirent) => boolean | Promise<boolean>
  ): Promise<void> {
    const visitDir = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(this.workspaceRoot, absPath).replace(/\\/g, "/");
        const shouldContinue = await visit(absPath, relPath, entry);
        if (entry.isDirectory() && shouldContinue !== false) {
          await visitDir(absPath);
        }
      }
    };

    await visitDir(this.workspaceRoot);
  }

  private shouldSkipDirectory(name: string): boolean {
    return [".git", "node_modules", "dist", "out", "build", ".vscode"].includes(name);
  }

  private shouldSearchContent(absPath: string): boolean {
    return path.extname(absPath).length > 0 && !this.shouldSkipDirectory(path.basename(path.dirname(absPath)));
  }

  private resolvePath(filePath: string): string {
    const absPath = path.resolve(this.workspaceRoot, filePath);
    const root = this.workspaceRoot.endsWith(path.sep) ? this.workspaceRoot : `${this.workspaceRoot}${path.sep}`;
    if (absPath !== this.workspaceRoot && !absPath.startsWith(root)) {
      throw new Error(`Path escapes the workspace root: ${filePath}`);
    }
    return absPath;
  }

  private async resolveExistingPath(filePath: string): Promise<string> {
    const absPath = this.resolvePath(filePath);
    await fs.access(absPath);
    return absPath;
  }

  private formatError(tool: string, target: string, error: unknown): string {
    return `${tool}(${target}) failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildFileDiff(filePath: string, before: string, after: string): FileDiff {
  const changes = diffLines(before, after);
  const hunks: DiffHunk[] = [];
  const currentLines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let hunkOldStart = oldLine;
  let hunkNewStart = newLine;

  for (const change of changes) {
    const lines = change.value.split(/\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const kind = change.added ? "add" : change.removed ? "del" : "ctx";

    if (currentLines.length === 0) {
      hunkOldStart = oldLine;
      hunkNewStart = newLine;
    }

    for (const line of lines) {
      currentLines.push({ type: kind, content: line });
      if (change.added) {
        newLine += 1;
      } else if (change.removed) {
        oldLine += 1;
      } else {
        oldLine += 1;
        newLine += 1;
      }
    }
  }

  if (currentLines.length > 0) {
    hunks.push({
      oldStart: hunkOldStart,
      newStart: hunkNewStart,
      lines: currentLines,
    });
  }

  return { filePath, hunks };
}
