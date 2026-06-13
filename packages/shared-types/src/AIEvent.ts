export interface AIEvent {
  id: string;
  sessionId: string;
  userId: string;
  model: string;
  prompt: string;
  diff: string;
  filesTouched: readonly string[];
  accepted: boolean;
  timestamp: string;
}
