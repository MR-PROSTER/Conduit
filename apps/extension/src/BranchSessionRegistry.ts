import * as vscode from "vscode";

import type { Draft, Room, Session } from "@conduit/shared-types";

import { buildBranchKey, buildRoomKey } from "./sessionKeys.js";

const REGISTRY_STORAGE_KEY = "conduit.branchSessionRegistry";

export interface DraftSummary {
  readonly id: string;
  readonly branch: string;
  readonly status: Draft["status"];
  readonly sessionId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly workspacePath: string;
}

export interface BranchSessionRecord {
  readonly room: Room;
  readonly session: Session;
  readonly websocketUrl: string;
  readonly roomKey: string;
  readonly branchKey: string;
  readonly lastSeenAt: string;
  readonly active: boolean;
  readonly source: "local" | "remote";
  readonly participantCount: number;
  readonly hasSavedDraft: boolean;
  readonly draftPath: string | undefined;
}

interface StoredBranchSessionRecord extends BranchSessionRecord {}

interface BackendSessionRecord {
  readonly roomId: string;
  readonly roomName?: string;
  readonly repoUrl?: string;
  readonly ownerEmail?: string;
  readonly ownerUsername?: string;
  readonly ownerId?: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly roomKey: string;
  readonly connectionCount: number;
  readonly lastTouchedAt: string;
}

