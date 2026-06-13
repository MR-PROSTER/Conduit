import type { CollaboratorPresence } from '../broadcast.js';
import type { AgentMemory, ChatThread } from '@conduit/shared-types';

export interface CodeNode {
  id: string;
  filePath: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'variable' | 'import';
  startLine: number;
  endLine: number;
  signature: string;
  docstring: string | undefined;
  relevanceScore: number;
}

export interface AskPromptOpts {
  projectContext: string | undefined;
  peers: readonly CollaboratorPresence[];
  codeGraphSlice: readonly CodeNode[];
  activeFile: string | undefined;
  cursorLine: number | undefined;
  threadType?: ChatThread['type'];
  activeFileContent?: string | undefined;
  activeFileDiagnostics?: string[] | undefined;
}

export interface AgentPromptOpts extends AskPromptOpts {
  agentMemory: AgentMemory;
  availableTools: readonly string[];
}

// ---------------------------------------------------------------------------
// ASK MODE — read-only, single LLM call
// ---------------------------------------------------------------------------

export function buildAskSystemPrompt(opts: AskPromptOpts): string {
  const isTeam =
    opts.threadType === 'group' || opts.threadType === 'public-fork';

  const parts: string[] = [];

  parts.push(
    `You are Conduit Copilot — a senior software engineer embedded in VS Code.\n` +
    `You are in READ-ONLY mode. You can explain, review, and suggest, but you do not edit files.\n\n` +
    `## Response rules\n` +
    `- Lead with the answer. No preamble, no "great question", no restating the question.\n` +
    `- Show working code in fenced code blocks. Never describe code in prose when you can show it.\n` +
    `- Reference exact symbols and locations: \`functionName\` in \`path/to/file.ts:42\`.\n` +
    `- If you are uncertain, say exactly what information you are missing.\n` +
    `- Short answers beat long answers when the question is simple.\n` +
    (isTeam
      ? `- This thread is visible to the whole team — write for everyone.\n`
      : `- This is a private thread — write directly for the person asking.\n`)
  );

  if (opts.projectContext) {
    parts.push(`## Project context\n${opts.projectContext}`);
  }

  if (opts.activeFile) {
    const cursorInfo =
      opts.cursorLine !== undefined ? ` (cursor at line ${opts.cursorLine})` : '';
    parts.push(`## Active file\n\`${opts.activeFile}\`${cursorInfo}`);

    if (opts.activeFileContent) {
      parts.push(`\`\`\`\n${opts.activeFileContent}\n\`\`\``);
    }
  }

  if (opts.activeFileDiagnostics && opts.activeFileDiagnostics.length > 0) {
    parts.push(
      `## Errors in active file\n` +
      opts.activeFileDiagnostics.slice(0, 10).map((d) => `- ${d}`).join('\n')
    );
  }

  const online = opts.peers.filter((p) => p.status === 'online');
  if (online.length > 0) {
    parts.push(
      `## Active teammates\n` +
      online.map((p) => {
        const file = (p as any).activeFile;
        return `- ${p.name}${file ? ` (editing \`${file}\`)` : ''}`;
      }).join('\n')
    );
  }

  if (opts.codeGraphSlice.length > 0) {
    const nodeLines = opts.codeGraphSlice
      .slice(0, 10)
      .map((n) =>
        `- \`${n.name}\` (${n.kind}) in \`${n.filePath}:${n.startLine}\`\n  ${n.signature}` +
        (n.docstring ? `\n  // ${n.docstring}` : '')
      )
      .join('\n');
    parts.push(`## Relevant symbols\n${nodeLines}`);
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// AGENT MODE — has tools, reads and edits files
// ---------------------------------------------------------------------------

/**
 * This prompt is set ONCE for the entire agent session.
 * File contents are injected via the first USER message, not here.
 * Keeping it static means every iteration sends the same system prompt,
 * which is cheaper and avoids confusing the model with a changing prompt.
 */
export function buildAgentSystemPrompt(opts: AgentPromptOpts): string {
  const parts: string[] = [];

  // --- Identity + environment ---
  parts.push(
    `You are Conduit, an AI coding agent running inside VS Code.\n` +
    `You have tools to read files, search the codebase, edit files, run shell commands, and check diagnostics.\n` +
    `The workspace files are provided in the first user message as \`<file>\` blocks with numbered lines.`
  );

  // --- Enforce Tool Usage ---
  parts.push(
    `## CRITICAL REQUIREMENT: YOU MUST USE TOOLS TO CREATE/MODIFY FILES\n` +
    `1. You are an active agent, NOT a chat assistant. Your goal is to apply changes directly to the user's workspace.\n` +
    `2. DO NOT output codeblocks representing new files or changes in your text response. Writing code inside markdown blocks in your text response does NOT write it to disk and is completely useless.\n` +
    `3. You MUST call \`create_file\` to create new files (e.g., config.py, utils.py).\n` +
    `4. You MUST call \`edit_file\` to modify existing files.\n` +
    `5. You MUST call \`delete_file\` to delete files.\n` +
    `6. If a user asks you to divide, refactor, split, create, or update code, you must invoke the corresponding tools. Explaining what you would write in text without calling the tool is a critical failure.`
  );

  // --- Hard rules — these are the most important part ---
  parts.push(
    `## Hard rules — never break these\n` +
    `1. NEVER guess file contents. Use \`read_file\` if you need to see a file not in the initial context.\n` +
    `2. NEVER use \`edit_file\` on a file you have not read in this session.\n` +
    `3. ALWAYS use \`start_line\`/\`end_line\` for every \`edit_file\` call. Using \`old_content\` string matching is fragile and forbidden.\n` +
    `4. ALWAYS call \`get_diagnostics\` immediately after every \`edit_file\` or \`create_file\` call.\n` +
    `5. If \`get_diagnostics\` shows errors you introduced, fix them BEFORE doing anything else.\n` +
    `6. NEVER make more than one logical change per iteration. Edit one thing, verify, then continue.\n` +
    `7. NEVER call \`run_terminal\` for file operations. Only use it for build/test/lint/install commands.\n` +
    `8. When the task is done, output a 2-3 sentence summary of what you changed. No lists, no headers.`
  );

  // --- Workflow ---
  parts.push(
    `## Workflow\n` +
    `1. **Understand** — Read the relevant files (use \`grep_codebase\` to find them if needed).\n` +
    `2. **Plan internally** — Think about what needs to change before making any edits.\n` +
    `3. **Edit surgically** — Use exact line numbers from \`read_file\` output. Touch only what must change.\n` +
    `4. **Verify always** — Run \`get_diagnostics\` after every edit. Fix any new errors immediately.\n` +
    `5. **Run tests** — After all edits are clean, run the relevant test or build command.\n` +
    `6. **Stop** — Do not do extra work. When the goal is met, summarise and stop.`
  );

  // --- Tool selection guide ---
  parts.push(
    `## Tool selection\n` +
    `| Want to... | Use |\n` +
    `|---|---|\n` +
    `| See file contents with line numbers | \`read_file\` |\n` +
    `| Find where a function/symbol is used | \`grep_codebase\` |\n` +
    `| Understand a type, class, or interface | \`get_symbol\` |\n` +
    `| Make a targeted edit | \`edit_file\` with \`start_line\`/\`end_line\` |\n` +
    `| Create a new file | \`create_file\` |\n` +
    `| Run build, test, install | \`run_terminal\` |\n` +
    `| Check for TypeScript/lint errors | \`get_diagnostics\` (ALWAYS after edits) |\n` +
    `| Find files by name | \`search_files\` |\n` +
    `| List a directory | \`list_files\` |`
  );

  // --- Edit quality rules ---
  parts.push(
    `## Edit quality\n` +
    `- Match the surrounding code style exactly: indentation, quotes, semicolons, naming.\n` +
    `- Preserve all existing behaviour unless the goal explicitly requires changing it.\n` +
    `- Do not add comments, console.log, or debug statements unless asked.\n` +
    `- Do not refactor code that isn't part of the task.\n` +
    `- If you need to add an import, add it at the top with the existing imports in the same style.`
  );

  // --- Self-repair loop (explicit instruction) ---
  parts.push(
    `## Self-repair loop\n` +
    `After every \`edit_file\`:\n` +
    `1. Call \`get_diagnostics\`.\n` +
    `2. If there are NEW errors (errors that weren't there before your edit), read the affected file and fix them.\n` +
    `3. Call \`get_diagnostics\` again.\n` +
    `4. Repeat until clean, then continue with the next step of the task.\n` +
    `Do NOT proceed to the next task step while there are unresolved errors you introduced.`
  );

  // --- Project and peer context ---
  if (opts.projectContext) {
    parts.push(`## Project context\n${opts.projectContext}`);
  }

  const online = opts.peers.filter((p) => p.status === 'online');
  if (online.length > 0) {
    const peerLines = online.map((p) => {
      const file = (p as any).activeFile;
      return `- ${p.name}${file ? ` is editing \`${file}\` — coordinate before editing that file` : ''}`;
    });
    parts.push(`## Active teammates (safety)\n${peerLines.join('\n')}`);
  }

  // --- Available tools list ---
  if (opts.availableTools.length > 0) {
    parts.push(
      `## Available tools\n` +
      opts.availableTools.map((t) => `- \`${t}\``).join('\n')
    );
  }

  return parts.join('\n\n');
}