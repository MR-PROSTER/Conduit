import { execFile, spawn } from "node:child_process";
import type { ExecFileException, SpawnOptionsWithoutStdio } from "node:child_process";
import { promisify } from "node:util";

import type {
  GitBranchReference,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCommitOptions,
  GitCommitResult,
  GitCreateBranchOptions,
  GitDiffOptions,
  GitRenamedPath,
  GitStashPopResult,
  GitStashResult,
  GitStatus,
  IGitService
} from "./IGitService.js";

const execFileAsync = promisify(execFile);

export type GitServiceErrorCode =
  | "GIT_NOT_INSTALLED"
  | "NOT_A_GIT_REPOSITORY"
  | "REMOTE_NOT_FOUND"
  | "DIRTY_WORKING_TREE"
  | "DETACHED_HEAD"
  | "INVALID_COMMIT"
  | "EMPTY_COMMIT_MESSAGE"
  | "GIT_COMMAND_FAILED";

export class GitServiceError extends Error {
  public override readonly name = "GitServiceError";

  public constructor(
    public readonly code: GitServiceErrorCode,
    message: string,
    public readonly details: {
      readonly command: string;
      readonly args: readonly string[];
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly cause?: unknown;
    }
  ) {
    super(message);
  }
}

export interface GitServiceOptions {
  readonly repoPath: string;
  readonly gitBinaryPath?: string;
  readonly defaultRemoteName?: string;
  readonly maxBufferBytes?: number;
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface ParsedBranchStatus {
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly ahead: number;
  readonly behind: number;
}

export class GitService implements IGitService {
  private readonly gitBinaryPath: string;
  private readonly defaultRemoteName: string;
  private readonly maxBufferBytes: number;
  private repoValidated = false;

  public constructor(private readonly options: GitServiceOptions) {
    this.gitBinaryPath = options.gitBinaryPath ?? "git";
    this.defaultRemoteName = options.defaultRemoteName ?? "origin";
    this.maxBufferBytes = options.maxBufferBytes ?? 4 * 1024 * 1024;
  }

