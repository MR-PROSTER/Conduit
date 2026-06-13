import type { ILLMProvider, ChatCompletionMessage, ImageAttachment } from '@conduit/ai-core';
import type { AgentStep, SafetyBlock, FileDiff } from '@conduit/shared-types';
import type { ContextAssembler, AssembleOpts, AssembledContext } from '../ai/ContextAssembler.js';
import type { AgentTools } from './AgentTools.js';
import { AgentMemoryManager } from './AgentMemoryManager.js';
import { AGENT_TOOL_DEFINITIONS } from './AgentTools.js';

export interface AgentExecutionResult {
  success: boolean;
  stepsCompleted: AgentStep[];
  error: string | undefined;
  totalTokens: number;
}

export type AgentPauseAction = 'continue' | 'new_task';

export interface AgentPauseResult {
  action: AgentPauseAction;
  /** Only set when action === 'continue' — additional context to inject */
  additionalContext?: string;
}

// Maximum characters to include in a single tool result.
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_ITERATIONS = 30;

/**
 * Agent execution loop — Claude Code-style.
 *
 * Pause/Resume extension:
 * - Call pause() to suspend the loop mid-iteration.
 * - The loop will halt at the next iteration boundary and wait.
 * - Call resume(result) to continue (injecting optional context) or abort.
 * - If the user's follow-up is classified as 'new_task', the executor
 *   stops cleanly and reports success=false so the caller can start fresh.
 */
export class AgentExecutor {
  private steps: AgentStep[] = [];
  private stepCounter = 0;

  // ── Pause/resume state ──
  private _paused = false;
  private _pauseResolve: ((result: AgentPauseResult) => void) | null = null;
  private _pauseAbort: AbortController = new AbortController();

  public get isPaused(): boolean { return this._paused; }

  public pause(): void {
    this._paused = true;
    this._pauseAbort.abort();  // cancel the in-flight LLM call immediately
  }

  /**
   * Resume a paused executor.
   * - action='continue': inject additionalContext and keep running.
   * - action='new_task': stop cleanly (caller starts a new agent run).
   */
  public resume(result: AgentPauseResult): void {
    this._pauseAbort = new AbortController(); // fresh controller for next iteration
    if (this._pauseResolve) {
      this._pauseResolve(result);
      this._pauseResolve = null;
    }
    this._paused = false;
  }

  private waitForResume(): Promise<AgentPauseResult> {
    return new Promise<AgentPauseResult>((resolve) => {
      this._pauseResolve = resolve;
    });
  }

  public constructor(
    private readonly tools: AgentTools,
    private readonly llmProvider: ILLMProvider,
    private readonly onStep: (step: AgentStep) => void
  ) {}

