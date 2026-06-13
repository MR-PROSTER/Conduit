export interface ChatThread {
  id: string;
  sessionId?: string;
  type: "group" | "private-fork" | "public-fork" | "standalone";
  name?: string;
  forkedFromMessageId?: string;
  createdBy: string;
  createdAt: string;
}
