import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { Duplex } from "stream";
import { SupabaseClient } from "@supabase/supabase-js";
import { RoomManager } from "./roomManager.js";
import {
    SessionRegistry,
    SessionAuthenticator,
    AnonymousSessionAuthenticator,
} from "./sessionRegistry.js";
import { SupabaseAuthenticator } from "./supabaseAuth.js";
import { RoomPermissionService } from "./permissions.js";
import { setupWSConnection } from "./yjs-server.js";

export interface BackendLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface CollaborationWebSocketOptions {
    path?: string;
    roomManager?: RoomManager;
    sessionRegistry?: SessionRegistry;
    authenticator?: SessionAuthenticator;
    logger?: BackendLogger;
    draftRepository?: any;
    supabaseClient?: SupabaseClient;
}

export class CollaborationWebSocketServer {
    private wss: WebSocketServer;
    private heartbeatTimer: NodeJS.Timeout;
    private roomManager: RoomManager;
    private sessionRegistry: SessionRegistry;
    private authenticator: SessionAuthenticator;
    private logger: BackendLogger;

    constructor(options: CollaborationWebSocketOptions = {}) {
        // 1. Set up the logger
        this.logger = options.logger || {
            info: (msg) => console.log(`[INFO] ${msg}`),
            warn: (msg) => console.warn(`[WARN] ${msg}`),
            error: (msg) => console.error(`[ERROR] ${msg}`),
        };

        // 2. Set up Room Manager and Session Registry
        this.roomManager = options.roomManager || new RoomManager();
        this.sessionRegistry = options.sessionRegistry || new SessionRegistry();

        // 3. Set up Authenticator fallback chain
        if (options.authenticator) {
            this.authenticator = options.authenticator;
        } else if (options.supabaseClient) {
            const permissionService = new RoomPermissionService(options.supabaseClient);
            this.authenticator = new SupabaseAuthenticator(permissionService, options.path);
        } else {
            this.authenticator = new AnonymousSessionAuthenticator(options.path);
        }

        // 4. Create the WebSocket server (noServer: true allows us to handle upgrades manually)
        this.wss = new WebSocketServer({
            noServer: true,
            path: options.path,
        });

        // 5. Initialize the heartbeat timer (30s interval)
        this.heartbeatTimer = setInterval(() => {
            this.wss.clients.forEach((ws: any) => {
                if (ws.isAlive === false) {
                    this.logger.warn("Terminating unresponsive WebSocket connection.");
                    return ws.terminate();
                }
                ws.isAlive = false;
                try {
                    ws.ping();
                } catch (e) {
                    this.logger.error(`Failed to send ping: ${(e as Error).message}`);
                    ws.terminate();
                }
            });
        }, 40000);

        this.logger.info(`CollaborationWebSocketServer initialized on path ${options.path || "/"}`);
    }

    /**
     * Upgrades incoming HTTP request to a WebSocket connection after authenticating.
     */
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        try {
            this.logger.info(`Received upgrade request for URL: ${request.url}`);

            // 1. Authenticate the request
            const context = await this.authenticator.authenticate(request);
            const { roomKey, descriptor } = context;

            // 2. Perform the upgrade
            this.wss.handleUpgrade(request, socket, head, (ws: any) => {
                // Register connection details
                this.roomManager.register(roomKey, {
                    roomId: descriptor.roomId,
                    branch: descriptor.branch,
                    sessionId: descriptor.sessionId,
                });
                this.sessionRegistry.register(roomKey, context);

                // Heartbeat state tracking
                ws.isAlive = true;
                ws.on("pong", () => {
                    ws.isAlive = true;
                });

                // Cleanup on connection close
                ws.on("close", () => {
                    this.logger.info(`WebSocket connection closed for room: ${roomKey}`);
                    this.roomManager.unregister(roomKey);

                    // Clean up session registry if there are no more active connections
                    const managed = this.roomManager.get(roomKey);
                    if (!managed || managed.connectionCount <= 0) {
                        this.sessionRegistry.deregister(roomKey);
                    }
                });

                // 3. Delegate message protocol/syncing to setupWSConnection
                setupWSConnection(ws, request, roomKey);

                this.logger.info(`WebSocket connection established and setup for room: ${roomKey}`);
            });
        } catch (error: any) {
            const statusCode = error.statusCode || 401;
            const message = error.message || "Unauthorized";
            this.logger.error(`Upgrade authentication failed: ${message}`);

            socket.write(
                `HTTP/1.1 ${statusCode} ${message}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message}`,
            );
            socket.destroy();
        }
    }

    /**
     * Closes the server and cleans up the heartbeat timer.
     */
    close(): void {
        clearInterval(this.heartbeatTimer);
        this.wss.close(() => {
            this.logger.info("CollaborationWebSocketServer closed.");
        });
    }

    /**
     * Returns the RoomManager instance.
     */
    getRoomManager(): RoomManager {
        return this.roomManager;
    }
}
