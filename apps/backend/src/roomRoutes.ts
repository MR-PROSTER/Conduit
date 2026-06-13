import { Router, Request, Response, NextFunction } from "express";
import type { Room, Session } from "@conduit/shared-types";
import { RoomPermissionService } from "./permissions.js";
import { getSupabaseClient } from "./supabaseClient.js";
import { sendError, requireNonEmptyString } from "./authRoutes.js";

export function createRoomRouter(permissions: RoomPermissionService): Router {
  const router = Router();

  // Authentication Middleware
  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      const user = await permissions.authenticate(authHeader);
      (req as any).user = user;
      next();
    } catch (error) {
      sendError(res, error);
    }
  };

  // Apply auth middleware to all room routes
  router.use(requireAuth);

  // POST /rooms { id, repositoryName/name, repositoryOwner, repositoryRemoteUrl/repoUrl, defaultBranch } → { room }
  router.post("/rooms", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      console.log("[conduit-backend] POST /rooms received body:", JSON.stringify(req.body));
      const { id, repositoryName, name, repositoryOwner, repositoryRemoteUrl, repoUrl, defaultBranch } = req.body;

      const repoName = repositoryName || name;
      const repoRemoteUrl = repositoryRemoteUrl || repoUrl;

      const cleanedName = requireNonEmptyString(repoName, "repositoryName or name");
      const repoOwnerVal = repositoryOwner
        ? requireNonEmptyString(repositoryOwner, "repositoryOwner")
        : null;
      const repoRemoteUrlVal = repoRemoteUrl
        ? requireNonEmptyString(repoRemoteUrl, "repositoryRemoteUrl or repoUrl")
        : null;
      const defBranch = defaultBranch
        ? requireNonEmptyString(defaultBranch, "defaultBranch")
        : "main";

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      let roomData;
      if (id) {
        // Check if room already exists
        const { data: existingRoom } = await supabase
          .from("rooms")
          .select("*")
          .eq("id", id)
          .maybeSingle();

        if (existingRoom) {
          console.log("[conduit-backend] Room already exists in DB, verifying access for user:", user.id);
          // Verify user has active access to this existing room
          await permissions.assertActiveRoomAccess(user.id, id);
          roomData = existingRoom;
        }
      }

      if (!roomData) {
        console.log("[conduit-backend] Room does not exist, inserting room ID:", id || "auto-generated");
        // Room does not exist, let's insert it
        const { data: newRoom, error: insertError } = await supabase
          .from("rooms")
          .insert({
            id: id || undefined,
            repository_name: cleanedName,
            repository_owner: repoOwnerVal,
            repository_remote_url: repoRemoteUrlVal,
            default_branch: defBranch,
            owner_id: user.id,
          })
          .select()
          .single();

        if (insertError) {
          console.error("[conduit-backend] Error inserting room to DB:", insertError);
          throw insertError;
        }
        roomData = newRoom;
        console.log("[conduit-backend] Successfully inserted room to DB:", JSON.stringify(roomData));
      }

      const room: Room = {
        id: roomData.id,
        name: roomData.repository_name,
        repoUrl: roomData.repository_remote_url || "",
        defaultBranch: roomData.default_branch || "main",
        ownerId: roomData.owner_id,
      };

      res.status(201).json({ room });
    } catch (error) {
      console.error("[conduit-backend] POST /rooms handler caught error:", error);
      sendError(res, error);
    }
  });

  // POST /sessions { id, roomId, branch, baseCommitHash, status } → { session }
  router.post("/sessions", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      console.log("[conduit-backend] POST /sessions received body:", JSON.stringify(req.body));
      const { id, roomId, branch, baseCommitHash, status } = req.body;

      const sessId = requireNonEmptyString(id, "id");
      const rId = requireNonEmptyString(roomId, "roomId");
      const br = requireNonEmptyString(branch, "branch");
      const baseHash = baseCommitHash || "HEAD";
      const sessStatus = status || "active";

      // Verify user has active access to this room
      await permissions.assertActiveRoomAccess(user.id, rId);

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      let dbStatus: "active" | "ended" | "discarded" = "active";
      if (sessStatus === "discarded") {
        dbStatus = "discarded";
      } else if (sessStatus === "saved") {
        dbStatus = "ended";
      }

      console.log("[conduit-backend] Upserting session ID:", sessId);
      const { data: sessionData, error } = await supabase
        .from("sessions")
        .upsert(
          {
            id: sessId,
            room_id: rId,
            branch: br,
            base_commit_sha: baseHash,
            status: dbStatus,
            created_by: user.id,
            last_active_at: new Date().toISOString(),
          },
          { onConflict: "id" }
        )
        .select()
        .single();

      if (error) {
        console.error("[conduit-backend] Error upserting session to DB:", error);
        throw error;
      }

      console.log("[conduit-backend] Successfully upserted session to DB:", JSON.stringify(sessionData));

      let mappedStatus: "active" | "saved" | "discarded" = "active";
      if (sessionData.status === "discarded") {
        mappedStatus = "discarded";
      } else if (sessionData.status === "ended") {
        mappedStatus = "saved";
      }

      const session: Session = {
        id: sessionData.id,
        roomId: sessionData.room_id,
        branch: sessionData.branch,
        baseCommitHash: sessionData.base_commit_sha,
        participants: [user.id],
        status: mappedStatus,
      };

      res.status(201).json({ session });
    } catch (error) {
      console.error("[conduit-backend] POST /sessions handler caught error:", error);
      sendError(res, error);
    }
  });


  // GET /rooms → { rooms: [] }
  router.get("/rooms", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      // Fetch room_ids where user is active member
      const { data: memberRooms, error: memberError } = await supabase
        .from("room_members")
        .select("room_id")
        .eq("user_id", user.id)
        .eq("status", "active");

      if (memberError) throw memberError;

      const roomIds = (memberRooms || []).map((m: any) => m.room_id);

      // Query rooms owned by user or where they are a member
      let query = supabase.from("rooms").select("*");

      if (roomIds.length > 0) {
        query = query.or(`owner_id.eq.${user.id},id.in.(${roomIds.join(",")})`);
      } else {
        query = query.eq("owner_id", user.id);
      }

      const { data: roomsData, error: roomsError } = await query;
      if (roomsError) throw roomsError;

      const rooms: Room[] = (roomsData || []).map((roomData: any) => ({
        id: roomData.id,
        name: roomData.repository_name,
        repoUrl: roomData.repository_remote_url || "",
        defaultBranch: roomData.default_branch || "main",
        ownerId: roomData.owner_id,
      }));

      res.json({ rooms });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /rooms/:id → { room }
  router.get("/rooms/:id", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;

      // assertActiveRoomAccess will validate and map the room correctly
      const access = await permissions.assertActiveRoomAccess(user.id, roomId);
      res.json({ room: access.room });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /rooms/:id/join → { room }
  router.post("/rooms/:id/join", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      // Check if the room exists
      const { data: roomData, error: roomError } = await supabase
        .from("rooms")
        .select("*")
        .eq("id", roomId)
        .maybeSingle();

      if (roomError || !roomData) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Add user as active member of the room
      const { error: memberError } = await supabase
        .from("room_members")
        .upsert(
          {
            room_id: roomId,
            user_id: user.id,
            role: "member",
            status: "active",
          },
          { onConflict: "room_id,user_id" }
        );

      if (memberError) throw memberError;

      const room: Room = {
        id: roomData.id,
        name: roomData.repository_name,
        repoUrl: roomData.repository_remote_url || "",
        defaultBranch: roomData.default_branch || "main",
        ownerId: roomData.owner_id,
      };

      res.status(200).json({ room });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /rooms/:id/invite { email } → { invitation }
  router.post("/rooms/:id/invite", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;
      const { email } = req.body;

      const cleanEmail = requireNonEmptyString(email, "email");

      // Assert user is at least an admin/owner to send invitations
      await permissions.assertRoomRole(user.id, roomId, "admin");

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      const { data: inviteData, error } = await supabase
        .from("invitations")
        .upsert(
          {
            room_id: roomId,
            email: cleanEmail,
            status: "pending",
            inviter_id: user.id,
          },
          { onConflict: "room_id,email" },
        )
        .select()
        .single();

      if (error) throw error;

      res.status(201).json({ invitation: inviteData });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /rooms/:id/members/:userId/role { role } → { member }
  router.post("/rooms/:id/members/:userId/role", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;
      const targetUserId = req.params.userId as string;
      const { role } = req.body;

      if (role !== "member" && role !== "admin") {
        return res.status(400).json({ error: "Role must be 'member' or 'admin'" });
      }

      // Assert current user is owner of the room
      const access = await permissions.assertActiveRoomAccess(user.id, roomId);
      if (!access.isOwner) {
        return res.status(403).json({ error: "Only the room owner can modify member roles" });
      }

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      const { data: memberData, error } = await supabase
        .from("room_members")
        .update({ role })
        .eq("room_id", roomId)
        .eq("user_id", targetUserId)
        .select()
        .single();

      if (error) throw error;

      res.json({ member: memberData });
    } catch (error) {
      sendError(res, error);
    }
  });

  // DELETE /rooms/:id/members/:userId → { ok: true }
  router.delete("/rooms/:id/members/:userId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;
      const targetUserId = req.params.userId as string;

      // Assert user is owner of the room OR the member themselves leaving the room
      const access = await permissions.assertActiveRoomAccess(user.id, roomId);
      if (!access.isOwner && user.id !== targetUserId) {
        return res
          .status(403)
          .json({ error: "Only the room owner or the member themselves can remove membership" });
      }

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      const { error } = await supabase
        .from("room_members")
        .delete()
        .eq("room_id", roomId)
        .eq("user_id", targetUserId);

      if (error) throw error;

      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
