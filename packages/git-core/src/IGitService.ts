import type { Room, Session } from "../../shared-types/src/index.js";

export interface GitBranchReference {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitRenamedPath {
  from: string;
  to: string;
}

export interface GitStatus {
  branch: string;
  head: string;
  detached: boolean;
  clean: boolean;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  deleted: number;
  untracked: number;
  conflicted: number;
  renamed: number;
}

export interface GitCheckoutOptions {
  create?: boolean;
  force?: boolean;
  allowDirty?: boolean;
}

export interface GitCreateBranchOptions {
  startPoint?: string;
  checkout?: boolean;
  force?: boolean;
}

export interface GitCommitOptions {
  all?: boolean;
}

export interface GitDiffOptions {
  baseRef?: string;
  targetRef?: string;
  staged?: boolean;
  paths?: readonly string[];
}

export interface GitCommitResult {
  sha: string;
  summary: string;
}

export interface GitCheckoutResult {
  branch: string;
  head: string;
  detached: boolean;
}

export interface GitStashResult {
  created: boolean;
  stashRef: string;
  message: string;
}

export interface GitStashPopResult {
  applied: boolean;
  dropped: boolean;
  conflicts: readonly string[];
  output: string;
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

export type { Room, Session };
