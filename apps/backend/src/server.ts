import express from "express";
import type { Express, Request, Response } from "express";
import http from "http";
import * as Y from "yjs";
import { docs } from "./yjs-server.js";
import { initializeSupabase, getSupabaseClient } from "./supabaseClient.js";
import { DraftRepository } from "./draftRepository.js";
import { ChatRepository } from "./chatRepository.js";
import { RoomPermissionService } from "./permissions.js";
import { SupabaseAuthenticator } from "./supabaseAuth.js";
import { CollaborationWebSocketServer } from "./websocket.js";
import { RoomManager } from "./roomManager.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { runMigrations } from "./migration.js";
import { createAuthRouter, sendError } from "./authRoutes.js";
import { createRoomRouter } from "./roomRoutes.js";
import { createDraftRouter } from "./draftRoutes.js";
import { createChatRouter } from "./chatRoutes.js";

export interface BackendServerConfig {
  host?: string;
  port?: number;
  websocketPath?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
}

export interface BackendServer {
  app: Express;
  httpServer: http.Server;
  draftRepository: DraftRepository;
  chatRepository: ChatRepository;
  websocketServer: CollaborationWebSocketServer;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createBackendServer(config?: BackendServerConfig): BackendServer {
  // Create Express app, disable x-powered-by, JSON body parser 50MB
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "50mb" }));

  // Initialize Supabase client
  const supabaseUrl = config?.supabaseUrl || process.env.SUPABASE_URL || "";
  const supabaseKey =
    config?.supabaseKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    "";

  const supabaseClient = initializeSupabase({
    url: supabaseUrl,
    serviceRoleKey: supabaseKey,
  });

  const draftRepository = new DraftRepository(supabaseClient);
  const chatRepository = new ChatRepository(supabaseClient);
  const roomPermissionService = new RoomPermissionService(supabaseClient);
  const supabaseAuthenticator = new SupabaseAuthenticator(
    roomPermissionService,
    config?.websocketPath,
  );
  const roomManager = new RoomManager();
  const sessionRegistry = new SessionRegistry();

  const websocketServer = new CollaborationWebSocketServer({
    path: config?.websocketPath,
    roomManager,
    sessionRegistry,
    authenticator: supabaseAuthenticator,
    supabaseClient,
    draftRepository,
  });

  // Mount routes
  app.use("/", createAuthRouter(roomPermissionService));
  app.use("/", createRoomRouter(roomPermissionService));
  app.use("/", createDraftRouter(draftRepository, supabaseAuthenticator, roomPermissionService));
  app.use("/", createChatRouter(chatRepository, roomPermissionService));

  // GET /health → { ok, draftPersistence, chatPersistence }
  app.get("/health", (req: Request, res: Response) => {
    const draftPersistence = draftRepository.isConfigured();
    const chatPersistence = chatRepository.isConfigured();
    res.json({
      ok: draftPersistence && chatPersistence,
      draftPersistence,
      chatPersistence,
    });
  });

  // GET /sessions → list active sessions joining DB sessions + in-memory rooms
  app.get("/sessions", async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      // Query DB sessions
      const { data: dbSessions, error } = await supabase
        .from("sessions")
        .select("*")
        .eq("status", "active");

      if (error) throw error;

      // In-memory rooms
      const inMemoryRooms = roomManager.list();

      // Join DB sessions + in-memory rooms
      const activeSessions = (dbSessions || []).map((dbSession) => {
        const inMemory = inMemoryRooms.find((r) => r.session.sessionId === dbSession.id);
        return {
          ...dbSession,
          connectionCount: inMemory ? inMemory.connectionCount : 0,
          lastTouchedAt: inMemory ? inMemory.lastTouchedAt : dbSession.last_active_at,
          isActiveInMemory: !!inMemory,
        };
      });

      res.json(activeSessions);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /test/drafts → unauthenticated test endpoint
  app.post("/test/drafts", async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      const userId = req.body.userId || "00000000-0000-0000-0000-000000000000";
      const roomId = req.body.roomId || "11111111-1111-1111-1111-111111111111";
      const sessionId = req.body.sessionId || "22222222-2222-2222-2222-222222222222";
      const branch = req.body.branch || "main";
      const baseCommitHash = req.body.baseCommitHash || "HEAD";
      const yjsState = req.body.yjsState || "";
      const filesystemOps = req.body.filesystemOps || [];
      const aiEvents = req.body.aiEvents || [];
      const lineage = req.body.lineage || null;

      // Ensure user exists
      const { error: userError } = await supabase.from("users").upsert(
        {
          id: userId,
          email: "test@codesync.local",
          name: "Test User",
        },
        { onConflict: "id" },
      );

      if (userError) throw userError;

      // Ensure room exists
      const { error: roomError } = await supabase.from("rooms").upsert(
        {
          id: roomId,
          repository_name: "test-repo",
          owner_id: userId,
          default_branch: "main",
        },
        { onConflict: "id" },
      );

      if (roomError) throw roomError;

      // Ensure session exists
      const { error: sessionError } = await supabase.from("sessions").upsert(
        {
          id: sessionId,
          room_id: roomId,
          branch: branch,
          base_commit_sha: baseCommitHash,
          status: "active",
          created_by: userId,
        },
        { onConflict: "id" },
      );

      if (sessionError) throw sessionError;

      // Create draft
      const draft = await draftRepository.createDraft({
        sessionId,
        roomId,
        branch,
        baseCommitHash,
        yjsState,
        filesystemOps,
        aiEvents,
        createdBy: userId,
        ownerId: userId,
        lineage,
      });

      res.status(201).json({ draft });
    } catch (err) {
      sendError(res, err);
    }
  });

  const httpServer = http.createServer(app);

  // Upgrade HTTP to WS
  httpServer.on("upgrade", (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head);
  });

  let autoSaveTimer: NodeJS.Timeout | undefined;
  let gcTimer: NodeJS.Timeout | undefined;

  const start = async (): Promise<void> => {
    // runMigrations
    await runMigrations(supabaseClient);

    // draftRepository.initialize
    await draftRepository.initialize();

    // Initialize chatRepository
    await chatRepository.initialize();

    // Start auto-save timer (every 5 min, saves all active Yjs docs as drafts)
    autoSaveTimer = setInterval(
      async () => {
        try {
          for (const [roomKey, doc] of docs.entries()) {
            const context = sessionRegistry.get(roomKey);
            if (!context) continue;

            const { descriptor, auth } = context;
            const yjsState = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");

            const existingDrafts = await draftRepository.listDrafts({
              sessionId: descriptor.sessionId,
              status: "active",
            });

            if (existingDrafts.length > 0) {
              await draftRepository.updateDraft(existingDrafts[0].id, {
                yjsState,
              });
            } else {
              let baseCommitHash = "HEAD";
              let ownerId = auth.user?.id || "anonymous";
              try {
                if (supabaseClient) {
                  const { data: sessionData } = await supabaseClient
                    .from("sessions")
                    .select("base_commit_sha, created_by")
                    .eq("id", descriptor.sessionId)
                    .maybeSingle();
                  if (sessionData) {
                    baseCommitHash = sessionData.base_commit_sha || "HEAD";
                    ownerId = sessionData.created_by || ownerId;
                  }
                }
              } catch {
                // Ignore and use defaults
              }

              await draftRepository.createDraft({
                sessionId: descriptor.sessionId,
                roomId: descriptor.roomId,
                branch: descriptor.branch,
                baseCommitHash,
                yjsState,
                createdBy: auth.user?.id || "anonymous",
                ownerId: ownerId,
                filesystemOps: [],
                aiEvents: [],
              });
            }
          }
        } catch (err) {
          console.error("Auto-save timer error:", err);
        }
      },
      5 * 60 * 1000,
    );

    // Start GC timer (every 24 hours, cleanupExpiredDrafts(30))
    gcTimer = setInterval(
      () => {
        draftRepository.cleanupExpiredDrafts(30).catch((err) => {
          console.error("GC timer cleanup error:", err);
        });
      },
      24 * 60 * 60 * 1000,
    );

    // httpServer.listen
    const port = config?.port || Number(process.env.PORT) || 3000;
    const host = config?.host || process.env.HOST || "0.0.0.0";

    await new Promise<void>((resolve, reject) => {
      httpServer
        .listen(port, host, () => {
          console.log(`[INFO] Server listening on http://${host}:${port}`);
          resolve();
        })
        .on("error", (err) => {
          reject(err);
        });
    });
  };

  const stop = async (): Promise<void> => {
    // clear timers
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer);
      autoSaveTimer = undefined;
    }
    if (gcTimer) {
      clearInterval(gcTimer);
      gcTimer = undefined;
    }

    // websocketServer.close()
    websocketServer.close();

    // draftRepository.close()
    await draftRepository.close();

    // httpServer.close()
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        console.log("[INFO] HTTP server closed.");
        resolve();
      });
    });
  };

  return {
    app,
    httpServer,
    draftRepository,
    chatRepository,
    websocketServer,
    start,
    stop,
  };
}
