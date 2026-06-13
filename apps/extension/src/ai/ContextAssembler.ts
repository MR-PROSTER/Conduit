import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ChatMessage, ChatThread, ContextRef } from '@conduit/shared-types';
import type { CollaboratorPresence } from '../broadcast.js';
import {
  buildAskSystemPrompt,
  buildAgentSystemPrompt,
  type CodeNode,
  type AskPromptOpts,
  type AgentPromptOpts,
} from './SystemPrompts.js';
import type { AgentMemory } from '@conduit/shared-types';

export interface AssembleOpts {
  thread: ChatThread;
  messages: readonly ChatMessage[];
  userInput: string;
  pinnedFiles: readonly string[];
  activeFile: string | undefined;
  cursorLine: number | undefined;
  peers: readonly CollaboratorPresence[];
  tokenBudget: number;
  agentMemory?: AgentMemory;
  mode: 'ask' | 'agent';
}

export interface AssembledContext {
  systemPrompt: string;
  /**
   * For agent mode: the full contents of relevant workspace files, formatted
   * as <file path="..."> blocks with numbered lines.
   * Injected into the FIRST user message by AgentExecutor.
   * Empty string for ask mode (context goes into conversationHistory instead).
   */
  contextBlock: string;
  conversationHistory: readonly { role: 'user' | 'assistant'; content: string }[];
  totalTokens: number;
  refs: readonly ContextRef[];
}

interface CodeIndex {
  nodes: CodeNode[];
  fileHashes: Map<string, string>;
  lastBuilt: number;
}