  public async getRepoRemoteUrl(remoteName = this.defaultRemoteName): Promise<string | undefined> {
    // We don't want to fail the entire operation just because the default remote is missing, so we return undefined in that case. Consumers can choose to treat this as an error if the remote is required for their use case.
    await this.ensureRepository();

    try {
      const result = await this.runGit(["remote", "get-url", remoteName]);
      const remoteUrl = result.stdout.trim();
      return remoteUrl.length > 0 ? remoteUrl : undefined;
    } catch (error) {
      if (this.isMissingRemoteError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  public async getCurrentBranch(): Promise<GitCheckoutResult> {
    // We want to allow this operation to succeed even in a detached HEAD state, so we don't enforce repository cleanliness here. Consumers can call isAncestor or getHead if they need to verify the state of the repository.
    await this.ensureRepository();

    const branchResult = await this.runGit(["branch", "--show-current"]);
    const head = await this.getHead();
    const branch = branchResult.stdout.trim() || undefined;

    return {
      branch,
      head,
      detached: branch === undefined
    };
  }

  public async getHead(): Promise<string> {
    await this.ensureRepository();

    const result = await this.runGit(["rev-parse", "HEAD"]);
    const head = result.stdout.trim();
    if (head.length === 0) {
      throw new GitServiceError(
        "INVALID_COMMIT",
        "Git HEAD could not be resolved.",
        {
          command: this.gitBinaryPath,
          args: ["rev-parse", "HEAD"],
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        }
      );
    }

    return head;
  }

  public async isAncestor(ancestor: string, descendant = "HEAD"): Promise<boolean> {
    await this.ensureRepository();

    try {
      await this.runGit(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (
        error instanceof GitServiceError &&
        error.code === "GIT_COMMAND_FAILED" &&
        error.details.exitCode === 1
      ) {
        return false;
      }

      throw error;
    }
  }

  public async getStatus(): Promise<GitStatus> {
    await this.ensureRepository();

    const [statusResult, branchResult, head] = await Promise.all([
      this.runGit(["status", "--porcelain=1", "--untracked-files=all"]),
      this.runGit(["status", "--branch", "--porcelain=1", "--untracked-files=all"]),
      this.getHead()
    ]);

    const statusLines = statusResult.stdout
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const branchStatus = this.parseBranchStatus(branchResult.stdout);

    const staged = new Set<string>();
    const modified = new Set<string>();
    const deleted = new Set<string>();
    const untracked = new Set<string>();
    const conflicted = new Set<string>();
    const renamed: GitRenamedPath[] = [];

    for (const line of statusLines) {
      if (line.startsWith("##")) {
        continue;
      }

      const indexStatus = line.slice(0, 1);
      const worktreeStatus = line.slice(1, 2);
      const payload = line.slice(3);

      if (indexStatus === "?" && worktreeStatus === "?") {
        untracked.add(payload);
        continue;
      }

      if (indexStatus === "R" || worktreeStatus === "R") {
        const [from, to] = payload.split(" -> ");
        if (from && to) {
          renamed.push({ from, to });
          staged.add(to);
        }
        continue;
      }

      if (indexStatus === "U" || worktreeStatus === "U" || `${indexStatus}${worktreeStatus}` === "AA" || `${indexStatus}${worktreeStatus}` === "DD") {
        conflicted.add(payload);
        continue;
      }

      if (indexStatus !== " " && indexStatus !== "?") {
        if (indexStatus === "D") {
          deleted.add(payload);
        } else {
          staged.add(payload);
        }
      }

      if (worktreeStatus !== " ") {
        if (worktreeStatus === "D") {
          deleted.add(payload);
        } else if (worktreeStatus === "M") {
          modified.add(payload);
        }
      }
    }

    const clean =
      staged.size === 0 &&
      modified.size === 0 &&
      deleted.size === 0 &&
      untracked.size === 0 &&
      conflicted.size === 0 &&
      renamed.length === 0;

    return {
      branch: branchStatus.branch,
      head,
      detached: branchStatus.detached,
      clean,
      ahead: branchStatus.ahead,
      behind: branchStatus.behind,
      staged: [...staged],
      modified: [...modified],
      deleted: [...deleted],
      untracked: [...untracked],
      conflicted: [...conflicted],
      renamed
    };
  }

  public async listBranches(includeRemote = false): Promise<readonly GitBranchReference[]> {
    await this.ensureRepository();

    const args = includeRemote
      ? ["branch", "--list", "--all", "--format=%(refname:short)|%(HEAD)"]
      : ["branch", "--list", "--format=%(refname:short)|%(HEAD)"];
    const result = await this.runGit(args);

    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separatorIndex = line.indexOf("|");
        const name =
          separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
        const currentMarker =
          separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
        return {
          name,
          current: currentMarker === "*",
          remote: name.startsWith("remotes/")
        };
      });
  }

  public async checkout(
    target: string,
    options: GitCheckoutOptions = {}
  ): Promise<GitCheckoutResult> {
    await this.ensureRepository();

    if (!options.allowDirty) {
      await this.ensureCleanWorkingTree();
    }

    const args = ["checkout"];
    if (options.force) {
      args.push("--force");
    }
    if (options.create) {
      args.push("-b");
    }
    args.push(target);

    await this.runGit(args);
    return this.getCurrentBranch();
  }

  public async stash(message?: string): Promise<GitStashResult> {
    await this.ensureRepository();

    const status = await this.getStatus();
    if (status.clean) {
      return {
        created: false,
        stashRef: undefined,
        message: "Working tree is already clean."
      };
    }

    const args = ["stash", "push", "--include-untracked"];
    if (message && message.trim().length > 0) {
      args.push("--message", message.trim());
    }

    const before = await this.getTopStashRef();
    const result = await this.runGit(args);
    const after = await this.getTopStashRef();

    return {
      created: after !== before,
      stashRef: after,
      message: result.stdout.trim() || result.stderr.trim() || "Created stash."
    };
  }

  public async stashPop(stashRef = "stash@{0}"): Promise<GitStashPopResult> {
    await this.ensureRepository();

    try {
      const result = await this.runGit(["stash", "pop", stashRef]);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      return {
        applied: true,
        dropped: !output.includes("The stash entry is kept"),
        conflicts: output.includes("CONFLICT"),
        output
      };
    } catch (error) {
      if (
        error instanceof GitServiceError &&
        error.code === "GIT_COMMAND_FAILED"
      ) {
        const output = [error.details.stdout, error.details.stderr].filter(Boolean).join("\n").trim();
        return {
          applied: false,
          dropped: false,
          conflicts: output.includes("CONFLICT"),
          output
        };
      }

      throw error;
    }
  }

  public async commit(
    message: string,
    options: GitCommitOptions = {}
  ): Promise<GitCommitResult> {
    await this.ensureRepository();

    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      throw new GitServiceError(
        "EMPTY_COMMIT_MESSAGE",
        "Commit message cannot be empty.",
        {
          command: this.gitBinaryPath,
          args: ["commit", "--message", message]
        }
      );
    }

    const status = await this.getStatus();
    if (status.clean) {
      throw new GitServiceError(
        "DIRTY_WORKING_TREE",
        "Nothing to commit; the working tree is clean.",
        {
          command: this.gitBinaryPath,
          args: ["commit", "--message", trimmedMessage]
        }
      );
    }

    const args = ["commit", "--message", trimmedMessage];
    if (options.all) {
      args.splice(1, 0, "--all");
    }

    const result = await this.runGit(args);
    const sha = await this.getHead();

    return {
      sha,
      summary: result.stdout.trim() || result.stderr.trim()
    };
  }

  public async diff(options: GitDiffOptions = {}): Promise<string> {
    await this.ensureRepository();

    const args = ["diff"];
    if (options.staged) {
      args.push("--cached");
    }
    if (options.baseRef && options.targetRef) {
      args.push(`${options.baseRef}..${options.targetRef}`);
    } else if (options.baseRef) {
      args.push(options.baseRef);
    }
    if (options.paths && options.paths.length > 0) {
      args.push("--", ...options.paths);
    }

    return this.runGitStreaming(args);
  }

  public async createBranch(
    name: string,
    options: GitCreateBranchOptions = {}
  ): Promise<GitBranchReference> {
    await this.ensureRepository();

    const args = ["branch"];
    if (options.force) {
      args.push("--force");
    }
    args.push(name);
    if (options.startPoint) {
      args.push(options.startPoint);
    }

    await this.runGit(args);

    if (options.checkout) {
      await this.checkout(name, { allowDirty: true });
    }

    return {
      name,
      current: options.checkout === true,
      remote: false
    };
  }

  public async commitCount(fromRef?: string, toRef = "HEAD"): Promise<number> {
    await this.ensureRepository();

    const range = fromRef ? `${fromRef}..${toRef}` : toRef;
    const result = await this.runGit(["rev-list", "--count", range]);
    const count = Number.parseInt(result.stdout.trim(), 10);

    if (Number.isNaN(count)) {
      throw new GitServiceError(
        "GIT_COMMAND_FAILED",
        `Git returned a non-numeric commit count for range ${range}.`,
        {
          command: this.gitBinaryPath,
          args: ["rev-list", "--count", range],
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        }
      );
    }

    return count;
  }

  public async show(ref: string, relativePath: string): Promise<string> {
    await this.ensureRepository();
    try {
      const result = await this.runGit(["show", `${ref}:${relativePath}`]);
      return result.stdout;
    } catch {
      // If the file does not exist at that ref, return an empty string.
      return "";
    }
  }

  private async ensureRepository(): Promise<void> {
    if (this.repoValidated) {
      return;
    }

    try {
      const result = await this.runGit(["rev-parse", "--is-inside-work-tree"], {
        skipRepositoryCheck: true
      });
      if (result.stdout.trim() !== "true") {
        throw new GitServiceError(
          "NOT_A_GIT_REPOSITORY",
          `Path is not a Git repository: ${this.options.repoPath}`,
          {
            command: this.gitBinaryPath,
            args: ["rev-parse", "--is-inside-work-tree"],
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr
          }
        );
      }

      this.repoValidated = true;
    } catch (error) {
      if (error instanceof GitServiceError) {
        throw error;
      }

      throw this.toGitServiceError(error, ["rev-parse", "--is-inside-work-tree"]);
    }
  }

  private async ensureCleanWorkingTree(): Promise<void> {
    const status = await this.getStatus();
    if (status.clean) {
      return;
    }

    throw new GitServiceError(
      "DIRTY_WORKING_TREE",
      "Git operation requires a clean working tree.",
      {
        command: this.gitBinaryPath,
        args: ["status", "--porcelain=1", "--untracked-files=all"],
        stdout: JSON.stringify(status)
      }
    );
  }

  private parseBranchStatus(stdout: string): ParsedBranchStatus {
    const firstLine = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith("##"));
    if (!firstLine) {
      return {
        branch: undefined,
        detached: true,
        ahead: 0,
        behind: 0
      };
    }

    const header = firstLine.slice(2).trim();
    const [branchPart, trackingPart] = header.split("...");
    const branchName = branchPart === "HEAD (no branch)" ? undefined : branchPart;
    const detached = branchName === undefined;

    let ahead = 0;
    let behind = 0;
    if (trackingPart) {
      const aheadMatch = trackingPart.match(/ahead (\d+)/u);
      const behindMatch = trackingPart.match(/behind (\d+)/u);
      ahead = Number.parseInt(aheadMatch?.[1] ?? "0", 10);
      behind = Number.parseInt(behindMatch?.[1] ?? "0", 10);
    }

    return {
      branch: branchName,
      detached,
      ahead,
      behind
    };
  }

