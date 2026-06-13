import { SupabaseClient } from "@supabase/supabase-js";
import type { Room } from "@conduit/shared-types";

export class PermissionError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PermissionError";
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  username?: string;
}

export interface RoomAccess {
  room: Room;
  isOwner: boolean;
  role: "member" | "admin" | null;
  status: "active" | "banned" | null;
}

export class RoomPermissionService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Authenticates a user using email and password and returns their profile and token.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ user: AuthenticatedUser; token: string }> {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user || !data.session) {
      throw new PermissionError(401, error?.message || "Invalid email or password");
    }

    const user = this.mapAuthUser(data.user);
    await this.ensureUserProfile(data.user);

    return {
      user,
      token: data.session.access_token,
    };
  }

  /**
   * Validates a Bearer token from the Auth header and returns the authenticated user profile.
   */
  async authenticate(authHeader: string | undefined): Promise<AuthenticatedUser> {
    if (!authHeader) {
      throw new PermissionError(401, "No authorization header provided");
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
      throw new PermissionError(401, "Invalid authorization header format. Use Bearer <token>");
    }

    const token = parts[1];
    const {
      data: { user },
      error,
    } = await this.supabase.auth.getUser(token);

    if (error || !user) {
      throw new PermissionError(401, error?.message || "Invalid or expired authentication token");
    }

    const mappedUser = this.mapAuthUser(user);
    return mappedUser;
  }

  /**
   * Asserts that a user has active access (either as the owner or an active member) to a room.
   */
  async assertActiveRoomAccess(userId: string, roomId: string): Promise<RoomAccess> {
    // Retrieve room details using Supabase (bypassing RLS via service role)
    const { data: room, error: roomError } = await this.supabase
      .from("rooms")
      .select("*")
      .eq("id", roomId)
      .single();

    if (roomError || !room) {
      if (roomError) {
        console.error("[conduit-backend] assertActiveRoomAccess database error:", JSON.stringify(roomError));
      } else {
        console.warn("[conduit-backend] assertActiveRoomAccess: room not found for ID:", roomId);
      }
      throw new PermissionError(404, "Room not found");
    }

    const isOwner = room.owner_id === userId;

    // Retrieve membership details (bypassing RLS via service role)
    const { data: member, error: memberError } = await this.supabase
      .from("room_members")
      .select("*")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();

    if (memberError) {
      console.error("[conduit-backend] assertActiveRoomAccess membership query error:", JSON.stringify(memberError));
    }

    let role = member ? (member.role as "member" | "admin") : null;
    let status = member ? (member.status as "active" | "banned") : null;

    if (!isOwner && (!member || status !== "active")) {
      if (status === "banned") {
        throw new PermissionError(403, "You do not have active access to this room (banned)");
      }

      // Auto-join the user to the room since they possess the Room ID
      console.log(`[conduit-backend] Auto-joining user ${userId} to room ${roomId}`);
      const { error: joinError } = await this.supabase
        .from("room_members")
        .upsert(
          {
            room_id: roomId,
            user_id: userId,
            role: "member",
            status: "active",
          },
          { onConflict: "room_id,user_id" }
        );

      if (joinError) {
        console.error("[conduit-backend] Failed to auto-join user to room:", joinError);
        throw new PermissionError(403, "You do not have active access to this room");
      }

      role = "member";
      status = "active";
    }

    const mappedRoom: Room = {
      id: room.id,
      name: room.repository_name,
      repoUrl: room.repository_remote_url || "",
      defaultBranch: room.default_branch || "main",
      ownerId: room.owner_id,
    };

    return {
      room: mappedRoom,
      isOwner,
      role,
      status,
    };
  }

  /**
   * Asserts that a user holds at least the minimum required role in a room.
   * Owner gets implicit admin role.
   */
  async assertRoomRole(userId: string, roomId: string, minRole: "member" | "admin"): Promise<void> {
    const access = await this.assertActiveRoomAccess(userId, roomId);

    if (access.isOwner) {
      // Owner satisfies all roles
      return;
    }

    if (minRole === "admin" && access.role !== "admin") {
      throw new PermissionError(403, "Admin privileges are required for this action");
    }
  }

  /**
   * Ensures the user profile is stored in the public.users database.
   */
  async ensureUserProfile(user: any): Promise<void> {
    const name = user.user_metadata?.name || user.user_metadata?.full_name || "";
    const { error } = await this.supabase.from("users").upsert(
      {
        id: user.id,
        email: user.email || "",
        name: name,
      },
      { onConflict: "id" },
    );

    if (error) {
      throw new PermissionError(500, `Failed to ensure user profile: ${error.message}`);
    }
  }

  /**
   * Maps a Supabase Auth user object to our internal AuthenticatedUser interface.
   */
  mapAuthUser(user: any): AuthenticatedUser {
    return {
      id: user.id,
      email: user.email || "",
      username:
        user.user_metadata?.username ||
        user.user_metadata?.name ||
        user.user_metadata?.full_name ||
        undefined,
    };
  }
}
