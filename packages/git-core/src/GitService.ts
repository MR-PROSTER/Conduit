import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitBranchReference,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCommitOptions,
  GitCommitResult,
  GitCreateBranchOptions,
  GitDiffOptions,
  GitStatus,
  GitStashPopResult,
  GitStashResult,
  IGitService
} from "./IGitService.js";

const execFileAsync = promisify(execFile);

export type GitServiceErrorCode =
  | "NOT_A_GIT_REPO"
  | "BRANCH_NOT_FOUND"
  | "DIRTY_WORKING_TREE"
  | "MERGE_CONFLICT"
  | "COMMAND_FAILED";

export class GitServiceError extends Error {
  readonly code: GitServiceErrorCode;
  readonly workspaceRoot: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;

  constructor(
    code: GitServiceErrorCode,
    workspaceRoot: string,
    message?: string,
    details: { stdout?: string; stderr?: string; exitCode?: number } = {}
  ) {
    super(message ?? `Git command failed in ${workspaceRoot}`);
    this.name = "GitServiceError";
    this.code = code;
    this.workspaceRoot = workspaceRoot;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode;
  }
}

type ExecResult = {
  stdout: string;
  stderr: string;
};

export class GitService implements IGitService {
  constructor(private readonly workspaceRoot: string) {}

  async getRepoRemoteUrl(remoteName = "origin"): Promise<string | undefined> {
    try {
      const { stdout } = await this.execGit(["remote", "get-url", remoteName]);
      const url = stdout.trim();
      return url.length > 0 ? url : undefined;
    } catch (error) {
      if (this.isMissingRemoteError(error)) {
        return undefined;
      }
      throw this.normalizeError(error);
    }
  }

  async getCurrentBranch(): Promise<GitCheckoutResult> {
    const [branchOutput, head] = await Promise.all([
      this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      this.getHead()
    ]);
    const branch = branchOutput.stdout.trim();
    const detached = branch === "HEAD";
    return {
      branch,
      head,
      detached
    };
  }

