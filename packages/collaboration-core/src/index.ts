import type { Room, Session } from "@conduit/shared-types";
export type { Draft, FilesystemEvent, Room, Session } from "@conduit/shared-types";
export { CursorManager } from "./CursorManager.js";
export type {
  CursorManagerDeps,
  CursorPosition,
  DecorationTypeLike,
  EditorDecorationTarget,
  CursorState,
  RangeLike,
} from "./CursorManager.js";
export { DraftManager } from "./DraftManager.js";
export type {
  DraftConflictResult,
  DraftFreshnessResult,
  DraftManagerOptions,
} from "./DraftManager.js";
export { FileManager } from "./FileManager.js";
export type {
  DisposableLike,
  TextDocumentLike,
  TextEditorEditLike,
  TextEditorLike,
  TextRangeLike,
} from "./FileManager.js";

export interface CollaborationSession {
  room: Room;
  session: Session;
  documentKey: string;
  websocketUrl: string;
}

export function getSessionDocumentKey(room: Room, session: Session): string {
  return `${room.id}:${session.branch}:${session.id}`;
}
