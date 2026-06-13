import type { ContextRef, Session } from "@codesync/shared-types";
import type { CollaboratorPresence } from "../broadcast.js";

export interface PromptContextInfo {
  workspaceRoot?: string;
  session?: Session;
  openFiles?: readonly string[];
  activeFile?: string;
  cursorLine?: number;
  selection?: string;
  peers?: readonly CollaboratorPresence[];
  contextText?: string;
  contextRefs?: readonly ContextRef[];
}

function formatPeers(peers?: readonly CollaboratorPresence[]): string {
  if (!peers || peers.length === 0) {
    return "No peer presence reported.";
  }

  return peers
    .map((peer) => {
      const file = (peer as any).activeFile as string | undefined;
      return `- ${peer.name} (${peer.status})${file ? ` editing ${file}` : ""}`;
    })
    .join("\n");
}

function formatOpenFiles(openFiles?: readonly string[]): string {
  if (!openFiles || openFiles.length === 0) {
    return "No open files reported.";
  }

  return openFiles.map((file) => `- ${file}`).join("\n");
}

function formatSession(session?: Session): string {
  if (!session) {
    return "No active collaboration session.";
  }

  return [
    `Session ID: ${session.id}`,
    `Room ID: ${session.roomId}`,
    `Branch: ${session.branch}`,
    `Base commit: ${session.baseCommitHash}`,
    `Status: ${session.status}`,
  ].join("\n");
}

export function chatSystemPrompt(contextInfo: PromptContextInfo): string {
  const parts = [
    "You are CodeSync, a careful AI pair programmer embedded in VS Code.",
    "Answer directly and concisely. Prefer practical guidance and code snippets when useful.",
    "If the workspace context is relevant, use it. If not, say what is missing instead of guessing.",
    "",
    "Workspace info:",
    contextInfo.workspaceRoot ? `- Workspace root: ${contextInfo.workspaceRoot}` : "- Workspace root: unavailable",
    formatSession(contextInfo.session),
    "",
    "Open files:",
    formatOpenFiles(contextInfo.openFiles),
    "",
    "Active file:",
    contextInfo.activeFile
      ? `- ${contextInfo.activeFile}${contextInfo.cursorLine ? ` at line ${contextInfo.cursorLine}` : ""}${
          contextInfo.selection ? `\nSelection:\n${contextInfo.selection}` : ""
        }`
      : "- No active file.",
    "",
    "Peer presence:",
    formatPeers(contextInfo.peers),
  ];

  if (contextInfo.contextText) {
    parts.push("", "Additional workspace context:", contextInfo.contextText);
  }

  if (contextInfo.contextRefs && contextInfo.contextRefs.length > 0) {
    parts.push(
      "",
      "Referenced ranges:",
      ...contextInfo.contextRefs.map((ref) => `- ${ref.filePath}:${ref.startLine}-${ref.endLine} (${ref.nodeType})`)
    );
  }

  return parts.join("\n");
}

export function agentSystemPrompt(contextInfo: PromptContextInfo): string {
  const parts = [
    "You are CodeSync agent mode.",
    "You must work step by step, use tools, and modify the workspace when requested.",
    "Do not pretend a change is complete unless you have used the relevant file tools.",
    "When editing files, make the smallest safe change and verify the result.",
    "",
    "Rules:",
    "- Read before you edit.",
    "- Prefer targeted line edits over whole-file rewrites when possible.",
    "- If a peer is editing a file, treat that file as locked until the peer moves away.",
    "- After each write, verify the result and report what changed.",
    "- When the task is complete, summarize the actual file changes.",
    "",
    "Workspace info:",
    contextInfo.workspaceRoot ? `- Workspace root: ${contextInfo.workspaceRoot}` : "- Workspace root: unavailable",
    formatSession(contextInfo.session),
    "",
    "Open files:",
    formatOpenFiles(contextInfo.openFiles),
    "",
    "Active file:",
    contextInfo.activeFile
      ? `- ${contextInfo.activeFile}${contextInfo.cursorLine ? ` at line ${contextInfo.cursorLine}` : ""}`
      : "- No active file.",
    "",
    "Peer presence:",
    formatPeers(contextInfo.peers),
  ];

  if (contextInfo.contextText) {
    parts.push("", "Workspace context to use as grounding:", contextInfo.contextText);
  }

  if (contextInfo.contextRefs && contextInfo.contextRefs.length > 0) {
    parts.push(
      "",
      "Relevant ranges:",
      ...contextInfo.contextRefs.map((ref) => `- ${ref.filePath}:${ref.startLine}-${ref.endLine} (${ref.nodeType})`)
    );
  }

  return parts.join("\n");
}
