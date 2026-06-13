export interface Session {
  id: string;
  roomId: string;
  branch: string;
  baseCommitHash: string;
  participants: readonly string[];
  status: "active" | "saved" | "discarded";
}