  public async execute(
    goal: string,
    opts: {
      assembler: ContextAssembler;
      assembleOpts: AssembleOpts;
      preAssembled?: AssembledContext;
      images?: ImageAttachment[];
    },
    signal?: AbortSignal
  ): Promise<AgentExecutionResult> {
    const memManager = new AgentMemoryManager(`task-${Date.now()}`, goal);
    let totalTokens = 0;

    try {
      const baselineDiags = await this.tools.get_diagnostics();
      const baselineErrorCount = this.countErrors(baselineDiags.output);

      const stashResult = await this.tools.run_terminal(
        `git stash push -m "conduit-agent-${memManager.getMemory().taskId}"`
      );
      if (!stashResult.error) {
        memManager.setStashRef('stash@{0}');
      }

      const ctx = opts.preAssembled ?? await opts.assembler.assemble({
        ...opts.assembleOpts,
        agentMemory: memManager.getMemory(),
      });

      const messages: ChatCompletionMessage[] = [];

      if (ctx.conversationHistory && ctx.conversationHistory.length > 0) {
        const history = [...ctx.conversationHistory];
        const lastMsg = history[history.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          history.pop();
        }
        for (const msg of history) {
          messages.push({
            role: msg.role,
            content: msg.content,
          } as ChatCompletionMessage);
        }
      }

      const initialContent = ctx.contextBlock
        ? `<workspace_context>\n${ctx.contextBlock}\n</workspace_context>\n\n${goal}`
        : goal;

      const initialMsg: ChatCompletionMessage = opts.images && opts.images.length > 0
        ? { role: 'user', content: initialContent, images: opts.images }
        : { role: 'user', content: initialContent };
      messages.push(initialMsg);

      const systemPrompt = ctx.systemPrompt;

      let iteration = 0;
      let done = false;
      let consecutiveNoProgress = 0;
      const editedFiles = new Set<string>();

      while (iteration < MAX_ITERATIONS && !done) {
        if (signal?.aborted) {
          await this.rollback();
          return {
            success: false,
            stepsCompleted: this.steps,
            error: 'Aborted by user',
            totalTokens,
          };
        }

        // ── Pause point ──
        if (this._paused) {
          this.emitStep({
            type: 'verify',
            title: '⏸ Agent paused — waiting for your input…',
            body: undefined,
            status: 'pending',
            diff: undefined,
            safetyBlock: undefined,
          });

          const pauseResult = await this.waitForResume();

          if (pauseResult.action === 'new_task') {
            // User wants to start a new task — stop cleanly without rolling back
            this.emitStep({
              type: 'done',
              title: 'Session ended — starting new task',
              body: undefined,
              status: 'done',
              diff: undefined,
              safetyBlock: undefined,
            });
            return {
              success: false,
              stepsCompleted: this.steps,
              error: 'new_task',
              totalTokens,
            };
          }

          // action === 'continue': inject the new context as a user message
          if (pauseResult.additionalContext) {
            messages.push({
              role: 'user',
              content: `[User follow-up while agent was paused]\n${pauseResult.additionalContext}`,
            } as ChatCompletionMessage);
          }
        }

        iteration++;
        memManager.incrementIteration();

        let result: Awaited<ReturnType<ILLMProvider['runAgentIteration']>>;
        try {
          result = await this.llmProvider.runAgentIteration(
            messages,
            systemPrompt,
            AGENT_TOOL_DEFINITIONS,
            this._pauseAbort.signal
          );
        } catch (err: unknown) {
          // If we were paused while the LLM was mid-flight, the abort fires an
          // AbortError. Don't crash — just loop back so the pause-check at the
          // top of the while-loop can handle it cleanly.
          if (this._paused && (err as Error)?.name === 'AbortError') {
            continue;
          }
          throw err;
        }

        totalTokens += result.totalTokens ?? 0;

        messages.push({
          role: 'assistant',
          ...(result.content !== undefined ? { content: result.content } : {}),
          ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        } as ChatCompletionMessage);

        if (result.stopReason === 'end_turn' || result.toolCalls.length === 0) {
          this.emitStep({
            type: 'done',
            title: 'Task complete',
            body: result.content ?? 'Agent finished.',
            status: 'done',
            diff: undefined,
            safetyBlock: undefined,
          });
          done = true;
          break;
        }

        if (result.stopReason === 'max_tokens') {
          this.emitStep({
            type: 'error',
            title: 'Context limit reached',
            body: 'The agent hit the token limit. Stopping.',
            status: 'done',
            diff: undefined,
            safetyBlock: undefined,
          });
          done = true;
          break;
        }

        const toolResults = await this.executeToolsParallel(
          result.toolCalls,
          memManager,
          editedFiles
        );

        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            content: tr.content,
          });
        }

