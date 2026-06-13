import { IncomingMessage } from "http";

export interface SessionDescriptor {
  roomId: string;
  branch: string;
  sessionId: string;
  userId?: string;
}

export interface AuthContext {
  user: {
    id: string;
    email: string;
    username?: string;
  } | null;
}

export interface SessionRequestContext {
  roomKey: string;
  descriptor: SessionDescriptor;
  auth: AuthContext;
}

export interface SessionAuthenticator {
  authenticate(request: IncomingMessage): Promise<SessionRequestContext>;
}

/**
 * Extracts a room key from a request URL, stripping query parameters and any configured path prefix.
 */
export function extractRoomKey(urlStr: string, pathPrefix?: string): string {
  const url = new URL(urlStr, "http://localhost");
  let pathname = url.pathname;

  // Strip leading "/ws" or "/ws/" if present
  if (pathname.startsWith("/ws/")) {
    pathname = pathname.substring(4);
  } else if (pathname.startsWith("/ws")) {
    pathname = pathname.substring(3);
  }

  if (pathPrefix) {
    const prefix = pathPrefix.startsWith("/") ? pathPrefix : "/" + pathPrefix;
    if (pathname.startsWith(prefix)) {
      pathname = pathname.substring(prefix.length);
    }
  }

  // Remove leading and trailing slashes
  pathname = pathname.replace(/^\/+|\/+$/g, "");
  return pathname;
}

export class AnonymousSessionAuthenticator implements SessionAuthenticator {
  constructor(private pathPrefix?: string) {}

  async authenticate(request: IncomingMessage): Promise<SessionRequestContext> {
    if (!request.url) {
      throw new Error("Request URL is missing");
    }

    const roomKey = extractRoomKey(request.url, this.pathPrefix);

    // Parse roomKey: "roomId:branch:sessionId"
    let descriptor: SessionDescriptor;
    try {
      const parts = roomKey.split(":");
      if (parts.length < 3) {
        throw new Error("Invalid room key structure");
      }
      const roomId = parts[0];
      const sessionId = parts[parts.length - 1];
      const branch = parts.slice(1, parts.length - 1).join(":");

      descriptor = { roomId, branch, sessionId };
    } catch (err) {
      // Fallback values if key cannot be parsed
      descriptor = {
        roomId: "00000000-0000-0000-0000-000000000000",
        branch: "main",
        sessionId: "00000000-0000-0000-0000-000000000000",
      };
    }

    return {
      roomKey,
      descriptor,
      auth: {
        user: {
          id: "anonymous",
          email: "anonymous@conduit.local",
          username: "Anonymous",
        },
      },
    };
  }
}

export class SessionRegistry {
  private activeSessions = new Map<string, SessionRequestContext>();

  register(roomKey: string, context: SessionRequestContext): void {
    this.activeSessions.set(roomKey, context);
  }

  deregister(roomKey: string): void {
    this.activeSessions.delete(roomKey);
  }

  get(roomKey: string): SessionRequestContext | undefined {
    return this.activeSessions.get(roomKey);
  }

  list(): SessionRequestContext[] {
    return Array.from(this.activeSessions.values());
  }
}
