import type { Room, Session } from "@conduit/shared-types";

export {
  DraftManager,
  type DraftCompareResult,
  type DraftConflictResult,
  type DraftFreshnessResult,
  type DraftMetadata,
  type DraftRestoreOptions,
  type DraftRestoreResult,
  type DraftRestoreStrategy,
  type DraftRestoreSuccessResult,
  type DraftSaveOptions
} from "./DraftManager.js";

export interface CollaborationSession {
  readonly room: Room;
  readonly session: Session;
  readonly documentKey: string;
  readonly websocketUrl: string;
}

export const getSessionDocumentKey = (room: Room, session: Session): string => {
  return `${room.id}:${session.branch}:${session.id}`;
};
