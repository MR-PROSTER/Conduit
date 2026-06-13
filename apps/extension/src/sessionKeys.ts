import * as crypto from "node:crypto";

export const buildRoomKey = (
  roomId: string,
  branch: string,
  sessionId: string
): string => {
  return `${roomId}:${branch}:${sessionId}`;
};

export const buildBranchKey = (roomId: string, branch: string): string => {
  return `${roomId}:${branch}`;
};

export const createSessionId = (): string => {
  return crypto.randomUUID();
};
