/**
 * Represents a branch-scoped collaborative session for a room.
 */
export interface Session {
  /** Stable unique identifier for the session. */
  readonly id: string;
  /** Identifier of the room that owns the session. */
  readonly roomId: string;
  /** Git branch associated with the session. */
  readonly branch: string;
  /** Base commit hash used to anchor collaboration state. */
  readonly baseCommitHash: string;
  /** User identifiers currently associated with the session. */
  readonly participants: readonly string[];
  /** Current lifecycle state of the session. */
  readonly status: "active" | "saved" | "discarded";
}
