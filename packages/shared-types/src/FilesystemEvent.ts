export interface FileCreateEvent {
  type: "FILE_CREATE";
  path: string;
  content: string;
}

export interface FileDeleteEvent {
  type: "FILE_DELETE";
  path: string;
}

export interface FileRenameEvent {
  type: "FILE_RENAME";
  oldPath: string;
  newPath: string;
}

export interface FileMoveEvent {
  type: "FILE_MOVE";
  oldPath: string;
  newPath: string;
}

export type FilesystemEvent = FileCreateEvent | FileDeleteEvent | FileRenameEvent | FileMoveEvent;
