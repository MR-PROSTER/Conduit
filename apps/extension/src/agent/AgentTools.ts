import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { FileDiff, DiffHunk, DiffLine, SafetyBlock } from '@conduit/shared-types';
import type { AgentToolDefinition } from '@conduit/ai-core';
import type { AgentSafetyLock } from './AgentSafetyLock.js';

const execFileAsync = promisify(execFile);

export interface AgentToolResult {
  output: string;
  error: string | undefined;
  fileDiff: FileDiff | undefined;
}

type SafetyAction = 'wait' | 'proceed' | 'skip';

export class AgentTools {
  private readonly root: string;

  public constructor(
    private readonly safetyLock: AgentSafetyLock,
    private readonly onSafetyBlock: (block: SafetyBlock) => Promise<SafetyAction>
  ) {
    const folders = vscode.workspace.workspaceFolders;
    this.root = folders?.[0]?.uri.fsPath ?? '';
  }

  // ---------------------------------------------------------------------------
  // read_file
  // ---------------------------------------------------------------------------

  public async read_file(filePath: string): Promise<AgentToolResult> {
    try {
      const absPath = this.resolve(filePath);
      const content = await fs.readFile(absPath, 'utf-8');
      const numbered = content
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
        .join('\n');
      return { output: numbered, error: undefined, fileDiff: undefined };
    } catch (err) {
      return {
        output: '',
        error: `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // edit_file
  // ---------------------------------------------------------------------------

  public async edit_file(
    filePath: string,
    oldContent: string,
    newContent: string,
    startLine?: number,
    endLine?: number
  ): Promise<AgentToolResult> {
    const check = this.safetyLock.check(filePath);
    if (check.blocked && check.peerName) {
      const action = await this.onSafetyBlock({ filePath, peerName: check.peerName });
      if (action === 'skip') {
        return {
          output: `Skipped ${filePath} — ${check.peerName} is editing it.`,
          error: undefined,
          fileDiff: undefined,
        };
      }
      if (action === 'wait') {
        const start = Date.now();
        while (Date.now() - start < 60_000) {
          await new Promise<void>((r) => setTimeout(r, 2_000));
          if (!this.safetyLock.check(filePath).blocked) break;
        }
      }
      // 'proceed' falls through
    }

    try {
      const absPath = this.resolve(filePath);
      const current = await fs.readFile(absPath, 'utf-8').catch(() => '');
      const currentLines = current.split('\n');
      let updated: string;

      if (startLine !== undefined && endLine !== undefined) {
        // Line-range replacement — most reliable, preferred
        const s = Math.max(0, startLine - 1);
        const e = Math.min(currentLines.length, endLine);
        updated = [
          ...currentLines.slice(0, s),
          ...newContent.split('\n'),
          ...currentLines.slice(e),
        ].join('\n');
      } else if (oldContent) {
        // Exact-string replacement — fallback
        const normCurrent = current.replace(/\r\n/g, '\n');
        const normOld = oldContent.replace(/\r\n/g, '\n');
        if (!normCurrent.includes(normOld)) {
          const idx = normCurrent.indexOf(normOld.trim());
          if (idx === -1) {
            return {
              output: '',
              error:
                `Could not find the target content in ${filePath}. ` +
                `Use line numbers (start_line/end_line) for reliable edits. ` +
                `Call read_file to get current line numbers.`,
              fileDiff: undefined,
            };
          }
          updated =
            normCurrent.slice(0, idx) +
            newContent +
            normCurrent.slice(idx + normOld.trim().length);
        } else {
          updated = normCurrent.replace(normOld, newContent);
        }
      } else {
        // Replace whole file
        updated = newContent;
      }

      await fs.writeFile(absPath, updated, 'utf-8');
      const diff = this.buildDiff(filePath, current, updated);
      return { output: `Successfully edited ${filePath}`, error: undefined, fileDiff: diff };
    } catch (err) {
      return {
        output: '',
        error: `Failed to edit ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // create_file
  // ---------------------------------------------------------------------------

  public async create_file(
    filePath: string,
    content: string
  ): Promise<AgentToolResult> {
    try {
      const absPath = this.resolve(filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content, 'utf-8');
      return { output: `Created ${filePath}`, error: undefined, fileDiff: undefined };
    } catch (err) {
      return {
        output: '',
        error: `Failed to create ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // delete_file
  // ---------------------------------------------------------------------------

  public async delete_file(filePath: string): Promise<AgentToolResult> {
    const check = this.safetyLock.check(filePath);
    if (check.blocked && check.peerName) {
      const action = await this.onSafetyBlock({ filePath, peerName: check.peerName });
      if (action === 'skip') {
        return {
          output: `Skipped deleting ${filePath} — peer is editing it.`,
          error: undefined,
          fileDiff: undefined,
        };
      }
    }
    try {
      await fs.unlink(this.resolve(filePath));
      return { output: `Deleted ${filePath}`, error: undefined, fileDiff: undefined };
    } catch (err) {
      return {
        output: '',
        error: `Failed to delete ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // run_terminal
  // BUG FIX: was hardcoded to /bin/sh — now cross-platform.
  // ---------------------------------------------------------------------------

  public async run_terminal(command: string): Promise<AgentToolResult> {
    const BLOCKED = [
      'rm -rf /',
      'sudo',
      'git push',
      'git reset --hard',
      '| sh',
      '| bash',
      '> /dev',
      'format c:',
    ];
    if (BLOCKED.some((b) => command.includes(b))) {
      return {
        output: '',
        error: `Command blocked for safety: ${command}`,
        fileDiff: undefined,
      };
    }

    try {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];

      const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
        cwd: this.root,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      const combined = (stdout + (stderr ? `\nstderr: ${stderr}` : '')).slice(0, 8_000);
      return { output: combined, error: undefined, fileDiff: undefined };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        output: '',
        error: `Command failed: ${msg}`.slice(0, 2_000),
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // grep_codebase
  // BUG FIX: added maxBuffer to prevent ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
  // ---------------------------------------------------------------------------

  public async grep_codebase(
    pattern: string,
    fileGlob = '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h,md}'
  ): Promise<AgentToolResult> {
    try {
      const rgAvailable = await execFileAsync('which', ['rg'])
        .then(() => true)
        .catch(() => false);

      let args: string[];
      const cmd = rgAvailable ? 'rg' : 'grep';

      if (rgAvailable) {
        args = [
          '--line-number',
          '--with-filename',
          '--max-count=5',
          '--max-filesize=500K',
          '-g', fileGlob,
          '-g', '!node_modules',
          '-g', '!dist',
          '-g', '!.git',
          '--color=never',
          pattern,
          this.root,
        ];
      } else {
        args = ['-r', '-n', '--include=*.ts', '--include=*.js', '-m', '5', pattern, this.root];
      }

      const { stdout } = await execFileAsync(cmd, args, {
        cwd: this.root,
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024, // BUG FIX: was missing, caused crashes on large codebases
      });

      const lines = stdout.trim();
      if (!lines) {
        return { output: `No matches found for: ${pattern}`, error: undefined, fileDiff: undefined };
      }

      const output = lines
        .split('\n')
        .map((l) => l.replace(this.root + '/', '').replace(this.root + path.sep, ''))
        .slice(0, 50)
        .join('\n');

      return { output, error: undefined, fileDiff: undefined };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Exit code 1 from grep/rg = no matches, not an error
      if (msg.includes('exit code 1') || msg.includes('status 1')) {
        return { output: `No matches found for: ${pattern}`, error: undefined, fileDiff: undefined };
      }
      return { output: '', error: `grep failed: ${msg}`, fileDiff: undefined };
    }
  }

  // ---------------------------------------------------------------------------
  // get_symbol
  // BUG FIX: executeDefinitionProvider returns (Location | LocationLink)[],
  // not Location[]. LocationLink uses targetUri/targetRange, not uri/range.
  // ---------------------------------------------------------------------------

  public async get_symbol(
    filePath: string,
    symbolName: string
  ): Promise<AgentToolResult> {
    try {
      const absPath = this.resolve(filePath);
      const uri = vscode.Uri.file(absPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();

      const idx = text.indexOf(symbolName);
      if (idx === -1) {
        return {
          output: `Symbol "${symbolName}" not found in ${filePath}`,
          error: undefined,
          fileDiff: undefined,
        };
      }

      const pos = doc.positionAt(idx);
      const parts: string[] = [`Symbol: ${symbolName}`];

      // Hover — type signature + JSDoc
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        pos
      );
      if (hovers && hovers.length > 0) {
        const hoverText = hovers
          .flatMap((h) =>
            h.contents.map((c) => (typeof c === 'string' ? c : c.value))
          )
          .join('\n');
        parts.push(`Type info:\n${hoverText}`);
      }

      // Go-to-definition — BUG FIX: handle both Location and LocationLink
      const defs = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >('vscode.executeDefinitionProvider', uri, pos);

      if (defs && defs.length > 0) {
        const def = defs[0]!;
        // LocationLink has targetUri/targetRange; Location has uri/range
        const defUri = 'targetUri' in def ? def.targetUri : def.uri;
        const defRange = 'targetRange' in def ? def.targetRange : def.range;
        const defPath = vscode.workspace.asRelativePath(defUri);
        parts.push(`Defined in: ${defPath}:${defRange.start.line + 1}`);
      }

      return { output: parts.join('\n\n'), error: undefined, fileDiff: undefined };
    } catch (err) {
      return {
        output: '',
        error: `get_symbol failed: ${err instanceof Error ? err.message : String(err)}`,
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // search_files
  // ---------------------------------------------------------------------------

  public async search_files(query: string): Promise<AgentToolResult> {
    try {
      const uris = await vscode.workspace.findFiles(
        `**/*${query}*`,
        '**/node_modules/**',
        20
      );
      const results = uris
        .map((u) => vscode.workspace.asRelativePath(u))
        .join('\n');
      return {
        output: results || 'No files found',
        error: undefined,
        fileDiff: undefined,
      };
    } catch (err) {
      return {
        output: '',
        error: err instanceof Error ? err.message : String(err),
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // list_files
  // ---------------------------------------------------------------------------

  public async list_files(dirPath: string): Promise<AgentToolResult> {
    try {
      const entries = await fs.readdir(this.resolve(dirPath), { withFileTypes: true });
      const output = entries
        .filter((e) => !e.name.startsWith('.') || e.name === '.env')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n');
      return { output, error: undefined, fileDiff: undefined };
    } catch (err) {
      return {
        output: '',
        error: err instanceof Error ? err.message : String(err),
        fileDiff: undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // get_diagnostics
  // BUG FIX 1: added workspace-only filter (was returning diagnostics for ALL
  //            files including VS Code's internal files and node_modules).
  // BUG FIX 2: outputs error count as "N error(s)" so AgentExecutor.countErrors
  //            can parse it reliably.
  // ---------------------------------------------------------------------------

  public async get_diagnostics(): Promise<AgentToolResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      // BUG FIX: skip files outside workspace and in node_modules
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (rel.includes('node_modules') || rel.includes('dist/')) continue;

      for (const d of diags) {
        const loc = `${rel}:${d.range.start.line + 1}`;
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          errors.push(`ERROR ${loc} — ${d.message}`);
        } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
          warnings.push(`WARN  ${loc} — ${d.message}`);
        }
      }
    }

    if (errors.length === 0 && warnings.length === 0) {
      return {
        output: 'No errors or warnings. 0 error(s) found.',
        error: undefined,
        fileDiff: undefined,
      };
    }

    const parts: string[] = [];
    if (errors.length > 0) {
      // BUG FIX: always emit "N error(s)" so countErrors() works
      parts.push(`${errors.length} error(s):\n${errors.join('\n')}`);
    }
    if (warnings.length > 0) {
      parts.push(`${warnings.length} warning(s):\n${warnings.slice(0, 10).join('\n')}`);
    }

    return { output: parts.join('\n\n'), error: undefined, fileDiff: undefined };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolve(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(this.root, filePath);
  }

  private buildDiff(filePath: string, before: string, after: string): FileDiff {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const lines: DiffLine[] = [];
    const maxLen = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < maxLen; i++) {
      const b = beforeLines[i];
      const a = afterLines[i];
      if (b === a) {
        if (b !== undefined) lines.push({ type: 'ctx', content: b });
      } else {
        if (b !== undefined) lines.push({ type: 'del', content: b });
        if (a !== undefined) lines.push({ type: 'add', content: a });
      }
    }
    const hunk: DiffHunk = { oldStart: 1, newStart: 1, lines };
    return { filePath, hunks: [hunk] };
  }
}

// ---------------------------------------------------------------------------
// Tool definitions sent to the LLM
// ---------------------------------------------------------------------------

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read the full contents of a file with numbered lines. ' +
      'Use the line numbers in subsequent edit_file calls. ' +
      'You MUST call this before editing any file not already in the workspace context.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path from workspace root' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Edit a file using exact line numbers from read_file output. ' +
      'ALWAYS use start_line and end_line — this is the only reliable edit method. ' +
      'Using old_content string matching is a fallback only. ' +
      'After every edit_file call, IMMEDIATELY call get_diagnostics.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        new_content: { type: 'string', description: 'Replacement content for the specified lines' },
        start_line: {
          type: 'number',
          description: '1-indexed line to start replacement (inclusive). Use with end_line.',
        },
        end_line: {
          type: 'number',
          description: '1-indexed line to end replacement (inclusive). Use with start_line.',
        },
        old_content: {
          type: 'string',
          description:
            'Fallback: exact string to find and replace. Only use if line numbers are unavailable.',
        },
      },
      required: ['file_path', 'new_content'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file with the given content. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace. Safety lock is checked first.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'run_terminal',
    description:
      'Run a shell command in the workspace root. ' +
      'Use for: build (npm run build), tests (npm test), install (npm install), lint. ' +
      'Do NOT use for file operations — use edit_file/create_file/delete_file instead.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to run' } },
      required: ['command'],
    },
  },
  {
    name: 'grep_codebase',
    description:
      'Search for a text pattern across the entire codebase using ripgrep. ' +
      'Use this to: find where a function is called, find all usages of a symbol, ' +
      'find where a string appears, locate files by content.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for',
        },
        file_glob: {
          type: 'string',
          description: 'Optional glob to filter files, e.g. "*.ts" or "src/**/*.tsx"',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_symbol',
    description:
      'Get the type signature, JSDoc, and definition location of a symbol ' +
      'using the VS Code language server. Use before implementing or changing an interface.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File where the symbol appears' },
        symbol_name: { type: 'string', description: 'Exact name of the function, class, or variable' },
      },
      required: ['file_path', 'symbol_name'],
    },
  },
  {
    name: 'search_files',
    description:
      'Search for files by name pattern. Use grep_codebase instead when you need to search file contents.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Partial filename' } },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and subdirectories at a path.',
    input_schema: {
      type: 'object',
      properties: { dir_path: { type: 'string', description: 'Relative directory path' } },
      required: ['dir_path'],
    },
  },
  {
    name: 'get_diagnostics',
    description:
      'Get TypeScript/ESLint errors and warnings from VS Code diagnostics. ' +
      'ALWAYS run this after every edit_file or create_file call. ' +
      'Fix any errors before continuing with the next step.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];