  private async getTopStashRef(): Promise<string | undefined> {
    try {
      const result = await this.runGit(["stash", "list", "--format=%gd"]);
      const firstLine = result.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0);
      return firstLine?.trim();
    } catch {
      return undefined;
    }
  }

  private async runGit(
    args: readonly string[],
    options: { readonly skipRepositoryCheck?: boolean } = {}
  ): Promise<GitCommandResult> {
    try {
      const result = await execFileAsync(this.gitBinaryPath, [...args], {
        cwd: this.options.repoPath,
        maxBuffer: this.maxBufferBytes
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0
      };
    } catch (error) {
      throw this.toGitServiceError(error, args, options.skipRepositoryCheck === true);
    }
  }

  private runGitStreaming(args: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const spawnOptions: SpawnOptionsWithoutStdio = {
        cwd: this.options.repoPath
      };
      const child = spawn(this.gitBinaryPath, [...args], spawnOptions);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", (error: unknown) => {
        reject(this.toGitServiceError(error, args));
      });
      child.on("close", (code: number | null) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code === 0) {
          resolve(stdout);
          return;
        }

        reject(
          new GitServiceError(
            "GIT_COMMAND_FAILED",
            `Git command failed: ${this.formatCommand(args)}`,
            this.buildErrorDetails(args, {
              ...(code === null ? {} : { exitCode: code }),
              stdout,
              stderr
            })
          )
        );
      });
    });
  }

  private isMissingRemoteError(error: unknown): boolean {
    return (
      error instanceof GitServiceError &&
      error.code === "REMOTE_NOT_FOUND"
    );
  }

  private toGitServiceError(
    error: unknown,
    args: readonly string[],
    skipRepositoryCheck = false
  ): GitServiceError {
    if (error instanceof GitServiceError) {
      return error;
    }

    const execError = error as ExecFileException & {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: string | number;
    };
    const stderr = execError.stderr ?? "";
    const stdout = execError.stdout ?? "";
    const exitCode =
      typeof execError.code === "number" ? execError.code : undefined;

    if (execError.code === "ENOENT") {
      return new GitServiceError(
        "GIT_NOT_INSTALLED",
        `Git binary not found: ${this.gitBinaryPath}`,
        {
          command: this.gitBinaryPath,
          args,
          cause: error
        }
      );
    }

    if (!skipRepositoryCheck && /not a git repository/i.test(stderr)) {
      return new GitServiceError(
        "NOT_A_GIT_REPOSITORY",
        `Path is not a Git repository: ${this.options.repoPath}`,
        this.buildErrorDetails(args, {
          stdout,
          stderr,
          ...(exitCode === undefined ? {} : { exitCode }),
          cause: error
        })
      );
    }

    if (/No such remote/i.test(stderr) || /No such remote/i.test(stdout)) {
      return new GitServiceError(
        "REMOTE_NOT_FOUND",
        `Git remote does not exist.`,
        this.buildErrorDetails(args, {
          stdout,
          stderr,
          ...(exitCode === undefined ? {} : { exitCode }),
          cause: error
        })
      );
    }

    return new GitServiceError(
      "GIT_COMMAND_FAILED",
      `Git command failed: ${this.formatCommand(args)}`,
      this.buildErrorDetails(args, {
        stdout,
        stderr,
        ...(exitCode === undefined ? {} : { exitCode }),
        cause: error
      })
    );
  }

  private formatCommand(args: readonly string[]): string {
    return [this.gitBinaryPath, ...args].join(" ");
  }

  private buildErrorDetails(
    args: readonly string[],
    details: {
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly cause?: unknown;
    } = {}
  ): {
    readonly command: string;
    readonly args: readonly string[];
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly cause?: unknown;
  } {
    return {
      command: this.gitBinaryPath,
      args,
      ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
      ...(details.stdout === undefined ? {} : { stdout: details.stdout }),
      ...(details.stderr === undefined ? {} : { stderr: details.stderr }),
      ...(details.cause === undefined ? {} : { cause: details.cause })
    };
  }
}
