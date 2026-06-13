import * as crypto from "crypto";

export function buildRoomKey(roomId: string, branch: string, sessionId: string): string {
  return `${roomId}:${branch}:${sessionId}`;
}

export function buildBranchKey(roomId: string, branch: string): string {
  return `${roomId}:${branch}`;
}

export function createSessionId(): string {
  return crypto.randomUUID();
}