export class BranchSessionRegistry {
  private readonly sessions = new Map<string, BranchSessionRecord>();
  private readonly draftsBySessionId = new Map<string, DraftSummary>();

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.restore();
  }

  public upsertSession(
    input: {
      readonly room: Room;
      readonly session: Session;
      readonly websocketUrl: string;
    },
    options: {
      readonly active?: boolean;
      readonly source?: "local" | "remote";
      readonly participantCount?: number;
      readonly lastSeenAt?: string;
    } = {}
  ): BranchSessionRecord {
    const roomKey = buildRoomKey(
      input.room.id,
      input.session.branch,
      input.session.id
    );
    const branchKey = buildBranchKey(input.room.id, input.session.branch);
    const existing = this.sessions.get(roomKey);
    const draft = this.draftsBySessionId.get(input.session.id);
    const isActive = options.active ?? existing?.active ?? false;

    if (isActive) {
      this.clearBranchActivity(branchKey, roomKey);
    }

    const nextRecord: BranchSessionRecord = {
      room: {
        ...input.room,
        defaultBranch: input.session.branch
      },
      session: input.session,
      websocketUrl: input.websocketUrl,
      roomKey,
      branchKey,
      lastSeenAt: options.lastSeenAt ?? new Date().toISOString(),
      active: isActive,
      source: options.source ?? existing?.source ?? "local",
      participantCount:
        options.participantCount ??
        input.session.participants.length ??
        existing?.participantCount ??
        0,
      hasSavedDraft: draft !== undefined,
      draftPath: draft?.workspacePath
    };

    this.sessions.set(roomKey, nextRecord);
    this.persist();
    return nextRecord;
  }

  public markSessionInactive(roomKey: string): void {
    const existing = this.sessions.get(roomKey);
    if (!existing || !existing.active) {
      return;
    }

    this.sessions.set(roomKey, {
      ...existing,
      active: false,
      lastSeenAt: new Date().toISOString()
    });
    this.persist();
  }

  public syncDrafts(drafts: readonly DraftSummary[]): void {
    this.draftsBySessionId.clear();
    for (const draft of drafts) {
      this.draftsBySessionId.set(draft.sessionId, draft);
    }

    for (const [roomKey, session] of this.sessions) {
      const draft = this.draftsBySessionId.get(session.session.id);
      this.sessions.set(roomKey, {
        ...session,
        hasSavedDraft: draft !== undefined,
        draftPath: draft?.workspacePath
      });
    }

    this.persist();
  }

  public upsertDraft(draft: DraftSummary): void {
    this.draftsBySessionId.set(draft.sessionId, draft);

    for (const [roomKey, session] of this.sessions) {
      if (session.session.id !== draft.sessionId) {
        continue;
      }

      this.sessions.set(roomKey, {
        ...session,
        hasSavedDraft: true,
        draftPath: draft.workspacePath
      });
    }

    this.persist();
  }

  public getSession(
    roomId: string,
    sessionId: string
  ): BranchSessionRecord | undefined {
    return [...this.sessions.values()].find((entry) => {
      return entry.room.id === roomId && entry.session.id === sessionId;
    });
  }

  public getPreferredSession(
    roomId: string,
    branch: string
  ): BranchSessionRecord | undefined {
    const branchKey = buildBranchKey(roomId, branch);
    return this.listSessions().find((entry) => entry.branchKey === branchKey);
  }

  public getRestorableSession(branch: string): BranchSessionRecord | undefined {
    return this.listSessions().find((entry) => {
      return (
        entry.session.branch === branch && entry.session.status !== "discarded"
      );
    });
  }

  public listSessions(): readonly BranchSessionRecord[] {
    return [...this.sessions.values()].sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }

      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });
  }

  public async discoverSessions(
    websocketUrl: string,
    roomHint?: Room,
    accessToken?: string
  ): Promise<readonly BranchSessionRecord[]> {
    try {
      const headers: Record<string, string> = {};
      if (accessToken) {
        headers["Authorization"] = `Bearer ${accessToken}`;
      }
      const response = await fetch(this.getSessionsEndpoint(websocketUrl), {
        headers
      });
      if (!response.ok) {
        return this.listSessions();
      }

      const payload = (await response.json()) as {
        readonly rooms?: readonly BackendSessionRecord[];
      };
      for (const discoveredSession of payload.rooms ?? []) {
        const existing = this.sessions.get(discoveredSession.roomKey);
        const room = {
          id: discoveredSession.roomId,
          name: discoveredSession.roomName || existing?.room.name || roomHint?.name || discoveredSession.roomId,
          repoUrl: discoveredSession.repoUrl || existing?.room.repoUrl || roomHint?.repoUrl || "",
          defaultBranch: discoveredSession.branch,
          ownerId: discoveredSession.ownerId || existing?.room.ownerId || roomHint?.ownerId || "unknown"
        } satisfies Room;
        (room as any).ownerEmail = discoveredSession.ownerEmail || (existing?.room as any)?.ownerEmail || "unknown";
        (room as any).ownerUsername = discoveredSession.ownerUsername || (existing?.room as any)?.ownerUsername || undefined;
        const session =
          existing?.session ??
          ({
            id: discoveredSession.sessionId,
            roomId: discoveredSession.roomId,
            branch: discoveredSession.branch,
            baseCommitHash: "HEAD",
            participants: [],
            status: "active"
          } satisfies Session);

        this.upsertSession(
          {
            room,
            session,
            websocketUrl
          },
          {
            active: discoveredSession.connectionCount > 0,
            source: "remote",
            participantCount: discoveredSession.connectionCount,
            lastSeenAt: discoveredSession.lastTouchedAt
          }
        );
      }
    } catch {
      return this.listSessions();
    }

    return this.listSessions();
  }

  private clearBranchActivity(branchKey: string, exceptRoomKey: string): void {
    for (const [roomKey, session] of this.sessions) {
      if (
        roomKey === exceptRoomKey ||
        session.branchKey !== branchKey ||
        !session.active
      ) {
        continue;
      }

      this.sessions.set(roomKey, {
        ...session,
        active: false
      });
    }
  }

  private getSessionsEndpoint(websocketUrl: string): string {
    const parsedUrl = new URL(websocketUrl);
    parsedUrl.protocol = parsedUrl.protocol === "wss:" ? "https:" : "http:";
    parsedUrl.pathname = "/sessions";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString();
  }

  private restore(): void {
    const storedRecords =
      this.context.workspaceState.get<readonly StoredBranchSessionRecord[]>(
        REGISTRY_STORAGE_KEY
      ) ?? [];

    for (const record of storedRecords) {
      this.sessions.set(record.roomKey, record);
    }
  }

  private persist(): void {
    void this.context.workspaceState.update(REGISTRY_STORAGE_KEY, [
      ...this.sessions.values()
    ]);
  }
}