  async getHead(): Promise<string> {
    const { stdout } = await this.execGit(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async isAncestor(ancestor: string, descendant = "HEAD"): Promise<boolean> {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd: this.workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      return true;
    } catch (error) {
      if (this.getErrorStatus(error) === 1) {
        return false;
      }
      throw this.normalizeError(error);
    }
  }

  async getStatus(): Promise<GitStatus> {
    const [statusResult, head] = await Promise.all([
      this.execGit(["status", "--porcelain=v2", "-b", "--untracked-files=all"]),
      this.getHead()
    ]);

    const status = this.parseStatus(statusResult.stdout, head);
    return status;
  }

  async listBranches(includeRemote = false): Promise<readonly GitBranchReference[]> {
    const [local, remote] = await Promise.all([
      this.execGit(["branch", "--format=%(refname:short)\t%(HEAD)"]),
      includeRemote
        ? this.execGit(["branch", "-r", "--format=%(refname:short)\t%(HEAD)"])
        : Promise.resolve({ stdout: "", stderr: "" })
    ]);

    const branches: GitBranchReference[] = [];
    branches.push(...this.parseBranches(local.stdout, false));
    if (includeRemote) {
      branches.push(...this.parseBranches(remote.stdout, true));
    }
    return branches;
  }

  async checkout(target: string, options: GitCheckoutOptions = {}): Promise<GitCheckoutResult> {
    const { create = false, force = false, allowDirty = false } = options;

    if (!force && !allowDirty) {
      const status = await this.getStatus();
      if (!status.clean) {
        throw new GitServiceError(
          "DIRTY_WORKING_TREE",
          this.workspaceRoot,
          "Working tree has uncommitted changes"
        );
      }
    }

    const args = ["checkout"];
    if (force) {
      args.push("-f");
    }
    if (create) {
      args.push(force ? "-B" : "-b", target);
    } else {
      args.push(target);
    }

    await this.execGit(args);
    return this.getCurrentBranch();
  }

  async stash(message?: string): Promise<GitStashResult> {
    const args = ["stash", "push"];
    if (message) {
      args.push("-m", message);
    }

    const result = await this.execGit(args);
    const output = `${result.stdout}${result.stderr}`.trim();
    const created = !/no local changes to save/i.test(output) && !/nothing to stash/i.test(output);

    return {
      created,
      stashRef: created ? "stash@{0}" : "",
      message: message ?? ""
    };
  }

  async stashPop(stashRef = "stash@{0}"): Promise<GitStashPopResult> {
    try {
      const result = await this.execGit(["stash", "pop", stashRef]);
      const output = `${result.stdout}${result.stderr}`.trim();
      return {
        applied: true,
        dropped: true,
        conflicts: [],
        output
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      const output = `${normalized.stdout}${normalized.stderr}`.trim();
      if (normalized.code === "MERGE_CONFLICT") {
        return {
          applied: true,
          dropped: false,
          conflicts: this.parseConflicts(output),
          output
        };
      }
      throw normalized;
    }
  }

  async commit(message: string, options: GitCommitOptions = {}): Promise<GitCommitResult> {
    const args = ["commit", "-m", message];
    if (options.all) {
      args.splice(1, 0, "-a");
    }

    const { stdout } = await this.execGit(args);
    const sha = this.extractCommitSha(stdout);
    const summary = this.extractCommitSummary(stdout);
    return { sha, summary };
  }

  async diff(options: GitDiffOptions = {}): Promise<string> {
    const args = ["diff"];
    if (options.staged) {
      args.push("--cached");
    }
    if (options.baseRef && options.targetRef) {
      args.push(`${options.baseRef}..${options.targetRef}`);
    } else if (options.baseRef) {
      args.push(`${options.baseRef}..HEAD`);
    } else if (options.targetRef) {
      args.push(options.targetRef);
    }
    if (options.paths?.length) {
      args.push("--", ...options.paths);
    }

    const { stdout } = await this.execGit(args);
    return stdout;
  }

  async createBranch(name: string, options: GitCreateBranchOptions = {}): Promise<GitBranchReference> {
    const { startPoint = "HEAD", checkout = true, force = false } = options;
    const args = checkout ? ["checkout", force ? "-B" : "-b", name, startPoint] : ["branch"];

    if (!checkout) {
      if (force) {
        args.push("-f");
      }
      args.push(name, startPoint);
    }

    await this.execGit(args);
    const current = checkout ? (await this.getCurrentBranch()).branch === name : false;
    return {
      name,
      current,
      remote: false
    };
  }

  async commitCount(fromRef?: string, toRef?: string): Promise<number> {
    const args = ["rev-list", "--count"];
    if (fromRef && toRef) {
      args.push(`${fromRef}..${toRef}`);
    } else if (fromRef) {
      args.push(`${fromRef}..HEAD`);
    } else if (toRef) {
      args.push(toRef);
    } else {
      args.push("HEAD");
    }

    const { stdout } = await this.execGit(args);
    return Number.parseInt(stdout.trim(), 10);
  }

  async show(ref: string, relativePath: string): Promise<string> {
    const { stdout } = await this.execGit(["show", `${ref}:${relativePath}`]);
    return stdout;
  }

  private async execGit(args: string[]): Promise<ExecResult> {
    try {
      const result = (await execFileAsync("git", args, {
        cwd: this.workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      })) as ExecResult;
      return result;
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): GitServiceError {
    if (error instanceof GitServiceError) {
      return error;
    }

    const stdout = this.getErrorOutput(error, "stdout");
    const stderr = this.getErrorOutput(error, "stderr");
    const exitCode = this.getErrorStatus(error);
    const message = `${stderr || stdout || (error instanceof Error ? error.message : "Git command failed")}`.trim();

    if (this.isNotGitRepo(stderr, stdout)) {
      return new GitServiceError("NOT_A_GIT_REPO", this.workspaceRoot, message, {
        stdout,
        stderr,
        exitCode
      });
    }
    if (this.isDirtyWorkingTree(stderr, stdout)) {
      return new GitServiceError("DIRTY_WORKING_TREE", this.workspaceRoot, message, {
        stdout,
        stderr,
        exitCode
      });
    }
    if (this.isMergeConflict(stderr, stdout)) {
      return new GitServiceError("MERGE_CONFLICT", this.workspaceRoot, message, {
        stdout,
        stderr,
        exitCode
      });
    }
    if (this.isBranchNotFound(stderr, stdout)) {
      return new GitServiceError("BRANCH_NOT_FOUND", this.workspaceRoot, message, {
        stdout,
        stderr,
        exitCode
      });
    }

    return new GitServiceError("COMMAND_FAILED", this.workspaceRoot, message, {
      stdout,
      stderr,
      exitCode
    });
  }

  private isMissingRemoteError(error: unknown): boolean {
    const stdout = this.getErrorOutput(error, "stdout");
    const stderr = this.getErrorOutput(error, "stderr");
    return /unknown remote|no such remote/i.test(`${stdout}\n${stderr}`);
  }

  private isNotGitRepo(stderr: string, stdout: string): boolean {
    return /not a git repository/i.test(`${stderr}\n${stdout}`);
  }

  private isDirtyWorkingTree(stderr: string, stdout: string): boolean {
    return /would be overwritten by checkout|local changes to the following files would be overwritten|please commit your changes or stash them before you switch branches/i.test(
      `${stderr}\n${stdout}`
    );
  }

  private isMergeConflict(stderr: string, stdout: string): boolean {
    return /CONFLICT \(|merge conflict|conflicts in/i.test(`${stderr}\n${stdout}`);
  }

  private isBranchNotFound(stderr: string, stdout: string): boolean {
    return /did not match any file\(s\) known to git|unknown revision|ambiguous argument|branch .* not found|couldn't find remote ref/i.test(
      `${stderr}\n${stdout}`
    );
  }

  private parseStatus(output: string, head: string): GitStatus {
    const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
    const branchLine = lines.find((line) => line.startsWith("# branch.head ")) ?? "# branch.head detached";
    const branch = branchLine.slice("# branch.head ".length).trim();
    const detached = branch === "detached";

    const aheadBehindLine = lines.find((line) => line.startsWith("# branch.ab "));
    let ahead = 0;
    let behind = 0;
    if (aheadBehindLine) {
      const match = aheadBehindLine.match(/# branch\.ab \+(\d+) -(\d+)/);
      if (match) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
    }

    const entries = lines.filter((line) => !line.startsWith("#"));
    const staged = entries.filter((line) => this.getStatusCode(line).staged).length;
    const modified = entries.filter((line) => this.getStatusCode(line).modified).length;
    const deleted = entries.filter((line) => this.getStatusCode(line).deleted).length;
    const untracked = entries.filter((line) => line.startsWith("? ")).length;
    const conflicted = entries.filter((line) => line.startsWith("u ")).length;
    const renamed = entries.filter((line) => line.startsWith("2 ")).length;
    const clean = entries.length === 0;

    return {
      branch,
      head,
      detached,
      clean,
      ahead,
      behind,
      staged,
      modified,
      deleted,
      untracked,
      conflicted,
      renamed
    };
  }

  private getStatusCode(line: string): { staged: boolean; modified: boolean; deleted: boolean } {
    if (line.startsWith("1 ")) {
      const code = line.slice(2, 4);
      return {
        staged: code[0] !== ".",
        modified: code[1] !== ".",
        deleted: code[0] === "D" || code[1] === "D"
      };
    }
    if (line.startsWith("2 ")) {
      const code = line.slice(2, 4);
      return {
        staged: code[0] !== ".",
        modified: code[1] !== ".",
        deleted: code[0] === "D" || code[1] === "D"
      };
    }
    if (line.startsWith("u ")) {
      return {
        staged: true,
        modified: true,
        deleted: false
      };
    }
    return {
      staged: false,
      modified: false,
      deleted: false
    };
  }

  private parseBranches(output: string, remote: boolean): GitBranchReference[] {
    return output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .filter((line) => !line.includes("->"))
      .map((line) => {
        const [name, marker = " "] = line.split("\t");
        return {
          name,
          current: marker.trim() === "*",
          remote
        };
      });
  }

  private parseConflicts(output: string): string[] {
    const conflicts = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/CONFLICT \([^)]*\): Merge conflict in (.+)$/);
      if (match) {
        conflicts.add(match[1].trim());
      }
    }
    return [...conflicts];
  }

  private extractCommitSha(stdout: string): string {
    const match = stdout.match(/\[.* ([0-9a-f]{7,40})\]/i) ?? stdout.match(/([0-9a-f]{7,40})/i);
    return match?.[1] ?? "";
  }

  private extractCommitSummary(stdout: string): string {
    const summaryMatch = stdout.match(/\[\S+ [0-9a-f]{7,40}\] (.+)$/im);
    return summaryMatch?.[1]?.trim() ?? stdout.trim();
  }

  private getErrorOutput(error: unknown, key: "stdout" | "stderr"): string {
    if (typeof error === "object" && error !== null && key in error) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") {
        return value;
      }
    }
    return "";
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (typeof error === "object" && error !== null && "code" in error) {
      const value = (error as Record<string, unknown>).code;
      if (typeof value === "number") {
        return value;
      }
    }
    return undefined;
  }
}
