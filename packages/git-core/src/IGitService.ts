export interface GitBranchReference {
  readonly name: string;
  readonly current: boolean;
  readonly remote: boolean;
}

export interface GitRenamedPath {
  readonly from: string;
  readonly to: string;
}

export interface GitStatus {
  readonly branch: string | undefined;
  readonly head: string;
  readonly detached: boolean;
  readonly clean: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly untracked: readonly string[];
  readonly conflicted: readonly string[];
  readonly renamed: readonly GitRenamedPath[];
}

export interface GitCheckoutOptions {
  readonly create?: boolean;
  readonly force?: boolean;
  readonly allowDirty?: boolean;
}

export interface GitCreateBranchOptions {
  readonly startPoint?: string;
  readonly checkout?: boolean;
  readonly force?: boolean;
}

export interface GitCommitOptions {
  readonly all?: boolean;
}

export interface GitDiffOptions {
  readonly baseRef?: string;
  readonly targetRef?: string;
  readonly staged?: boolean;
  readonly paths?: readonly string[];
}

export interface GitCommitResult {
  readonly sha: string;
  readonly summary: string;
}

export interface GitCheckoutResult {
  readonly branch: string | undefined;
  readonly head: string;
  readonly detached: boolean;
}

export interface GitStashResult {
  readonly created: boolean;
  readonly stashRef: string | undefined;
  readonly message: string;
}

export interface GitStashPopResult {
  readonly applied: boolean;
  readonly dropped: boolean;
  readonly conflicts: boolean;
  readonly output: string;
}

export interface IGitService {
  getRepoRemoteUrl(remoteName?: string): Promise<string | undefined>;
  getCurrentBranch(): Promise<GitCheckoutResult>;
  getHead(): Promise<string>;
  isAncestor(ancestor: string, descendant?: string): Promise<boolean>;
  getStatus(): Promise<GitStatus>;
  listBranches(includeRemote?: boolean): Promise<readonly GitBranchReference[]>;
  checkout(target: string, options?: GitCheckoutOptions): Promise<GitCheckoutResult>;
  stash(message?: string): Promise<GitStashResult>;
  stashPop(stashRef?: string): Promise<GitStashPopResult>;
  commit(message: string, options?: GitCommitOptions): Promise<GitCommitResult>;
  diff(options?: GitDiffOptions): Promise<string>;
  createBranch(name: string, options?: GitCreateBranchOptions): Promise<GitBranchReference>;
  commitCount(fromRef?: string, toRef?: string): Promise<number>;
  show(ref: string, relativePath: string): Promise<string>;
}
