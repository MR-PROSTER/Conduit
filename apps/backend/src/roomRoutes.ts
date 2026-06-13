import { Router, Request, Response, NextFunction } from 'express';
import type { Room } from '@codesync/shared-types';
import { RoomPermissionService } from './permissions.js';
import { getSupabaseClient } from './supabaseClient.js';
import { sendError, requireNonEmptyString } from './authRoutes.js';

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

  // POST /rooms { repositoryName, repositoryOwner, repositoryRemoteUrl, defaultBranch } → { room }
  router.post('/rooms', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { repositoryName, repositoryOwner, repositoryRemoteUrl, defaultBranch } = req.body;

      const repoName = requireNonEmptyString(repositoryName, 'repositoryName');
      const repoOwner = repositoryOwner ? requireNonEmptyString(repositoryOwner, 'repositoryOwner') : null;
      const repoRemoteUrl = repositoryRemoteUrl ? requireNonEmptyString(repositoryRemoteUrl, 'repositoryRemoteUrl') : null;
      const defBranch = defaultBranch ? requireNonEmptyString(defaultBranch, 'defaultBranch') : 'main';

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      const { data: roomData, error } = await supabase
        .from('rooms')
        .insert({
          repository_name: repoName,
          repository_owner: repoOwner,
          repository_remote_url: repoRemoteUrl,
          default_branch: defBranch,
          owner_id: user.id
        })
        .select()
        .single();

      if (error) throw error;

      const room: Room = {
        id: roomData.id,
        name: roomData.repository_name,
        repoUrl: roomData.repository_remote_url || '',
        defaultBranch: roomData.default_branch || 'main',
        ownerId: roomData.owner_id
      };

      res.status(201).json({ room });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /rooms → { rooms: [] }
  router.get('/rooms', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      // Fetch room_ids where user is active member
      const { data: memberRooms, error: memberError } = await supabase
        .from('room_members')
        .select('room_id')
        .eq('user_id', user.id)
        .eq('status', 'active');

      if (memberError) throw memberError;

      const roomIds = (memberRooms || []).map((m: any) => m.room_id);

      // Query rooms owned by user or where they are a member
      let query = supabase.from('rooms').select('*');
      if (roomIds.length > 0) {
        query = query.or(`owner_id.eq.${user.id},id.in.(${roomIds.join(',')})`);
      } else {
        query = query.eq('owner_id', user.id);
      }

      const { data: roomsData, error: roomsError } = await query;
      if (roomsError) throw roomsError;

      const rooms: Room[] = (roomsData || []).map((roomData: any) => ({
        id: roomData.id,
        name: roomData.repository_name,
        repoUrl: roomData.repository_remote_url || '',
        defaultBranch: roomData.default_branch || 'main',
        ownerId: roomData.owner_id
      }));

      res.json({ rooms });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /rooms/:id → { room }
  router.get('/rooms/:id', async (req: Request, res: Response) => {
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

  // POST /rooms/:id/invite { email } → { invitation }
  router.post('/rooms/:id/invite', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;
      const { email } = req.body;

      const cleanEmail = requireNonEmptyString(email, 'email');

      // Assert user is at least an admin/owner to send invitations
      await permissions.assertRoomRole(user.id, roomId, 'admin');

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      const { data: inviteData, error } = await supabase
        .from('invitations')
        .upsert(
          {
            room_id: roomId,
            email: cleanEmail,
            status: 'pending',
            inviter_id: user.id
          },
          { onConflict: 'room_id,email' }
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
  router.post('/rooms/:id/members/:userId/role', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;
      const targetUserId = req.params.userId as string;
      const { role } = req.body;

      if (role !== 'member' && role !== 'admin') {
        return res.status(400).json({ error: "Role must be 'member' or 'admin'" });
      }

      // Assert current user is owner of the room
      const access = await permissions.assertActiveRoomAccess(user.id, roomId);
      if (!access.isOwner) {
        return res.status(403).json({ error: 'Only the room owner can modify member roles' });
      }

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      const { data: memberData, error } = await supabase
        .from('room_members')
        .update({ role })
        .eq('room_id', roomId)
        .eq('user_id', targetUserId)
        .select()
        .single();

      if (error) throw error;

      res.json({ member: memberData });
    } catch (error) {
      sendError(res, error);
    }
  });

  // DELETE /rooms/:id/members/:userId → { ok: true }
  router.delete('/rooms/:id/members/:userId', async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const roomId = req.params.id as string;
      const targetUserId = req.params.userId as string;

      // Assert user is owner of the room OR the member themselves leaving the room
      const access = await permissions.assertActiveRoomAccess(user.id, roomId);
      if (!access.isOwner && user.id !== targetUserId) {
        return res.status(403).json({ error: 'Only the room owner or the member themselves can remove membership' });
      }

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      const { error } = await supabase
        .from('room_members')
        .delete()
        .eq('room_id', roomId)
        .eq('user_id', targetUserId);

      if (error) throw error;

      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
