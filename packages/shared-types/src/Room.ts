/**
 * Represents a collaborative room bound to a Git repository.
 */
export interface Room {
  /** Stable unique identifier for the room. */
  readonly id: string;
  /** Human-readable room name. */
  readonly name: string;
  /** Canonical repository URL associated with the room. */
  readonly repoUrl: string;
  /** Default branch used when creating sessions. */
  readonly defaultBranch: string;
  /** User identifier for the room owner. */
  readonly ownerId: string;
}
