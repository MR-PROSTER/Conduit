import type { Room, Session } from "@conduit/shared-types";

export type {
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
export { GitService, GitServiceError } from "./GitService.js";
export type { GitServiceErrorCode, GitServiceOptions } from "./GitService.js";

export interface GitValidationTarget {
  readonly room: Room;
  readonly branchName: string;
  readonly expectedAncestorSha: string;
}

export const getRepositorySlug = (room: Room): string => {
  return `${room.name}:${room.defaultBranch}`;
};

export const getSessionBaseCommitHash = (session: Session): string => {
  return session.baseCommitHash;
};
