/**
 * Represents a chat thread in the Conduit AI panel.
 * A thread is scoped to a session (group chat) or standalone (private).
 */
export interface ChatThread {
  readonly id: string;
  /** undefined = standalone private (not tied to a session) */
  readonly sessionId: string | undefined;
  readonly type: 'group' | 'private-fork' | 'public-fork' | 'standalone';
  /** only set for public forks */
  readonly name: string | undefined;
  /** The message id this thread was forked from */
  readonly forkedFromMessageId: string | undefined;
  readonly createdBy: string;
  readonly createdAt: string;
}
