import type { FilesystemEvent } from "./FilesystemEvent.js";

export interface Draft {
  id: string;
  sessionId: string;
  roomId: string;
  branch: string;
  baseCommitHash: string;
  yjsState: string;
  filesystemOps: readonly FilesystemEvent[];
  aiEvents: readonly string[];
  createdBy: string;
  createdAt: string;
  status: "active" | "applied" | "discarded";
  lineage?: string;
}