/** ~4 chars per token — rough but consistent */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function tfidfSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Map<string, number> => {
    const tokens = s.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return freq;
  };
  const fa = tokenize(a);
  const fb = tokenize(b);
  let dot = 0, normA = 0, normB = 0;
  for (const [term, freq] of fa) {
    normA += freq * freq;
    dot += freq * (fb.get(term) ?? 0);
  }
  for (const [, freq] of fb) normB += freq * freq;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function extractSignatures(content: string, filePath: string): CodeNode[] {
  const nodes: CodeNode[] = [];
  const lines = content.split('\n');
  const patterns: Array<{ regex: RegExp; kind: CodeNode['kind'] }> = [
    { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/m, kind: 'function' },
    { regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class' },
    { regex: /^\s*(?:export\s+)?interface\s+(\w+)/m, kind: 'interface' },
    { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::|=)/m, kind: 'variable' },
    { regex: /^\s*export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(/m, kind: 'function' },
    { regex: /^\s+(?:public|private|protected|static|async)*\s+(\w+)\s*\(/, kind: 'function' },
  ];
  const NOISE = new Set([
    'if', 'for', 'while', 'catch', 'switch', 'return', 'function',
    'constructor', 'typeof', 'instanceof', 'new', 'delete',
  ]);
  lines.forEach((line, idx) => {
    for (const { regex, kind } of patterns) {
      const match = regex.exec(line);
      if (match?.[1]) {
        const name = match[1];
        if (kind === 'function' && NOISE.has(name)) continue;
        nodes.push({
          id: `${filePath}:${idx}:${name}`,
          filePath,
          name,
          kind,
          startLine: idx + 1,
          endLine: Math.min(idx + 30, lines.length),
          signature: line.trim().slice(0, 120),
          docstring: undefined,
          relevanceScore: 0,
        });
        break;
      }
    }
  });
  return nodes;
}

/**
 * Walk first-hop imports from a file.
 * Returns relative paths of files that are directly imported.
 */
function extractImports(content: string, fromRelPath: string): string[] {
  const dir = path.dirname(fromRelPath);
  const importPaths: string[] = [];
  // Match: import ... from './foo' or require('./foo')
  const importRegex =
    /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    const rel = m[1];
    if (!rel) continue;
    const resolved = path.normalize(path.join(dir, rel)).replace(/\\/g, '/');
    importPaths.push(resolved);
  }
  return importPaths;
}

/** Number every line: "   1 | code here" */
function numberLines(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

export class ContextAssembler {
  private codeIndex: CodeIndex = { nodes: [], fileHashes: new Map(), lastBuilt: 0 };
  private readonly INDEX_TTL_MS = 30_000;

  public constructor() {
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const relPath = vscode.workspace.asRelativePath(doc.uri);
      this.codeIndex.nodes = this.codeIndex.nodes.filter(
        (n) => n.filePath !== relPath
      );
      void this.reindexFile(doc.uri.fsPath, relPath);
    });
  }

  private async reindexFile(fsPath: string, relPath: string): Promise<void> {
    try {
      const content = await fs.readFile(fsPath, 'utf-8');
      this.codeIndex.nodes.push(...extractSignatures(content, relPath));
    } catch { /* skip */ }
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  public async assemble(opts: AssembleOpts): Promise<AssembledContext> {
    if (opts.mode === 'agent') {
      return this.assembleForAgent(opts);
    }
    return this.assembleForAsk(opts);
  }

  // ---------------------------------------------------------------------------
  // AGENT MODE
  // The agent gets a rich context block with full file contents injected
  // into the first user message. The system prompt is static — it does NOT
  // include file contents (those are in contextBlock).
  // ---------------------------------------------------------------------------

  private async assembleForAgent(opts: AssembleOpts): Promise<AssembledContext> {
    const root = this.workspaceRoot();
    const projectContext = await this.loadProjectContext();

    // 1. Collect files to load: active file + open editors + pinned + 1-hop imports
    const filesToLoad = await this.collectAgentFiles(opts, root);

    // 2. Read each file and format as <file> block
    const fileBlocks: string[] = [];
    let totalContextChars = 0;
    const MAX_CONTEXT_CHARS = 120_000; // ~30k tokens — generous but bounded

    for (const relPath of filesToLoad) {
      if (totalContextChars >= MAX_CONTEXT_CHARS) break;
      try {
        const absPath = root ? path.join(root, relPath) : relPath;
        const raw = await fs.readFile(absPath, 'utf-8');
        const numbered = numberLines(raw);
        // Large files: include first 500 lines + last 50 lines
        const lines = numbered.split('\n');
        const excerpt =
          lines.length > 550
            ? [...lines.slice(0, 500), '     | ... [truncated — use read_file to see the rest] ...', ...lines.slice(-50)].join('\n')
            : numbered;
        const block = `<file path="${relPath}">\n${excerpt}\n</file>`;
        fileBlocks.push(block);
        totalContextChars += block.length;
      } catch { /* skip unreadable */ }
    }

    const contextBlock = fileBlocks.join('\n\n');

    // 3. Build relevant history (excluding contextBlock, which goes into the first user message)
    const relevantHistory = this.scoreHistory(opts.messages, opts.userInput);
    const historyBudget = Math.floor(opts.tokenBudget * 0.20);
    const conversationHistory = this.buildHistoryMessages(
      relevantHistory,
      '',
      historyBudget
    );

    // 4. Build static system prompt — no file contents here
    const systemPrompt = buildAgentSystemPrompt({
      projectContext: projectContext ?? undefined,
      peers: opts.peers,
      codeGraphSlice: [],
      activeFile: opts.activeFile,
      cursorLine: opts.cursorLine,
      agentMemory: opts.agentMemory ?? emptyMemory(),
      availableTools: [
        'read_file', 'grep_codebase', 'get_symbol', 'search_files', 'list_files',
        'edit_file', 'create_file', 'delete_file',
        'run_terminal', 'get_diagnostics',
      ],
    } as AgentPromptOpts);

    const refs: ContextRef[] = filesToLoad.slice(0, 8).map((fp) => ({
      filePath: fp,
      startLine: 1,
      endLine: 0,
      nodeType: 'function' as const,
    }));

    return {
      systemPrompt,
      contextBlock,
      conversationHistory,
      totalTokens:
        estimateTokens(systemPrompt) +
        estimateTokens(contextBlock) +
        conversationHistory.reduce((acc, m) => acc + estimateTokens(m.content), 0),
      refs,
    };
  }

  /**
   * Determine which files to load for agent context.
   * Priority order:
   *   1. Active file
   *   2. All other visible editors
   *   3. 1-hop imports from active file
   *   4. Pinned files
   * Deduplicated, capped at 12 files.
   */
  private async collectAgentFiles(
    opts: AssembleOpts,
    root: string | null
  ): Promise<string[]> {
    const seen = new Set<string>();
    const files: string[] = [];

    const add = (rel: string) => {
      const normalized = rel.replace(/\\/g, '/');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        files.push(normalized);
      }
    };

    // Active file
    if (opts.activeFile) add(opts.activeFile);

    // Visible text editors (not the active one)
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) add(rel);
    }

    // All dirty (modified) documents — the user is working in them
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && !doc.isUntitled) {
        const rel = vscode.workspace.asRelativePath(doc.uri, false);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) add(rel);
      }
    }

    // 1-hop imports from active file
    if (opts.activeFile && root) {
      try {
        const activeAbs = path.join(root, opts.activeFile);
        const activeContent = await fs.readFile(activeAbs, 'utf-8');
        const imports = extractImports(activeContent, opts.activeFile);
        for (const imp of imports) {
          // Try with common extensions
          for (const ext of ['', '.ts', '.tsx', '.js', '.jsx']) {
            const candidate = imp + ext;
            try {
              const absCandidate = path.join(root, candidate);
              await fs.access(absCandidate);
              add(candidate);
              break;
            } catch { /* try next */ }
          }
        }
      } catch { /* skip */ }
    }

    // Pinned files
    for (const p of opts.pinnedFiles) add(p);

    // Cap at 12 files to keep context tight
    return files.slice(0, 12);
  }

  // ---------------------------------------------------------------------------
  // ASK MODE
  // Standard context assembly — context goes into conversationHistory.
  // ---------------------------------------------------------------------------

  private async assembleForAsk(opts: AssembleOpts): Promise<AssembledContext> {
    const projectContext = await this.loadProjectContext();
    const activeFileContent = await this.getActiveEditorContent(
      opts.activeFile,
      opts.cursorLine
    );
    const pinnedContent = await this.getPinnedFilesContent(opts.pinnedFiles);
    const relevantHistory = this.scoreHistory(opts.messages, opts.userInput);
    const peerContext = this.buildPeerContext(opts.peers);
    const codeNodes = await this.queryCodeGraph(opts.userInput, opts.pinnedFiles);
    const activeFileDiagnostics = this.getActiveFileDiagnostics(opts.activeFile);

    const refs: ContextRef[] = codeNodes.slice(0, 8).map((n) => ({
      filePath: n.filePath,
      startLine: n.startLine,
      endLine: n.endLine,
      nodeType: n.kind,
    }));

    const budget = opts.tokenBudget;
    const systemBudget = Math.floor(budget * 0.30);
    const historyBudget = Math.floor(budget * 0.30);
    const codeBudget = Math.floor(budget * 0.30);
    const peerBudget = Math.floor(budget * 0.10);

    const promptOpts: AskPromptOpts = {
      projectContext: projectContext ?? undefined,
      peers: opts.peers,
      codeGraphSlice: codeNodes.slice(0, 12),
      activeFile: opts.activeFile,
      cursorLine: opts.cursorLine,
      activeFileContent: activeFileContent || undefined,
      activeFileDiagnostics:
        activeFileDiagnostics.length > 0 ? activeFileDiagnostics : undefined,
    };

    const systemPrompt = this.truncateToTokens(
      buildAskSystemPrompt(promptOpts),
      systemBudget
    );

    const codeContext = this.buildAskCodeContext(
      codeNodes,
      activeFileContent,
      pinnedContent,
      codeBudget
    );
    const peerBlock = this.truncateToTokens(peerContext, peerBudget);
    const contextBlock = [codeContext, peerBlock].filter(Boolean).join('\n\n');

    const conversationHistory = this.buildHistoryMessages(
      relevantHistory,
      contextBlock,
      historyBudget
    );

    const totalTokens =
      estimateTokens(systemPrompt) +
      estimateTokens(contextBlock) +
      conversationHistory.reduce((acc, m) => acc + estimateTokens(m.content), 0);

    return {
      systemPrompt,
      contextBlock: '', // not used in ask mode
      conversationHistory,
      totalTokens,
      refs,
    };
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private workspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.uri.fsPath ?? null;
  }

  private async loadProjectContext(): Promise<string | null> {
    const root = this.workspaceRoot();
    if (!root) return null;
    try {
      const content = await fs.readFile(path.join(root, 'ai-context.md'), 'utf-8');
      return content.slice(0, 2000);
    } catch {
      return null;
    }
  }

  private async getActiveEditorContent(
    filePath: string | undefined,
    cursorLine: number | undefined
  ): Promise<string> {
    if (!filePath) return '';
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '';
    const doc = editor.document;
    const totalLines = doc.lineCount;
    const center = cursorLine ?? Math.floor(totalLines / 2);
    const start = Math.max(0, center - 150);
    const end = Math.min(totalLines - 1, center + 150);
    const lines: string[] = [];
    for (let i = start; i <= end; i++) {
      lines.push(`${String(i + 1).padStart(4, ' ')} | ${doc.lineAt(i).text}`);
    }
    return `(lines ${start + 1}–${end + 1} of ${totalLines})\n${lines.join('\n')}`;
  }

  private getActiveFileDiagnostics(filePath: string | undefined): string[] {
    if (!filePath) return [];
    const results: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      // Only workspace files
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!filePath.endsWith(rel) && !rel.endsWith(filePath)) continue;
      for (const d of diags) {
        if (
          d.severity === vscode.DiagnosticSeverity.Error ||
          d.severity === vscode.DiagnosticSeverity.Warning
        ) {
          const kind =
            d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
          results.push(`${kind} at line ${d.range.start.line + 1}: ${d.message}`);
        }
      }
    }
    return results.slice(0, 15);
  }

  private async getPinnedFilesContent(
    pinnedFiles: readonly string[]
  ): Promise<string> {
    if (pinnedFiles.length === 0) return '';
    const root = this.workspaceRoot();
    if (!root) return '';
    const parts: string[] = [];
    const perFileBudget = Math.floor(3000 / Math.max(pinnedFiles.length, 1));
    const charLimit = perFileBudget * 4;
    for (const rel of pinnedFiles) {
      try {
        const content = await fs.readFile(path.join(root, rel), 'utf-8');
        parts.push(`// Pinned: ${rel}\n${content.slice(0, charLimit)}`);
      } catch { /* skip */ }
    }
    return parts.join('\n\n');
  }

  private scoreHistory(
    messages: readonly ChatMessage[],
    userInput: string
  ): ChatMessage[] {
    if (messages.length === 0) return [];
    const scored = messages.map((msg) => ({
      msg,
      score: tfidfSimilarity(userInput, msg.content),
    }));
    const last4 = messages.slice(-4);
    const topK = scored
      .filter((s) => !last4.includes(s.msg))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((s) => s.msg);
    const combined = [...topK, ...last4];
    const seen = new Set<string>();
    return combined
      .filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
  }

  private buildPeerContext(peers: readonly CollaboratorPresence[]): string {
    const online = peers.filter((p) => p.status === 'online');
    if (online.length === 0) return '';
    return (
      `Active teammates:\n` +
      online
        .map((p) => {
          const file = (p as any).activeFile;
          return `- ${p.name}${file ? ` (editing \`${file}\`)` : ''}`;
        })
        .join('\n')
    );
  }

  private async queryCodeGraph(
    userInput: string,
    _pinnedFiles: readonly string[]
  ): Promise<CodeNode[]> {
    await this.ensureCodeIndex();
    if (this.codeIndex.nodes.length === 0) return [];
    return this.codeIndex.nodes
      .map((node) => ({
        node,
        score: tfidfSimilarity(
          userInput,
          `${node.name} ${node.signature} ${node.filePath}`
        ),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map((s) => ({ ...s.node, relevanceScore: s.score }));
  }

  private async ensureCodeIndex(): Promise<void> {
    const now = Date.now();
    if (now - this.codeIndex.lastBuilt < this.INDEX_TTL_MS) return;
    const root = this.workspaceRoot();
    if (!root) return;
    const files = await vscode.workspace.findFiles(
      '**/*.{ts,tsx,js,jsx}',
      '**/node_modules/**',
      500
    );
    const nodes: CodeNode[] = [];
    for (const fileUri of files) {
      try {
        const content = await fs.readFile(fileUri.fsPath, 'utf-8');
        const relPath = path
          .relative(root, fileUri.fsPath)
          .replace(/\\/g, '/');
        nodes.push(...extractSignatures(content, relPath));
      } catch { /* skip */ }
    }
    this.codeIndex = { nodes, fileHashes: new Map(), lastBuilt: now };
  }

  private buildAskCodeContext(
    nodes: CodeNode[],
    activeContent: string,
    pinnedContent: string,
    budget: number
  ): string {
    const parts: string[] = [];
    let used = 0;

    if (activeContent) {
      const t = estimateTokens(activeContent);
      if (used + t < budget) { parts.push(activeContent); used += t; }
    }
    if (pinnedContent) {
      const t = estimateTokens(pinnedContent);
      if (used + t < budget) { parts.push(pinnedContent); used += t; }
    }
    for (const node of nodes) {
      const text = `// ${node.filePath}:${node.startLine}\n${node.signature}`;
      const t = estimateTokens(text);
      if (used + t >= budget) break;
      parts.push(text);
      used += t;
    }
    return parts.join('\n\n');
  }

  private buildHistoryMessages(
    messages: ChatMessage[],
    contextBlock: string,
    budget: number
  ): { role: 'user' | 'assistant'; content: string }[] {
    const result: { role: 'user' | 'assistant'; content: string }[] = [];
    let used = 0;

    if (contextBlock.trim()) {
      const ctx = { role: 'user' as const, content: `<context>\n${contextBlock}\n</context>` };
      const t = estimateTokens(ctx.content);
      if (used + t < budget) { result.push(ctx); used += t; }
    }

    for (const msg of messages) {
      const t = estimateTokens(msg.content);
      if (used + t >= budget) break;
      result.push({ role: msg.role, content: msg.content });
      used += t;
    }

    return result;
  }

  private truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n... [truncated]';
  }
}

function emptyMemory(): AgentMemory {
  return {
    taskId: 'ask',
    goal: '',
    plan: [],
    decisions: [],
    filesRead: new Map(),
    searchResults: new Map(),
    observations: [],
    editsApplied: [],
    stashRef: null,
    iteration: 0,
  };
}