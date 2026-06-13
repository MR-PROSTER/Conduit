import type { Room, Session } from "../../shared-types/src/index.js";

export type {
  GitBranchReference,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCommitOptions,
  GitCommitResult,
  GitCreateBranchOptions,
  GitDiffOptions,
  GitRenamedPath,
  GitStatus,
  GitStashPopResult,
  GitStashResult,
  IGitService,
} from "./IGitService.js";
export type { GitServiceErrorCode } from "./GitService.js";
export { GitService, GitServiceError } from "./GitService.js";
export type { Room, Session };

export function getRepositorySlug(room: Room): string {
  return `${room.name}:${room.defaultBranch}`;
}

export function getSessionBaseCommitHash(session: Session): string {
  return session.baseCommitHash;
}
