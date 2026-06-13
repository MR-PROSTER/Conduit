/**
 * Represents a collaborative filesystem operation recorded for a draft.
 */
export type FilesystemEvent =
  | {
      /** Creates a file with initial contents. */
      readonly type: "FILE_CREATE";
      /** Repository-relative file path. */
      readonly path: string;
      /** Full file contents after creation. */
      readonly content: string;
    }
  | {
      /** Deletes a file from the working tree. */
      readonly type: "FILE_DELETE";
      /** Repository-relative file path. */
      readonly path: string;
    }
  | {
      /** Renames a file within the repository. */
      readonly type: "FILE_RENAME";
      /** Previous repository-relative file path. */
      readonly oldPath: string;
      /** New repository-relative file path. */
      readonly newPath: string;
    }
  | {
      /** Moves a file to a new repository-relative path. */
      readonly type: "FILE_MOVE";
      /** Previous repository-relative file path. */
      readonly oldPath: string;
      /** New repository-relative file path. */
      readonly newPath: string;
    };
