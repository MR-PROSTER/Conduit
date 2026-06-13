import { IncomingMessage } from 'http';
import { SessionAuthenticator, SessionRequestContext, SessionDescriptor, extractRoomKey } from './sessionRegistry.js';
import { RoomPermissionService, PermissionError } from './permissions.js';

export class SupabaseAuthenticator implements SessionAuthenticator {
  constructor(
    private permissionService: RoomPermissionService,
    private pathPrefix?: string
  ) {}

  /**
   * Authenticates the connection by validating the JWT token and checking room access rights.
   */
  async authenticate(request: IncomingMessage): Promise<SessionRequestContext> {
    if (!request.url) {
      throw new Error('Request URL is missing');
    }

    const roomKey = extractRoomKey(request.url, this.pathPrefix);

    // Parse roomKey: "roomId:branch:sessionId"
    const parts = roomKey.split(':');
    if (parts.length < 3) {
      throw new PermissionError(400, `Invalid room key format: ${roomKey}`);
    }
    const roomId = parts[0];
    const sessionId = parts[parts.length - 1];
    const branch = parts.slice(1, parts.length - 1).join(':');

    // Extract authorization header/token
    let authHeader = request.headers['authorization'] as string | undefined;

    if (!authHeader) {
      // Check query parameters for token or access_token
      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token') || url.searchParams.get('access_token');
      if (token) {
        authHeader = `Bearer ${token}`;
      }
    }

    if (!authHeader) {
      // Check Sec-WebSocket-Protocol header (common fallback for browser WS client API)
      const protocol = request.headers['sec-websocket-protocol'] as string | undefined;
      if (protocol) {
        const subprotocols = protocol.split(',').map(s => s.trim());
        const bearerIndex = subprotocols.findIndex(p => p.toLowerCase() === 'bearer');
        if (bearerIndex !== -1 && bearerIndex + 1 < subprotocols.length) {
          authHeader = `Bearer ${subprotocols[bearerIndex + 1]}`;
        } else if (subprotocols.length > 0) {
          const potentialToken = subprotocols[0];
          // Simple length heuristic to differentiate a token from a simple subprotocol name
          if (potentialToken && potentialToken.length > 20) {
            authHeader = `Bearer ${potentialToken}`;
          }
        }
      }
    }

    if (!authHeader) {
      throw new PermissionError(401, 'No authorization token found in headers, query, or subprotocols');
    }

    // Authenticate the user against Supabase Auth
    const user = await this.permissionService.authenticate(authHeader);

    // Assert that the user has active access to the specified room
    await this.permissionService.assertActiveRoomAccess(user.id, roomId);

    const descriptor: SessionDescriptor = {
      roomId,
      branch,
      sessionId,
      userId: user.id
    };

    return {
      roomKey,
      descriptor,
      auth: {
        user
      }
    };
  }
}
