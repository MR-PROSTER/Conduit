import crypto from "node:crypto";
import type { AgentToolCall, ChatCompletionMessage, ILLMProvider } from "@conduit/ai-core";
import type { AgentMemory, AgentStep, FileDiff, SafetyBlock } from "@conduit/shared-types";
import type { AgentMemoryManager } from "./AgentMemoryManager.js";
import type { AgentTools, AgentToolResult } from "./AgentTools.js";

export interface AgentRunResult {
  content: string;
  memoryTaskId: string;
  stopReason: "end_turn" | "max_tokens" | "max_iterations" | "aborted";
  totalTokens: number;
  memory: AgentMemory;
}

type StepStatus = "running" | "done" | "blocked" | "error" | "skipped";

const MAX_ITERATIONS = 20;

export class AgentExecutor {
  constructor(
    private readonly llmProvider: ILLMProvider,
    private readonly agentTools: AgentTools,
    private readonly agentMemoryManager: AgentMemoryManager,
    private readonly onStep: (step: AgentStep) => void
  ) {}

  async run(
    goal: string,
    initialMessages: readonly ChatCompletionMessage[],
    signal?: AbortSignal
  ): Promise<AgentRunResult> {
    const taskId = crypto.randomUUID();
    let memory = this.agentMemoryManager.createMemory(taskId, goal);
    let messages: ChatCompletionMessage[] = [...initialMessages];
    let totalTokens = 0;
    let lastContent = "";

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      if (signal?.aborted) {
        this.emitStep("error", "Aborted", "Execution was cancelled.");
        return {
          content: lastContent,
          memoryTaskId: taskId,
          stopReason: "aborted",
          totalTokens,
          memory,
        };
      }

      memory = this.agentMemoryManager.updateMemory(memory, {
        iteration: memory.iteration + 1,
      });

      const result = await this.llmProvider.runAgentIteration(
        messages,
        this.agentTools.getToolDefinitions(),
        {
          systemPrompt: this.buildSystemPrompt(goal, memory),
          signal,
        }
      );

      totalTokens += result.totalTokens;
      lastContent = result.content;
      memory = this.agentMemoryManager.addDecision(memory, {
        decision: result.content.trim() || "Continue using tools",
        reason: result.stopReason === "tool_use" ? "Tool use requested by the model" : "Direct assistant response",
        confidence: result.toolCalls.length > 0 ? 0.7 : 0.6,
      });

      if (result.content.trim()) {
        messages.push({ role: "assistant", content: result.content });
      }

      if (result.stopReason === "max_tokens") {
        this.emitStep("error", "Token limit reached", "The model hit the token limit.");
        return {
          content: lastContent,
          memoryTaskId: taskId,
          stopReason: "max_tokens",
          totalTokens,
          memory: this.agentMemoryManager.compressMemory(memory),
        };
      }

      if (result.toolCalls.length === 0 || result.stopReason === "end_turn") {
        this.emitStep("done", "Task complete", result.content || "Agent finished.");
        memory = this.agentMemoryManager.compressMemory(memory);
        return {
          content: lastContent,
          memoryTaskId: taskId,
          stopReason: "end_turn",
          totalTokens,
          memory,
        };
      }

      const toolResults: Array<{ toolCall: AgentToolCall; result: AgentToolResult }> = [];
      for (const toolCall of result.toolCalls) {
        const execution = await this.executeToolCall(toolCall, memory);
        memory = execution.memory;
        toolResults.push({ toolCall, result: execution.result });
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: formatToolResult(toolCall.name, execution.result),
        });
      }

      memory = this.agentMemoryManager.compressMemory(memory);
    }

    this.emitStep("error", `Max iterations reached`, `Stopped after ${MAX_ITERATIONS} iterations.`);
    return {
      content: lastContent,
      memoryTaskId: taskId,
      stopReason: "max_iterations",
      totalTokens,
      memory: this.agentMemoryManager.compressMemory(memory),
    };
  }

  private async executeToolCall(
    toolCall: AgentToolCall,
    memory: AgentMemory
  ): Promise<{ result: AgentToolResult; memory: AgentMemory }> {
    const stepType = this.toolToStepType(toolCall.name);
    const startStep = this.emitStep(stepType, this.toolTitle(toolCall.name, toolCall.input), "running");

    const tool = (this.agentTools as unknown as Record<
      string,
      ((input: Record<string, unknown>) => Promise<AgentToolResult>) | undefined
    >)[toolCall.name];
    if (typeof tool !== "function") {
      const result: AgentToolResult = {
        output: "",
        error: `Unknown tool: ${toolCall.name}`,
      };
      this.updateStep(startStep.id, stepType, startStep.title, "error", result.error);
      return { result, memory };
    }

    const args = this.normalizeToolInput(toolCall.input);
    const filePath = this.getStringArg(args, "path");
    const oldContent = this.getStringArg(args, "oldContent");
    const newContent = this.getStringArg(args, "newContent");
    let result = await tool.call(this.agentTools, args);

    if (toolCall.name === "edit_file" && result.error === "SAFETY_BLOCK" && result.safetyBlock) {
      const decision = await this.agentTools.handleSafetyBlock(result.safetyBlock);
      this.emitStep(
        "safety-check",
        `Safety block: ${result.safetyBlock.peerName}`,
        `${result.safetyBlock.filePath} is currently being edited by ${result.safetyBlock.peerName}.`,
        "blocked",
        undefined,
        result.safetyBlock
      );

      if (decision === "skip") {
        const skipped: AgentToolResult = {
          output: `Skipped ${filePath}`,
          safetyBlock: result.safetyBlock,
        };
        this.updateStep(startStep.id, "safety-check", `Skipped ${filePath}`, "skipped", skipped.output, undefined, result.safetyBlock);
        return { result: skipped, memory };
      }

      if (decision === "wait") {
        result = await this.waitForSafetyClear(filePath, toolCall, tool, args);
      } else if (decision === "proceed") {
        result = await tool.call(this.agentTools, {
          ...args,
          force: true,
        });
      }
    }

    if (!result.error && toolCall.name === "read_file") {
      memory = this.agentMemoryManager.recordFileRead(memory, filePath, result.output);
      memory = this.agentMemoryManager.addObservation(memory, {
        observation: `Read ${filePath}`,
        relevantFiles: [filePath],
      });
    }

    if (!result.error && toolCall.name === "edit_file") {
      memory = this.agentMemoryManager.addEdit(memory, {
        filePath,
        previousContent: oldContent,
        newContent,
        approved: true,
      });
    }

    this.updateStep(
      startStep.id,
      stepType,
      startStep.title,
      result.error ? "error" : "done",
      result.error ? result.error : result.output,
      result.fileDiff
    );

    if (toolCall.name === "edit_file" && !result.error) {
      this.emitStep(
        "verify",
        `Verify ${args.path}`,
        "Write applied successfully.",
        "done",
        result.fileDiff
      );
    }

    return { result, memory };
  }

  private async waitForSafetyClear(
    filePath: string,
    toolCall: AgentToolCall,
    tool: (input: Record<string, unknown>) => Promise<AgentToolResult>,
    args: Record<string, unknown>
  ): Promise<AgentToolResult> {
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      if (!this.agentTools.checkSafety(filePath).blocked) {
        return await tool.call(this.agentTools, args);
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    return {
      output: "",
      error: `Timed out waiting for safety lock on ${toolCall.name}`,
    };
  }

  private normalizeToolInput(input: unknown): Record<string, unknown> {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }

    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through
      }
    }

    return {};
  }

  private getStringArg(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    return typeof value === "string" ? value : "";
  }

  private buildSystemPrompt(goal: string, memory: ReturnType<AgentMemoryManager["getCurrentMemory"]>): string {
    return [
      "You are an agent operating inside a VS Code workspace.",
      `Goal: ${goal}`,
      `Iteration: ${memory?.iteration ?? 0}`,
      memory ? this.describeMemory(memory) : "",
      "Use tools deliberately and keep changes minimal.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private describeMemory(memory: NonNullable<ReturnType<AgentMemoryManager["getCurrentMemory"]>>): string {
    const fileSummaries = [...memory.filesRead.values()]
      .slice(0, 8)
      .map((entry) => `- ${entry.path}: ${entry.signature}`)
      .join("\n");

    return [
      `Memory summary:`,
      memory.plan ? `Plan: ${memory.plan}` : undefined,
      memory.decisions.length ? `Recent decision: ${memory.decisions[memory.decisions.length - 1]?.decision}` : undefined,
      fileSummaries ? `Files:\n${fileSummaries}` : undefined,
      memory.observations.length ? `Recent observation: ${memory.observations[memory.observations.length - 1]?.observation}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private toolToStepType(toolName: string): AgentStep["type"] {
    if (toolName === "edit_file" || toolName === "create_file" || toolName === "delete_file") {
      return "edit";
    }
    if (toolName === "run_terminal") {
      return "verify";
    }
    if (toolName === "search_codebase" || toolName === "list_directory" || toolName === "read_file") {
      return "read";
    }
    return "verify";
  }

  private toolTitle(toolName: string, input: unknown): string {
    const args = this.normalizeToolInput(input);
    const target = String(args.path ?? args.query ?? args.command ?? "");

    switch (toolName) {
      case "read_file":
        return `Read ${target}`;
      case "edit_file":
        return `Edit ${target}`;
      case "run_terminal":
        return `Run ${target.slice(0, 60)}`;
      case "search_codebase":
        return `Search ${target}`;
      case "list_directory":
        return `List ${target || "."}`;
      case "create_file":
        return `Create ${target}`;
      case "delete_file":
        return `Delete ${target}`;
      default:
        return toolName;
    }
  }

  private emitStep(
    type: AgentStep["type"],
    title: string,
    body?: string,
    status: StepStatus = "running",
    diff?: FileDiff,
    safetyBlock?: SafetyBlock
  ): AgentStep {
    const step: AgentStep = {
      id: crypto.randomUUID(),
      type,
      title,
      body,
      diff: diff ? JSON.stringify(diff) : undefined,
      safetyBlock,
      status,
    };

    this.onStep(step);
    return step;
  }

  private updateStep(
    id: string,
    type: AgentStep["type"],
    title: string,
    status: StepStatus,
    body?: string,
    diff?: FileDiff,
    safetyBlock?: SafetyBlock
  ): void {
    this.onStep({
      id,
      type,
      title,
      body,
      diff: diff ? JSON.stringify(diff) : undefined,
      safetyBlock,
      status,
    });
  }
}

function formatToolResult(toolName: string, result: AgentToolResult): string {
  if (result.error) {
    return `Error from ${toolName}: ${result.error}`;
  }

  const sections = [result.output];
  if (result.fileDiff) {
    sections.push(JSON.stringify(result.fileDiff));
  }
  if (result.safetyBlock) {
    sections.push(`Safety block: ${result.safetyBlock.peerName} editing ${result.safetyBlock.filePath}`);
  }

  return sections.filter(Boolean).join("\n\n");
}