        const hasEdits = result.toolCalls.some(
          (tc) =>
            tc.name === 'edit_file' ||
            tc.name === 'create_file' ||
            tc.name === 'delete_file'
        );
        if (!hasEdits) {
          consecutiveNoProgress++;
          if (consecutiveNoProgress >= 5) {
            this.emitStep({
              type: 'error',
              title: 'No progress detected',
              body: 'Agent has run 5 iterations without editing files. Stopping.',
              status: 'done',
              diff: undefined,
              safetyBlock: undefined,
            });
            done = true;
          }
        } else {
          consecutiveNoProgress = 0;
        }
      }

      if (iteration >= MAX_ITERATIONS && !done) {
        this.emitStep({
          type: 'error',
          title: `Reached ${MAX_ITERATIONS} iterations`,
          body: 'Please review progress and continue manually or roll back.',
          status: 'done',
          diff: undefined,
          safetyBlock: undefined,
        });
      }

      const verifyStep = this.emitStep({
        type: 'verify',
        title: 'Running diagnostics…',
        body: undefined,
        status: 'running',
        diff: undefined,
        safetyBlock: undefined,
      });

      const diagResult = await this.tools.get_diagnostics();
      const newErrorCount = this.countErrors(diagResult.output);
      const agentErrors = newErrorCount - baselineErrorCount;
      const passed = agentErrors <= 0;

      this.updateStep(verifyStep.id, {
        status: 'done',
        title: passed
          ? 'All diagnostics clean ✓'
          : `${agentErrors} new error(s) introduced`,
        body: passed
          ? undefined
          : diagResult.output.split('\n').filter((l) => l.trim()).join('\n'),
      });

      return {
        success: passed,
        stepsCompleted: this.steps,
        error: passed ? undefined : diagResult.output,
        totalTokens,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitStep({
        type: 'error',
        title: 'Agent error',
        body: msg,
        status: 'done',
        diff: undefined,
        safetyBlock: undefined,
      });
      return { success: false, stepsCompleted: this.steps, error: msg, totalTokens };
    }
  }

  public async rollback(): Promise<void> {
    const step = this.emitStep({
      type: 'verify',
      title: 'Rolling back changes…',
      body: undefined,
      status: 'running',
      diff: undefined,
      safetyBlock: undefined,
    });
    await this.tools.run_terminal('git stash pop');
    this.updateStep(step.id, { status: 'done', title: 'All changes rolled back' });
  }

  // ---------------------------------------------------------------------------
  // Parallel tool execution
  // ---------------------------------------------------------------------------

  private async executeToolsParallel(
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    memManager: AgentMemoryManager,
    editedFiles: Set<string>
  ): Promise<Array<{ toolCallId: string; toolName: string; content: string }>> {
    const readTools = toolCalls.filter(
      (tc) =>
        tc.name !== 'edit_file' &&
        tc.name !== 'create_file' &&
        tc.name !== 'delete_file'
    );
    const writeTools = toolCalls.filter(
      (tc) =>
        tc.name === 'edit_file' ||
        tc.name === 'create_file' ||
        tc.name === 'delete_file'
    );

    const readResults = await Promise.all(
      readTools.map(async (tc) => {
        const result = await this.executeTool(tc.name, tc.input, memManager);
        return { toolCallId: tc.id, toolName: tc.name, content: this.formatToolResult(tc.name, result) };
      })
    );

    const writeResults: Array<{ toolCallId: string; toolName: string; content: string }> = [];
    for (const tc of writeTools) {
      const filePath = String(tc.input['file_path'] ?? '');
      editedFiles.add(filePath);
      const result = await this.executeTool(tc.name, tc.input, memManager);
      writeResults.push({
        toolCallId: tc.id,
        toolName: tc.name,
        content: this.formatToolResult(tc.name, result),
      });
    }

    const resultMap = new Map<string, { toolCallId: string; toolName: string; content: string }>();
    for (const r of [...readResults, ...writeResults]) resultMap.set(r.toolCallId, r);
    return toolCalls.map((tc) => resultMap.get(tc.id)!).filter(Boolean);
  }

  private formatToolResult(
    toolName: string,
    result: { output: string; error: string | undefined }
  ): string {
    const raw = result.error ? `Error: ${result.error}` : result.output;
    if (raw.length <= MAX_TOOL_OUTPUT_CHARS) return raw;
    return (
      raw.slice(0, MAX_TOOL_OUTPUT_CHARS) +
      `\n\n[Output truncated at ${MAX_TOOL_OUTPUT_CHARS} chars. Use read_file to see the full file.]`
    );
  }

  // ---------------------------------------------------------------------------
  // Tool dispatch
  // ---------------------------------------------------------------------------

  private async executeTool(
    toolName: string,
    input: Record<string, unknown>,
    memManager: AgentMemoryManager
  ): Promise<{ output: string; error: string | undefined; fileDiff: FileDiff | undefined }> {
    const step = this.emitStep({
      type: this.toolToStepType(toolName),
      title: this.buildStepTitle(toolName, input),
      body: undefined,
      status: 'running',
      diff: undefined,
      safetyBlock: undefined,
    });

    let result: { output: string; error: string | undefined; fileDiff: FileDiff | undefined };

    switch (toolName) {
      case 'read_file': {
        const fp = String(input['file_path'] ?? '');
        result = await this.tools.read_file(fp);
        if (!result.error) {
          memManager.recordFileRead(fp, result.output);
          memManager.compressAfterRead(fp);
        }
        break;
      }
      case 'edit_file': {
        const fp = String(input['file_path'] ?? '');
        const startLine =
          input['start_line'] !== undefined ? Number(input['start_line']) : undefined;
        const endLine =
          input['end_line'] !== undefined ? Number(input['end_line']) : undefined;
        result = await this.tools.edit_file(
          fp,
          String(input['old_content'] ?? ''),
          String(input['new_content'] ?? ''),
          startLine,
          endLine
        );
        if (!result.error) {
          memManager.addEdit({
            filePath: fp,
            previousContent: String(input['old_content'] ?? ''),
            newContent: String(input['new_content'] ?? ''),
            approved: true,
          });
        }
        break;
      }
      case 'create_file':
        result = await this.tools.create_file(
          String(input['file_path'] ?? ''),
          String(input['content'] ?? '')
        );
        break;
      case 'delete_file':
        result = await this.tools.delete_file(String(input['file_path'] ?? ''));
        break;
      case 'run_terminal':
        result = await this.tools.run_terminal(String(input['command'] ?? ''));
        break;
      case 'search_files':
        result = await this.tools.search_files(String(input['query'] ?? ''));
        break;
      case 'list_files':
        result = await this.tools.list_files(String(input['dir_path'] ?? '.'));
        break;
      case 'get_diagnostics':
        result = await this.tools.get_diagnostics();
        break;
      case 'grep_codebase':
        result = await this.tools.grep_codebase(
          String(input['pattern'] ?? ''),
          input['file_glob'] ? String(input['file_glob']) : undefined
        );
        break;
      case 'get_symbol':
        result = await this.tools.get_symbol(
          String(input['file_path'] ?? ''),
          String(input['symbol_name'] ?? '')
        );
        break;
      default:
        result = {
          output: '',
          error: `Unknown tool: ${toolName}`,
          fileDiff: undefined,
        };
    }

    this.updateStep(step.id, {
      status: 'done',
      body: (result.error ?? result.output).slice(0, 400),
      diff: result.fileDiff,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private countErrors(output: string): number {
    const match = /(\d+) error/.exec(output);
    return match ? parseInt(match[1]!, 10) : 0;
  }

  private emitStep(step: Omit<AgentStep, 'id'>): AgentStep {
    const s: AgentStep = { ...step, id: `step-${++this.stepCounter}` } as AgentStep;
    this.steps.push(s);
    this.onStep(s);
    return s;
  }

  private updateStep(id: string, updates: Partial<Omit<AgentStep, 'id'>>): void {
    const idx = this.steps.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const updated: AgentStep = { ...this.steps[idx]!, ...updates };
    this.steps[idx] = updated;
    this.onStep(updated);
  }

  private toolToStepType(toolName: string): AgentStep['type'] {
    switch (toolName) {
      case 'edit_file':
      case 'create_file':
      case 'delete_file':
        return 'edit';
      case 'run_terminal':
      case 'get_diagnostics':
        return 'verify';
      default:
        return 'read';
    }
  }

  private buildStepTitle(
    toolName: string,
    input: Record<string, unknown>
  ): string {
    switch (toolName) {
      case 'read_file':
        return `Read ${String(input['file_path'] ?? '')}`;
      case 'edit_file':
        return (
          `Edit ${String(input['file_path'] ?? '')}` +
          (input['start_line']
            ? ` (lines ${input['start_line']}–${input['end_line']})`
            : '')
        );
      case 'create_file':
        return `Create ${String(input['file_path'] ?? '')}`;
      case 'delete_file':
        return `Delete ${String(input['file_path'] ?? '')}`;
      case 'run_terminal':
        return `Run: ${String(input['command'] ?? '').slice(0, 60)}`;
      case 'grep_codebase':
        return `Grep: ${String(input['pattern'] ?? '')}`;
      case 'get_symbol':
        return `Symbol: ${String(input['symbol_name'] ?? '')} in ${String(input['file_path'] ?? '')}`;
      case 'search_files':
        return `Search files: ${String(input['query'] ?? '')}`;
      case 'list_files':
        return `List: ${String(input['dir_path'] ?? '.')}`;
      case 'get_diagnostics':
        return 'Check diagnostics';
      default:
        return toolName;
    }
  }
}