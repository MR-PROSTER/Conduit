import type { FilesystemEvent } from "./FilesystemEvent.js";

/**
 * Represents a collaborative draft overlay attached to a session.
 */
export interface Draft {
  /** Stable unique identifier for the draft. */
  readonly id: string;
  /** Identifier of the session that owns the draft. */
  readonly sessionId: string;
  /** Identifier of the room that owns the draft. */
  readonly roomId: string;
  /** Git branch targeted by the draft. */
  readonly branch: string;
  /** Base commit hash used when the draft was created. */
  readonly baseCommitHash: string;
  /** Serialized Yjs document state for the draft. */
  readonly yjsState: string;
  /** Ordered collaborative filesystem operations for the draft. */
  readonly filesystemOps: readonly FilesystemEvent[];
  /** Identifiers of AI events associated with the draft. */
  readonly aiEvents: readonly string[];
  /** User identifier for the draft creator. */
  readonly createdBy: string;
  /** ISO-8601 timestamp for draft creation. */
  readonly createdAt: string;
  /** Current lifecycle state of the draft. */
  readonly status: "active" | "applied" | "discarded";
  /** Optional lineage reference to a parent draft or source revision. */
  readonly lineage?: string;
}
